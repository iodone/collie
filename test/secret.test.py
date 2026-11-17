"""collie-secret: one vault under a temporary HOME, a fake hc for the agent's terminal."""

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parent.parent
CLI = REPO / "bin/collie-secret"
SOURCE = CLI.read_text()


class SecretTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="collie-secret-test-")
        self.base = Path(self.temporary.name)
        self.home = self.base / "home"
        self.fake_bin = self.base / "fake-bin"
        self.fake_bin.mkdir()
        self.log = self.base / "hc.log"
        self.log.write_text("")
        hc = self.fake_bin / "hc"
        hc.write_text(
            "#!/bin/sh\n"
            'echo "$*" >> "$FAKE_HC_LOG"\n'
            'case "$1" in\n'
            '  get) printf \'{"state":"live","pid":%s,"labels":{}}\\n\' "$FAKE_HC_PID" ;;\n'
            "  *) exit 0 ;;\n"
            "esac\n"
        )
        hc.chmod(0o755)

    def tearDown(self):
        self.temporary.cleanup()

    def run_cli(self, *args, expected=0, input_text=None, env=None, terminal="t1"):
        environment = os.environ.copy()
        environment.update({
            "HOME": str(self.home),
            "PATH": f"{self.fake_bin}:/usr/bin:/bin",
            "FAKE_HC_LOG": str(self.log),
            "FAKE_HC_PID": str(os.getpid()),
        })
        environment.pop("COLLIE_SECRETS_HOME", None)
        if terminal is not None:
            environment["HC_TERMINAL_ID"] = terminal
        else:
            environment.pop("HC_TERMINAL_ID", None)
        environment.update(env or {})
        result = subprocess.run(
            [sys.executable, str(CLI), *map(str, args)],
            text=True,
            input=input_text,
            capture_output=True,
            env=environment,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, expected, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        return result

    @property
    def vault(self):
        return self.home / ".local/share/collie/secrets/vault.json"

    def labels(self):
        return [line for line in self.log.read_text().splitlines() if line.startswith("label ")]

    def keep(self, name, value, why=""):
        return self.run_cli("set", name, *(["--why", why] if why else []), input_text=value + "\n")

    def test_set_creates_owner_only_vault_in_collie_store(self):
        self.keep("GITHUB_TOKEN", "ghp_example_value", "for pushes")
        data = json.loads(self.vault.read_text())
        self.assertEqual(data["version"], 1)
        entry = data["secrets"]["GITHUB_TOKEN"]
        self.assertEqual(entry["value"], "ghp_example_value")
        self.assertEqual(entry["why"], "for pushes")
        self.assertIsInstance(entry["at"], int)
        folder = self.vault.parent
        self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.vault.stat().st_mode), 0o600)
        # the store Collie's chat writes, never shepherdr's
        self.assertFalse((self.home / ".herdr").exists())

    def test_set_replaces_value_and_keeps_other_names(self):
        self.keep("A_TOKEN", "first-value")
        self.keep("B_TOKEN", "second-value")
        self.keep("A_TOKEN", "third-value")
        data = json.loads(self.vault.read_text())
        self.assertEqual(sorted(data["secrets"]), ["A_TOKEN", "B_TOKEN"])
        self.assertEqual(data["secrets"]["A_TOKEN"]["value"], "third-value")

    def test_list_shows_names_only(self):
        self.keep("OPENAI_API_KEY", "sk-secret-value")
        result = self.run_cli("list")
        self.assertIn("OPENAI_API_KEY", result.stdout)
        self.assertNotIn("sk-secret-value", result.stdout + result.stderr)
        self.assertEqual(result.stdout.strip(), "OPENAI_API_KEY")

    def test_list_without_vault_hints_how_to_ask(self):
        result = self.run_cli("list")
        self.assertIn("collie-secret ask NAME", result.stdout)
        self.assertFalse(self.vault.exists())

    def test_run_injects_values_and_masks_output(self):
        self.keep("MY_TOKEN", "opensesame-123")
        result = self.run_cli("run", "MY_TOKEN", "--", "sh", "-c", 'printf %s "$MY_TOKEN"')
        self.assertEqual(result.stdout, "[MY_TOKEN hidden]")
        self.assertNotIn("opensesame-123", result.stdout + result.stderr)

    def test_run_masks_stderr_and_exit_code(self):
        self.keep("MY_TOKEN", "opensesame-123")
        result = self.run_cli(
            "run", "MY_TOKEN", "--", "sh", "-c",
            'echo "leak $MY_TOKEN" >&2; exit 3', expected=3,
        )
        self.assertIn("[MY_TOKEN hidden]", result.stderr)
        self.assertNotIn("opensesame-123", result.stderr)

    def test_run_takes_several_names(self):
        self.keep("A_TOKEN", "value-a-1234")
        self.keep("B_TOKEN", "value-b-1234")
        result = self.run_cli("run", "A_TOKEN,B_TOKEN", "--", "sh", "-c", 'echo "$A_TOKEN/$B_TOKEN"')
        self.assertEqual(result.stdout.strip(), "[A_TOKEN hidden]/[B_TOKEN hidden]")

    def test_run_missing_name_asks_for_it(self):
        result = self.run_cli("run", "MISSING_TOKEN", "--", "true", expected=1)
        self.assertIn("collie-secret ask MISSING_TOKEN", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_run_without_command_is_refused(self):
        result = self.run_cli("run", "MY_TOKEN", expected=1)
        self.assertIn("Say what to run", result.stderr)

    def test_ask_sets_the_chat_label_with_its_why(self):
        result = self.run_cli("ask", "NEW_TOKEN", "--why", "for the deploy")
        self.assertIn("End your turn", result.stdout)
        self.assertEqual(self.labels(), ["label t1 collie.secret.ask.NEW_TOKEN=for the deploy"])

    def test_ask_without_why_leaves_a_dash(self):
        self.run_cli("ask", "NEW_TOKEN")
        self.assertEqual(self.labels(), ["label t1 collie.secret.ask.NEW_TOKEN=-"])

    def test_ask_says_already_kept_unless_forced(self):
        self.keep("MY_TOKEN", "opensesame-123")
        result = self.run_cli("ask", "MY_TOKEN", "--why", "again")
        self.assertIn("already kept", result.stdout)
        self.assertEqual(self.labels(), [])
        self.run_cli("ask", "MY_TOKEN", "--why", "wrong one", "--force")
        self.assertEqual(self.labels(), ["label t1 collie.secret.ask.MY_TOKEN=wrong one"])

    def test_ask_rejects_a_name_that_is_not_an_env_var(self):
        result = self.run_cli("ask", "not/a/name", expected=1)
        self.assertIn("like an environment variable", result.stderr)
        self.assertEqual(self.labels(), [])

    def test_agent_commands_need_this_processs_terminal(self):
        self.keep("MY_TOKEN", "opensesame-123")
        result = self.run_cli("list", expected=1, terminal=None)
        self.assertIn("$HC_TERMINAL_ID", result.stderr)
        result = self.run_cli("list", expected=1, env={"FAKE_HC_PID": "1"})
        self.assertIn("doesn't run in terminal t1", result.stderr)
        result = self.run_cli("list", expected=1, terminal="other/terminal")
        self.assertIn("$HC_TERMINAL_ID", result.stderr)

    def test_names_json_has_no_values(self):
        self.keep("MY_TOKEN", "opensesame-123", "for the deploy")
        result = self.run_cli("names", "--json")
        rows = json.loads(result.stdout)
        self.assertEqual([row["name"] for row in rows], ["MY_TOKEN"])
        self.assertEqual(rows[0]["why"], "for the deploy")
        self.assertNotIn("value", rows[0])
        self.assertNotIn("opensesame-123", result.stdout)
        self.assertIn("MY_TOKEN", self.run_cli("names").stdout)

    def test_rm_forgets_one(self):
        self.keep("MY_TOKEN", "opensesame-123")
        self.keep("OTHER_TOKEN", "another-value")
        self.assertEqual(self.run_cli("rm", "MY_TOKEN").stdout.strip(), "Removed MY_TOKEN.")
        self.assertEqual(sorted(json.loads(self.vault.read_text())["secrets"]), ["OTHER_TOKEN"])
        self.assertEqual(self.run_cli("rm", "MY_TOKEN").stdout.strip(), "No MY_TOKEN kept.")

    def test_empty_value_and_odd_name_are_refused(self):
        result = self.run_cli("set", "MY_TOKEN", input_text="\n", expected=1)
        self.assertIn("Give the value on stdin", result.stderr)
        self.assertFalse(self.vault.exists())
        result = self.run_cli("set", "1nope", input_text="value\n", expected=1)
        self.assertIn("like an environment variable", result.stderr)

    def test_collie_secrets_home_moves_the_vault(self):
        moved = self.base / "elsewhere"
        self.run_cli("set", "MY_TOKEN", input_text="opensesame-123\n", env={"COLLIE_SECRETS_HOME": str(moved)})
        self.assertTrue((moved / "vault.json").is_file())
        self.assertFalse(self.vault.exists())
        self.assertEqual(stat.S_IMODE(moved.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((moved / "vault.json").stat().st_mode), 0o600)

    def test_vault_from_the_chat_is_readable(self):
        self.vault.parent.mkdir(parents=True)
        text = json.dumps({"version": 1, "secrets": {
            "B_TOKEN": {"value": "value-b-1234", "why": "b", "at": 1},
            "A_TOKEN": {"value": "value-a-1234", "why": "a", "at": 2},
        }}, indent=2) + "\n"
        self.vault.write_text(text)
        self.assertEqual(self.run_cli("list").stdout.split(), ["A_TOKEN", "B_TOKEN"])
        result = self.run_cli("run", "A_TOKEN", "--", "sh", "-c", 'printf %s "$A_TOKEN"')
        self.assertEqual(result.stdout, "[A_TOKEN hidden]")

    def test_a_shepherdr_vault_is_refused_not_mistaken(self):
        self.vault.parent.mkdir(parents=True)
        self.vault.write_text(json.dumps({"version": 1, "secrets": [{"name": "A_TOKEN", "value": "v"}]}))
        result = self.run_cli("names", expected=1)
        self.assertIn("isn't a Collie vault", result.stderr)

    def test_no_shepherdr_paths(self):
        self.assertNotIn(".herdr", SOURCE)
        self.assertNotIn("HERDR_SECRET", SOURCE)
        self.assertIn("collie.secret.ask.", SOURCE)
        self.assertIn(".local/share/collie/secrets", SOURCE)


if __name__ == "__main__":
    unittest.main()
