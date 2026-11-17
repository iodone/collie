import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parent.parent
CLI = REPO / "bin/collie"
BUN = shutil.which("bun")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def layout_mods(value):
    if isinstance(value, dict):
        return ({value["mod"]} if isinstance(value.get("mod"), str) else set()).union(
            *(layout_mods(child) for key, child in value.items() if key != "mod")
        )
    if isinstance(value, list):
        return set().union(*(layout_mods(child) for child in value))
    return set()


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="collie-test-")
        self.base = Path(self.temporary.name)
        self.home = self.base / "home"
        self.root = self.base / "root"
        self.source = self.base / "source"
        self.fake_bin = self.base / "fake-bin"
        self.make_source()
        self.make_dependencies()

    def tearDown(self):
        self.temporary.cleanup()

    def make_source(self):
        self.source.mkdir()
        for directory in ("bin", "layouts", "templates", "lib", "core", "mods", "kernel", "plugins", "service", "protocol", "vendor"):
            if (REPO / directory).exists():
                shutil.copytree(REPO / directory, self.source / directory)
        shutil.copy2(REPO / "addons.json", self.source / "addons.json")
        shutil.copy2(REPO / "install.sh", self.source / "install.sh")
        addons = json.loads((self.source / "addons.json").read_text())
        for mod in addons["mods"]:
            target = self.source / "mods" / mod / "main.js"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"export const mod = {json.dumps(mod)};\n")

    def make_dependencies(self):
        self.fake_bin.mkdir()
        task = self.fake_bin / "herdr-task"
        task.write_text("#!/bin/sh\necho 'herdr-task 3.1.33'\n")
        task.chmod(0o755)
        for name in ("bun", "git"):
            path = self.fake_bin / name
            path.write_text("#!/bin/sh\nexit 0\n")
            path.chmod(0o755)
        shepherdr = self.root / ".config/herdr-app/data/shepherdr/installed.json"
        shepherdr.parent.mkdir(parents=True)
        shepherdr.write_text(json.dumps({"version": "3.1.33"}))
        addons = json.loads((self.source / "addons.json").read_text())
        own_mods = set(addons["mods"])
        layout = json.loads((self.source / "layouts/collie.json").read_text())
        for mod in (layout_mods(layout) | set(addons["needs"])) - own_mods:
            (self.root / ".config/herdr-app/mods" / mod).mkdir(parents=True, exist_ok=True)

    def run_cli(self, *args, source=None, expected=0, input_text=None):
        environment = os.environ.copy()
        environment.update({"HOME": str(self.home), "PATH": f"{self.fake_bin}:/usr/bin:/bin"})
        result = subprocess.run(
            [sys.executable, str((source or self.source) / "bin/collie"), *map(str, args)],
            text=True,
            input=input_text,
            capture_output=True,
            env=environment,
            timeout=20,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            expected,
            msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        return result

    def install(self, *extra, expected=0):
        return self.run_cli("install", "--root", self.root, "--yes", *extra, expected=expected)

    def test_fresh_install_manifest_and_doctor_are_green(self):
        self.install()
        manifest_path = self.root / ".config/herdr-app/installed.collie.json"
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(manifest["source"], str(self.source.resolve()))
        self.assertGreater(len(manifest["files"]), 5)
        for relative, expected in manifest["files"].items():
            self.assertEqual(sha256(self.root / relative), expected)
        self.assertTrue((self.root / ".config/herdr-core/templates/collie-coordinator.md").is_file())
        helper = self.root / ".local/bin/collie-sync"
        self.assertTrue(helper.is_file())
        self.assertTrue(os.access(helper, os.X_OK))
        secret = self.root / ".local/bin/collie-secret"
        self.assertTrue(secret.is_file())
        self.assertTrue(os.access(secret, os.X_OK))
        self.assertTrue((self.root / ".config/herdr-app/bin/collie-secret").is_file())
        self.assertTrue((self.root / ".local/share/collie/service/main.ts").is_file())
        self.assertTrue((self.root / ".local/share/collie/protocol/invariants.mjs").is_file())
        self.assertEqual(
            (self.root / ".local/state/collie/ruleset.json").read_bytes(),
            (self.source / "protocol/fixtures/ruleset.json").read_bytes(),
        )
        self.assertFalse(self.home.exists())
        result = self.run_cli("doctor", "--root", self.root)
        self.assertIn("doctor: all checks passed", result.stdout)

    @unittest.skipUnless(BUN, "bun is required for the runtime smoke test")
    def test_installed_background_service_starts(self):
        self.install()
        state = self.root / ".local/state/collie"
        environment = os.environ.copy()
        environment.update({
            "HOME": str(self.root),
            "HERDR_INBOX_STATE": str(state),
            "HERDR_INBOX_RULESET": str(state / "ruleset.json"),
        })
        process = subprocess.Popen(
            [BUN, str(self.root / ".local/share/collie/service/main.ts")],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
        )
        try:
            stdout, stderr = process.communicate(timeout=2)
            self.fail(f"service exited early: {process.returncode}\n{stdout}\n{stderr}")
        except subprocess.TimeoutExpired:
            process.terminate()
            stdout, stderr = process.communicate(timeout=5)
        self.assertIn("collie service ready", stderr)
        self.assertTrue((state / "incoming").is_dir())

    def test_install_sh_and_dry_run(self):
        environment = os.environ.copy()
        environment.update({"HOME": str(self.home), "PATH": f"{self.fake_bin}:/usr/bin:/bin"})
        dry = subprocess.run(
            [str(self.source / "install.sh"), "--root", str(self.root), "--dry-run"],
            capture_output=True,
            text=True,
            env=environment,
            check=False,
        )
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertFalse((self.root / ".config/herdr-app/installed.collie.json").exists())
        self.assertFalse((self.root / ".config/herdr-core").exists())
        self.install()

    def test_update_replaces_unmodified_file_and_keeps_backup(self):
        self.install()
        relative = ".config/herdr-app/layouts/collie.json"
        target = self.root / relative
        original = target.read_bytes()
        layout = json.loads((self.source / "layouts/collie.json").read_text())
        layout["title"] = "v2"
        (self.source / "layouts/collie.json").write_text(json.dumps(layout))
        self.run_cli("update", "--root", self.root, "--yes")
        self.assertEqual(json.loads(target.read_text())["title"], "v2")
        backups = list((self.root / ".config/herdr-app/.collie-backup").glob("*/layouts/collie.json"))
        self.assertTrue(any(path.read_bytes() == original for path in backups))
        manifest = json.loads((self.root / ".config/herdr-app/installed.collie.json").read_text())
        self.assertEqual(manifest["files"][relative], sha256(target))

    def test_modified_file_gets_new_and_doctor_fails(self):
        self.install()
        target = self.root / ".config/herdr-app/layouts/collie.json"
        local = json.loads(target.read_text())
        local["local"] = True
        target.write_text(json.dumps(local))
        incoming = json.loads((self.source / "layouts/collie.json").read_text())
        incoming["title"] = "upstream"
        (self.source / "layouts/collie.json").write_text(json.dumps(incoming))
        self.run_cli("update", "--root", self.root, "--yes", expected=1)
        self.assertTrue(json.loads(target.read_text())["local"])
        self.assertEqual(json.loads(target.with_name("collie.json.new").read_text())["title"], "upstream")
        result = self.run_cli("doctor", "--root", self.root, expected=1)
        self.assertIn("pending update", result.stdout)

    def test_unmanaged_conflict_requires_adopt_and_is_backed_up(self):
        target = self.root / ".config/herdr-app/layouts/collie.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('{"mine": true}\n')
        self.install(expected=2)
        self.assertEqual(json.loads(target.read_text()), {"mine": True})
        self.install("--adopt")
        backups = list((self.root / ".config/herdr-app/.collie-backup").glob("*/layouts/collie.json"))
        self.assertTrue(any(json.loads(path.read_text()) == {"mine": True} for path in backups))

    def test_keys_keep_and_ours(self):
        addons_path = self.source / "addons.json"
        addons = json.loads(addons_path.read_text())
        addons["keys"] = {"ctrl-shift-l": "layout inbox"}
        addons_path.write_text(json.dumps(addons))
        keys = self.root / ".config/herdr-app/keys.json"
        keys.write_text(json.dumps({"ctrl-shift-l": "mine", "existing": 1}))
        self.install("--keys", "keep")
        self.assertEqual(json.loads(keys.read_text())["ctrl-shift-l"], "mine")
        self.run_cli("update", "--root", self.root, "--yes", "--keys", "ours")
        self.assertEqual(json.loads(keys.read_text()), {"ctrl-shift-l": "layout inbox", "existing": 1})

    def test_keys_ask_requires_and_accepts_explicit_choice(self):
        addons_path = self.source / "addons.json"
        addons = json.loads(addons_path.read_text())
        addons["keys"] = {"ctrl-shift-l": "layout inbox"}
        addons_path.write_text(json.dumps(addons))
        keys = self.root / ".config/herdr-app/keys.json"
        keys.write_text(json.dumps({"ctrl-shift-l": "mine"}))
        self.install(expected=2)
        self.assertEqual(json.loads(keys.read_text())["ctrl-shift-l"], "mine")
        self.run_cli("install", "--root", self.root, input_text="o\ny\n")
        self.assertEqual(json.loads(keys.read_text())["ctrl-shift-l"], "layout inbox")

    def test_missing_dependency_stops_before_writes(self):
        (self.fake_bin / "bun").unlink()
        result = self.install(expected=2)
        self.assertIn("missing dependency", result.stderr)
        self.assertFalse((self.root / ".config/herdr-app/installed.collie.json").exists())
        self.assertFalse((self.root / ".config/herdr-core").exists())

    def test_uninstall_removes_clean_files_and_preserves_modified(self):
        self.install()
        layout = self.root / ".config/herdr-app/layouts/collie.json"
        template = self.root / ".config/herdr-core/templates/collie-coordinator.md"
        template.write_text("local notes\n")
        self.run_cli("uninstall", "--root", self.root, "--dry-run")
        self.assertTrue(layout.exists())
        self.run_cli("uninstall", "--root", self.root, "--yes")
        self.assertFalse(layout.exists())
        self.assertEqual(template.read_text(), "local notes\n")
        manifest = json.loads((self.root / ".config/herdr-app/installed.collie.json").read_text())
        self.assertIn(".config/herdr-core/templates/collie-coordinator.md", manifest["files"])
        self.assertTrue((self.root / ".local/state/collie").exists())

    def test_sync_check_dry_run_and_copy(self):
        library = self.source / "lib/shared.js"
        library.parent.mkdir(exist_ok=True)
        library.write_text("export const value = 1;\n")
        copies = self.source / "lib/COPIES"
        copies.write_text(copies.read_text() + "shared.js: collie-inbox\n")
        environment = os.environ.copy()
        environment["HOME"] = str(self.home)
        command = [sys.executable, str(self.source / "bin/collie-sync"), "--root", str(self.source)]
        check = subprocess.run(command + ["--check"], capture_output=True, env=environment, check=False)
        self.assertEqual(check.returncode, 1)
        dry = subprocess.run(command + ["--dry-run"], capture_output=True, env=environment, check=False)
        self.assertEqual(dry.returncode, 0)
        copied = self.source / "mods/collie-inbox/lib/shared.js"
        self.assertFalse(copied.exists())
        subprocess.run(command, capture_output=True, env=environment, check=True)
        self.assertEqual(copied.read_text(), library.read_text())
        subprocess.run(command + ["--check"], capture_output=True, env=environment, check=True)


if __name__ == "__main__":
    unittest.main()
