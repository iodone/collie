import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
CLI = REPO / "bin/collie-task"
VENDOR = REPO / "vendor/herdr-task"


class PublicTaskCliTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="collie-vendor-cli-")
        self.base = Path(self.temporary.name)
        self.folder = self.base / "collie"
        self.folder.mkdir()
        self.store = self.base / "tasks"
        self.settings = self.base / "settings.json"
        self.templates = self.base / "templates"
        self.artifacts = self.base / "artifacts"
        self.fake_bin = self.base / "bin"
        self.fake_bin.mkdir()
        self.fake_hc = self.fake_bin / "hc"
        self.fake_hc.write_text("""#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
if args[0] == "run":
    print(json.dumps({"address": "t-new"}))
elif args[0] == "get" and args[1] == "herdr-automations":
    print(json.dumps({"state": "live", "foreground": {"argv": ["scheduler"]}}))
elif args[0] == "get":
    print(json.dumps({"address": args[1], "state": "gone"}))
else:
    print(json.dumps({"terminals": []}))
""")
        self.fake_hc.chmod(0o755)
        self.environment = os.environ.copy()
        self.environment.update({
            "COLLIE_TASK_STORE": str(self.store),
            "COLLIE_TASK_SETTINGS": str(self.settings),
            "COLLIE_TASK_TEMPLATES": str(self.templates),
            "COLLIE_ARTIFACTS_HOME": str(self.artifacts),
            "HERDR_TASK_STORE": str(self.base / "legacy-tasks"),
            "HERDR_TASK_SETTINGS": str(self.base / "legacy-settings.json"),
            "HERDR_TASK_TEMPLATES": str(self.base / "legacy-templates"),
            "PATH": f"{self.fake_bin}:/usr/bin:/bin",
            "PYTHONDONTWRITEBYTECODE": "1",
        })

    def tearDown(self):
        self.temporary.cleanup()

    def run_cli(self, *args, expected=0, environment=None):
        result = subprocess.run(
            [sys.executable, str(CLI), *map(str, args)],
            text=True, capture_output=True, env=environment or self.environment, timeout=20, check=False,
        )
        self.assertEqual(result.returncode, expected, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        return result

    def json_cli(self, *args, expected=0):
        result = self.run_cli(*args, "--json", expected=expected)
        return json.loads(result.stdout)

    def configure_coll_42(self):
        self.json_cli("config", "--folder", self.folder, "--prefix", "COLL")
        paths = list(self.store.glob("*.json"))
        if not paths:
            self.add("Initialize the real store")
            paths = list(self.store.glob("*.json"))
        path = paths[0]
        data = json.loads(path.read_text())
        data["tasks"] = []
        data["next"] = 42
        path.write_text(json.dumps(data))
        return path

    def add(self, title="Prove the task lifecycle"):
        return self.json_cli("add", title, "--folder", self.folder, "--space", "alpha", "--here")

    def publish_proofs(self, store_path, *proofs):
        self.artifacts.mkdir(exist_ok=True)
        (self.artifacts / store_path.name).write_text(json.dumps({
            "folder": str(self.folder),
            "artifacts": [
                {"id": "unbound", "title": "Unbound · Proof", "task": None, "files": ["recipe.json"], "at": 9999999999999},
                *proofs,
            ],
        }))

    def test_real_store_lifecycle_drop_rework_and_required_proof(self):
        store_path = self.configure_coll_42()
        added = self.add()
        self.assertEqual((added["id"], added["ref"], added["state"]), (42, "COLL-42", "todo"))
        self.json_cli("accept", "COLL-42", "--folder", self.folder, expected=1)
        started = self.json_cli("start", "COLL-42", "--folder", self.folder, "--space", "alpha", "--now")
        self.assertEqual((started["id"], started["ref"], started["state"]), (42, "COLL-42", "running"))
        status = self.json_cli("status", "COLL-42", "Building the proof", "--folder", self.folder, "--done", 40, "--left", "5m")
        self.assertEqual(status["report"]["done"], 40)
        shown = self.json_cli("show", "COLL-42", "--folder", self.folder)
        self.assertEqual((shown["ref"], shown["state"]), ("COLL-42", "running"))
        listed = self.json_cli("list", "--folder", self.folder, "--slim")
        self.assertEqual(listed["tasks"][0]["ref"], "COLL-42")
        self.json_cli("accept", "COLL-42", "--folder", self.folder, expected=1)
        self.json_cli("ready", "COLL-42", "--folder", self.folder, "--summary", "Done", expected=1)
        self.json_cli("ready", "COLL-42", "--folder", self.folder, "--summary", "Done", "--details", "- Checked", expected=1)

        self.publish_proofs(store_path, {
            "id": "proof-42", "title": "COLL-42: lifecycle · Proof", "task": "COLL-42", "files": ["recipe.json"], "at": 1,
        })
        ready = self.json_cli("ready", "COLL-42", "--folder", self.folder, "--summary", "Done", "--details", "- Checked")
        self.assertEqual((ready["state"], ready["proof"]["id"]), ("ready", "proof-42"))

        rework = self.json_cli("start", "COLL-42", "--folder", self.folder, "--space", "alpha", "--now")
        self.assertEqual((rework["id"], rework["ref"], rework["state"], rework["proof"]), (42, "COLL-42", "running", None))
        self.publish_proofs(store_path, {
            "id": "proof-rework", "title": "COLL-42: rework · Proof", "task": "COLL-42", "files": ["recipe.json"], "at": 1,
        })
        self.json_cli("ready", "COLL-42", "--folder", self.folder, "--summary", "Reworked", "--details", "- Rechecked", "--proof", "proof-rework")
        accepted = self.json_cli("accept", "COLL-42", "--folder", self.folder, "--done-by", "human")
        self.assertEqual((accepted["state"], accepted["done_by"], accepted["ref"]), ("done", "human", "COLL-42"))
        self.assertIsInstance(accepted["done_at"], int)
        self.json_cli("accept", "COLL-42", "--folder", self.folder, expected=1)

        dropped = self.add("Drop this task")
        dropped = self.json_cli("done", dropped["ref"], "--folder", self.folder, "--done-by", "coordinator")
        self.assertEqual((dropped["state"], dropped["done_by"]), ("done", "coordinator"))
        self.assertIsInstance(dropped["done_at"], int)
        for field in ("stage", "seats", "gate_results", "fix_requested", "handed_at", "attention_at", "reviewers", "review", "merge", "verify"):
            self.assertNotIn(field, accepted)

    def test_start_recovers_stopped_running_task_without_resume_command(self):
        self.configure_coll_42()
        added = self.add()
        started = self.json_cli("start", added["ref"], "--folder", self.folder, "--space", "alpha", "--now")
        store_path = next(self.store.glob("*.json"))
        for _ in range(100):
            data = json.loads(store_path.read_text())
            if data["tasks"][0]["agents"][0].get("ended"):
                break
            time.sleep(0.01)
        self.assertIsNotNone(data["tasks"][0]["agents"][0].get("ended"))
        data["tasks"][0]["agents"][0]["session"] = "session-42"
        store_path.write_text(json.dumps(data))
        recovered = self.json_cli("start", "COLL-42", "--folder", self.folder, "--space", "alpha", "--now")
        self.assertEqual((recovered["id"], recovered["ref"], recovered["state"]), (42, "COLL-42", "running"))
        self.assertTrue(recovered["resumed"])
        self.assertEqual(started["ref"], recovered["ref"])
        self.run_cli("resume", "COLL-42", "--folder", self.folder, expected=2)
        self.run_cli("plan", "COLL-42", "--folder", self.folder, "--plan", "{}", expected=2)
        self.run_cli("add", "No hidden plan", "--folder", self.folder, "--plan", "{}", expected=2)

    def test_legacy_environment_aliases_do_not_select_state_or_templates(self):
        home = self.base / "isolated-home"
        legacy_store = self.base / "only-legacy-store"
        legacy_settings = self.base / "only-legacy-settings.json"
        legacy_templates = self.base / "only-legacy-templates"
        legacy_settings.write_text(json.dumps({"everywhere": {"tasks": {"max_running": 1}}}))
        (home / ".herdr/instructions").mkdir(parents=True)
        (home / ".herdr/instructions/worker.md").write_text("LEGACY ROLE\n")
        (home / ".config/herdr-core/templates/roles").mkdir(parents=True)
        environment = os.environ.copy()
        environment.update({
            "HOME": str(home), "HERDR_TASK_STORE": str(legacy_store),
            "HERDR_TASK_SETTINGS": str(legacy_settings), "HERDR_TASK_TEMPLATES": str(legacy_templates),
            "PATH": f"{self.fake_bin}:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1",
        })
        for name in ("COLLIE_TASK_STORE", "COLLIE_TASK_SETTINGS", "COLLIE_TASK_TEMPLATES"):
            environment.pop(name, None)
        result = self.run_cli("where", "--folder", self.folder, "--json", environment=environment)
        where = json.loads(result.stdout)
        self.assertTrue(where["store"].startswith(str(home / ".local/share/collie/tasks")))
        self.assertFalse(legacy_store.exists())
        config = self.run_cli("config", "--folder", self.folder, "--json", environment=environment)
        self.assertEqual(json.loads(config.stdout)["max_running"], 10)
        code = "from herdr_task.templates import instructions; print(instructions('worker'))"
        generated = subprocess.run(
            [sys.executable, "-c", code], text=True, capture_output=True, check=False,
            env={**environment, "PYTHONPATH": str(VENDOR)}, timeout=20,
        )
        self.assertEqual(generated.returncode, 0, generated.stderr)
        self.assertNotIn("LEGACY ROLE", generated.stdout)
        current = home / ".config/herdr-core/templates/roles/worker.md"
        self.assertTrue(current.is_file())
        custom = current.read_text().replace("You work on one Herdr task.", "My custom worker.")
        current.write_text(custom)
        again = subprocess.run(
            [sys.executable, "-c", code], text=True, capture_output=True, check=False,
            env={**environment, "PYTHONPATH": str(VENDOR)}, timeout=20,
        )
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(current.read_text(), custom)


class VendorInternalsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="collie-vendor-internals-")
        cls.base = Path(cls.temporary.name)
        cls.environment = mock.patch.dict(os.environ, {
            "COLLIE_TASK_STORE": str(cls.base / "tasks"),
            "COLLIE_TASK_SETTINGS": str(cls.base / "settings.json"),
            "COLLIE_TASK_TEMPLATES": str(cls.base / "templates"),
            "COLLIE_ARTIFACTS_HOME": str(cls.base / "artifacts"),
        })
        cls.environment.start()
        sys.path.insert(0, str(VENDOR))
        cls.base_module = importlib.import_module("herdr_task.base")
        cls.store = importlib.import_module("herdr_task.store")
        cls.tick = importlib.import_module("herdr_task.tick")
        cls.revive = importlib.import_module("herdr_task.revive")
        cls.agents = importlib.import_module("herdr_task.agents")
        cls.settings = importlib.import_module("herdr_task.settings")
        cls.assistant_settings = importlib.import_module("herdr_task.assistant_settings")
        cls.templates = importlib.import_module("herdr_task.templates")
        cls.launch = importlib.import_module("herdr_task.launch")
        cls.cli = importlib.import_module("herdr_task.cli")
        cls.machines = importlib.import_module("herdr_task.machines")

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        cls.temporary.cleanup()

    def make_store(self, name, max_running=2):
        folder = self.base / name
        folder.mkdir()
        Path(self.settings.SETTINGS).write_text(json.dumps({"everywhere": {"tasks": {"max_running": max_running}}}))
        s = self.store.Store(self.store.locate(str(folder)))
        with s:
            s.data["prefix"] = "COLL"
            s.data["next"] = 42
            s.dirty = True
        return folder

    def test_tick_starts_only_due_runnable_tasks_and_never_reworks_ready(self):
        folder = self.make_store("tick", max_running=2)

        def fake_begin(s, task, argv, space, parent=None):
            task["state"] = "running"
            task["started_at"] = self.base_module.now()
            task["agents"].append({"address": "t-due", "at": self.base_module.now()})
            s.dirty = True
            return {"address": "t-due"}

        with self.store.Store(self.store.locate(str(folder))) as s:
            blocker = s.new("Running dependency")
            blocker.update(state="running", agents=[{"address": "t-block", "at": self.base_module.now()}])
            due = s.new("Due task")
            due.update(scheduled_for=self.base_module.now() - 1, queue={"space": "alpha", "argv": ["claude"]})
            dependent = s.new("Dependent task")
            dependent.update(queued_at=self.base_module.now(), depends_on=["COLL-42"], queue={"space": "alpha", "argv": ["claude"]})
            capacity = s.new("Capacity task")
            capacity.update(queued_at=self.base_module.now(), queue={"space": "alpha", "argv": ["claude"]})
            ready = s.new("Ready stays ready")
            ready.update(state="ready", ready_at=self.base_module.now(), ready_turns={"t-ready": 0})
            s.dirty = True
            report = {"started": []}
            with mock.patch.object(self.tick, "begin", side_effect=fake_begin), mock.patch.object(self.tick, "machine_hold", return_value=None):
                self.tick.tick_store(s, report)
            states = {s.ref(t): t["state"] for t in s.data["tasks"]}
        self.assertEqual([row["ref"] for row in report["started"]], ["COLL-43"])
        self.assertEqual(states, {"COLL-42": "running", "COLL-43": "running", "COLL-44": "todo", "COLL-45": "todo", "COLL-46": "ready"})
        self.assertNotIn("working_again", report)
        self.assertFalse(any(t["state"] == "done" for t in s.data["tasks"]))

    def test_revive_uses_herdr_resume_label_without_legacy_reviewer_field(self):
        folder = self.make_store("revive")
        with self.store.Store(self.store.locate(str(folder))) as s:
            task = s.new("Recover helper")
            task.update(state="running", agents=[{"address": "t-driver", "argv": ["claude"], "at": 1}])
            key = s.key(task)
            s.dirty = True
        log = self.base / "helper-session.jsonl"
        log.write_text("{}\n")
        record = {"kind": "claude", "session": "helper-session", "log": str(log), "argv": ["claude"], "cwd": str(folder), "working": True, "shell": True}
        terminal = {
            "address": "t-reviewer", "state": "live", "argv": ["bash"], "foreground": {"name": "bash"}, "pid": 88, "cwd": str(folder),
            "labels": {"herdr.task": key, "herdr.role": "reviewer", self.revive.LABEL: json.dumps(record)},
        }
        def hc_json(*args):
            if args == ("ls",):
                return {"terminals": [{"address": "t-reviewer", "state": "live"}]}
            if args == ("get", "t-reviewer"):
                return terminal
            return None
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
        report = {}
        with mock.patch.object(self.revive, "hc_json", side_effect=hc_json), mock.patch.object(self.revive, "run", side_effect=run):
            self.revive.revive_pass(report)
        self.assertEqual(report["revived"], [{"terminal": "t-reviewer", "how": "resume", "session": "helper-session"}])
        sent = next(call for call in calls if call[:2] == ["hc", "send"])
        self.assertIn("--resume helper-session", sent[-1])

    def test_legacy_timestamps_do_not_make_ready_task_working(self):
        task = {
            "state": "ready", "ready_at": self.base_module.now(), "ready_turns": {}, "attention": "legacy",
            "attention_at": self.base_module.now(), "handed_at": self.base_module.now(), "fix_requested": True,
        }
        live = [{"address": "t-old", "status": "idle", "turn": 0, "labels": {}}]
        status, _, _ = self.agents.task_status(task, live)
        self.assertNotEqual(status, "working")

    def test_legacy_execution_settings_have_no_task_or_assistant_projection(self):
        folder = self.make_store("settings")
        raw = {
            "everywhere": {
                "tasks": {"merge": "auto", "review_rounds": 4, "must_fix": "minor", "proof": False, "verify": True, "max_running": 2},
                "reviewer": {"agent": "codex"},
            },
        }
        Path(self.settings.SETTINGS).write_text(json.dumps(raw))
        with self.store.Store(self.store.locate(str(folder))) as s:
            cfg = self.settings.settings_for(s)
            task = s.new("Current settings")
            rows = self.settings.task_settings(s, task)
        for field in ("merge", "review_rounds", "must_fix", "proof", "verify"):
            self.assertNotIn(field, cfg["tasks"])
        self.assertNotIn("reviewer", cfg)
        self.assertEqual([row["label"] for row in rows], ["Agent", "Proof"])
        assistant = self.assistant_settings.rows(None, d=raw, auto=(False, "", ""))
        self.assertFalse({"review", "merge", "proof"}.intersection(row["key"] for row in assistant))

    def test_brief_does_not_write_reviewer_and_old_role_is_not_migrated(self):
        folder = self.make_store("templates")
        templates = self.base / "current-templates"
        (templates / "roles").mkdir(parents=True)
        old = self.base / "old-instructions"
        old.mkdir()
        (old / "worker.md").write_text("OLD WORKER\n")
        reviewer = self.base / "reviewer-home/.config/collie/roles/reviewer.md"
        reviewer.parent.mkdir(parents=True)
        with mock.patch.object(self.templates, "TEMPLATES", str(templates)), \
                mock.patch.object(self.templates, "OLD_INSTRUCTIONS", str(old), create=True), \
                mock.patch.object(self.templates, "CONFIG_ROLE_FILES", {"reviewer": str(reviewer), "verifier": str(reviewer)}):
            worker = self.templates.instructions("worker")
            self.assertNotEqual(worker, "OLD WORKER")
            current = templates / "roles/worker.md"
            custom = current.read_text().replace("You work on one Herdr task.", "Custom current worker.")
            current.write_text(custom)
            self.templates.instructions("worker")
            self.assertEqual(current.read_text(), custom)
            with self.store.Store(self.store.locate(str(folder))) as s:
                task = s.new("Brief without reviewer write")
                self.launch.brief(s, task, space="alpha", argv=["claude"])
            self.assertFalse(reviewer.exists())

    def test_legacy_sync_hold_does_not_block_remote_install_or_machine_sync(self):
        hold = self.base / "sync-hold"
        hold.write_text("legacy installer hold\n")
        with mock.patch.object(self.base_module, "SYNC_HOLD", str(hold), create=True), \
                mock.patch.object(self.cli, "STORE", str(self.base / "remote-store")), \
                mock.patch.object(self.cli, "bundle", return_value=b"bundle"), \
                mock.patch.object(self.cli, "guard"), \
                mock.patch.object(self.cli.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=b"", stderr=b"")) as upload, \
                mock.patch.object(self.cli, "run", return_value=subprocess.CompletedProcess([], 0, stdout="ok", stderr="")):
            result = self.cli.remote_run("vm", ["list"])
            self.assertEqual(result.returncode, 0)
            self.assertEqual(upload.call_args.args[0][:4], ["hc", "file", "write", "--on"])
        with mock.patch.object(self.base_module, "SYNC_HOLD", str(hold), create=True), \
                mock.patch.object(self.machines, "manifest", return_value={"version": "v1"}), \
                mock.patch.object(self.machines, "connected_machines", return_value=[{"name": "vm", "state": "connected"}]), \
                mock.patch.object(self.machines, "sync_machine", return_value={"machine": "vm", "state": "current", "details": []}) as synced:
            result = self.machines.sync(["vm"])
            self.assertEqual(result["machines"][0]["state"], "current")
            synced.assert_called_once()


if __name__ == "__main__":
    unittest.main()
