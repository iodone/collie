import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parent.parent
CLI = REPO / "bin/collie-terminal"


class TerminalTest(unittest.TestCase):
    def run_cli(self, cli):
        with tempfile.TemporaryDirectory(prefix="collie-terminal-") as directory:
            home = Path(directory)
            state = home / ".local/state/collie"
            state.mkdir(parents=True)
            (state / "coordinator.json").write_text(json.dumps({
                "everywhere": {"coordinator": {"cli": cli, "model": "default", "effort": "high"}},
            }))
            role = home / ".config/herdr-core/templates/collie-coordinator.md"
            role.parent.mkdir(parents=True)
            role.write_text("You are the coordinator.")
            env = os.environ.copy()
            env.update({"HOME": str(home), "HERDR_INBOX_TERMINAL_DRY_RUN": "1"})
            result = subprocess.run([str(CLI), "--space", "test"], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_codex_native_interactive_arguments(self):
        result = self.run_cli("codex")
        self.assertIn("--no-daemon", result["args"])
        self.assertIn("--sandbox", result["args"])
        self.assertIn("read-only", result["args"])
        self.assertIn('model_reasoning_effort="high"', result["args"])
        self.assertNotIn("exec", result["args"])

    def test_claude_native_interactive_arguments(self):
        result = self.run_cli("claude")
        self.assertIn("--permission-mode", result["args"])
        self.assertIn("plan", result["args"])
        self.assertIn("--effort", result["args"])
        self.assertNotIn("-p", result["args"])


if __name__ == "__main__":
    unittest.main()
