import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import importlib.util

from importlib.machinery import SourceFileLoader
SPEC = importlib.util.spec_from_loader("supervisor", SourceFileLoader("supervisor", str(Path(__file__).resolve().parent.parent / "bin/collie-supervisor")))
supervisor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(supervisor)


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="collie-supervisor-")
        root = Path(self.temp.name)
        supervisor.RUNTIME = root / "runtime.json"
        supervisor.LOCK = root / "runtime.lock"
        supervisor.record_session = lambda record: None
        supervisor.revive.revive_pass = lambda report: None

    def tearDown(self):
        self.temp.cleanup()

    def test_adopts_live_coordinator_without_creating_another(self):
        calls = []
        with patch.object(supervisor, "live", return_value=[{"address": "t7c"}]), \
             patch.object(supervisor, "run", side_effect=lambda args: calls.append(args)):
            record = supervisor.ensure("space-a")
        self.assertEqual(record["state"], "running")
        self.assertEqual(record["terminal"], "t7c")
        self.assertEqual(calls, [])

    def test_disabled_stop_prevents_restart(self):
        supervisor.save({"version": 1, "spaces": {"space-a": {"enabled": False, "state": "stopped"}}})
        with patch.object(supervisor, "live", return_value=[]), \
             patch.object(supervisor, "run") as command:
            record = supervisor.ensure("space-a")
        self.assertFalse(record["enabled"])
        self.assertEqual(record["state"], "stopped")
        command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
