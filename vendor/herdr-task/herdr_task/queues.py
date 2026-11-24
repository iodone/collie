"""Queue dependencies and how many tasks may run at once."""

import json
import os
import re
import subprocess
import sys

from .base import ENTRY, Fail, guard, now, STORE
from .agents import agent_running, live_agents
from .store import parse_ref, prefixes_in_use, read_list, store_path


# Another machine's task: its machine first ("vm-b:SHE-12", or "vm-b/SHE-12").
REMOTE = re.compile(r"(.+?)[:/]([A-Za-z]+[0-9]*-[0-9]+)")
EXT_EVERY = 60000


def dependency_parts(s, ref):
    """A canonical task ref as {ref, machine, prefix, id}. Local numeric ids use this store's prefix."""
    machine = None
    m = REMOTE.fullmatch(ref.strip())
    if m:
        machine, ref = m.group(1), m.group(2)
    prefix, number = parse_ref(ref)
    prefix = prefix or s.prefix
    return {"ref": f"{machine + ':' if machine else ''}{prefix}-{number}", "machine": machine, "prefix": prefix, "id": number}


def parse_depends_on(s, text):
    """Comma/whitespace-separated task refs as unique canonical refs, in the order given."""
    refs = []
    for part in re.split(r"[,\s]+", text or ""):
        if not part.strip():
            continue
        ref = dependency_parts(s, part)["ref"]
        if ref not in refs:
            refs.append(ref)
    return refs


def remote_state(dep):
    """A dependency's current state, or None when its task no longer exists."""
    ref = f"{dep['prefix']}-{dep['id']}"
    if not dep.get("machine"):
        folder = prefixes_in_use().get(dep["prefix"])
        if not folder:
            return None
        data = read_list(store_path(folder)[1])
        if data is None:
            raise Fail(f"Couldn't read {ref}'s list.")
        return next((t.get("state") for t in data.get("tasks") or [] if t.get("id") == dep["id"]), None)
    guard(["hc"])
    args = [sys.executable, ENTRY, "--on", dep["machine"], "show", ref, "--json"]
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=60)
    except subprocess.TimeoutExpired:
        raise Fail(f"{dep['machine']} didn't answer.")
    try:
        data = json.loads(result.stdout)
    except ValueError:
        data = None
    if isinstance(data, dict) and data.get("state"):
        return data["state"]
    error = (data or {}).get("error") if isinstance(data, dict) else None
    if error and ("No task" in error or "isn't a task" in error):
        return None
    last = ((result.stderr or "").strip().splitlines() or [f"Couldn't ask {dep['machine']}."])[-1]
    raise Fail(error or re.sub(r"^[\w.]*Fail: ", "", last))


def set_depends_on(s, task, refs):
    """Set canonical dependency refs, refusing unknown tasks and dependency loops."""
    known = {t["id"]: t for t in s.data["tasks"]}
    deps = [dependency_parts(s, ref) for ref in refs]
    for dep in deps:
        if dep["machine"] or dep["prefix"] != s.prefix:
            try:
                state = remote_state(dep)
            except Fail as e:
                raise Fail(f"Couldn't check {dep['ref']}: {e}")
            if state is None:
                raise Fail(f"There is no task {dep['ref']}" + (f" on {dep['machine']}." if dep["machine"] else " on this machine."))
        elif dep["id"] not in known:
            raise Fail(f"No task {s.prefix}-{dep['id']} here.")

    seen, todo = set(), list(refs)
    while todo:
        ref = todo.pop()
        dep = dependency_parts(s, ref)
        if not dep["machine"] and dep["prefix"] == s.prefix and dep["id"] == task["id"]:
            raise Fail(f"That makes a loop: {s.ref(task)} would end up waiting for itself.")
        if ref in seen or dep["machine"] or dep["prefix"] != s.prefix or dep["id"] not in known:
            continue
        seen.add(ref)
        todo.extend(known[dep["id"]].get("depends_on") or [])
    task["depends_on"] = [dep["ref"] for dep in deps]
    s.dirty = True


def dependency_state(s, dep, budget=None):
    """Read a dependency, caching remote answers briefly as scheduler metadata."""
    if not dep["machine"]:
        if dep["prefix"] == s.prefix:
            return next((t.get("state") for t in s.data["tasks"] if t["id"] == dep["id"]), None)
        return remote_state(dep)
    checks = s.data.setdefault("dependency_checks", {})
    cached = checks.get(dep["ref"]) or {}
    fresh = now() - (cached.get("checked") or 0) < EXT_EVERY
    if fresh or (budget is not None and budget[0] <= 0):
        return cached.get("state") or "unknown"
    if budget is not None:
        budget[0] -= 1
    try:
        state = remote_state(dep) or "gone"
        row = {"state": state, "checked": now()}
    except Fail as e:
        row = {"state": "unknown", "checked": now(), "error": str(e)}
    checks[dep["ref"]] = row
    s.dirty = True
    return row["state"]


def pending_dependencies(s, task, budget=None):
    """Canonical refs whose tasks still exist and aren't done."""
    pending = []
    for ref in task.get("depends_on") or []:
        dep = dependency_parts(s, ref)
        if dependency_state(s, dep, budget) not in ("done", "gone", None):
            pending.append(dep["ref"])
    return pending


def working(s, task):
    """An agent is at work on it (or one started moments ago and hasn't shown up yet)."""
    if task["state"] != "running":
        return False
    last = task["agents"][-1] if task["agents"] else {}
    if now() - (last.get("at") or 0) < 30000:
        return True
    return any(agent_running(k) for k in live_agents(s.key(task)))


def running_count(s, skip=None):
    return sum(1 for t in s.data["tasks"] if t is not skip and working(s, t))


def queue_reason(s, task):
    """Why a start has to wait, in plain words; None when it can go."""
    pending = pending_dependencies(s, task)
    if pending:
        return "after " + ", ".join(pending)
    count = running_count(s, task)
    if count >= s.max_running():
        return f"{count} tasks are running here" if count != 1 else "1 task is running here"
    return machine_hold()


# ---- the machine's room ---------------------------------------------------------------------
HOLD_FILE = os.path.join(os.path.dirname(STORE.rstrip("/")), "machine-hold.json")
_hold = {}


def set_hold(machine=None, limits=None):
    """Keep this process's machine name and start limits for later runs."""
    _hold.clear()
    _hold.update({"machine": machine, "limits": limits})
    try:
        with open(HOLD_FILE) as f:
            if json.load(f) == {"machine": machine, "limits": limits}:
                return
    except (OSError, ValueError):
        pass
    try:
        os.makedirs(os.path.dirname(HOLD_FILE), exist_ok=True)
        tmp = f"{HOLD_FILE}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump({"machine": machine, "limits": limits}, f)
        os.replace(tmp, HOLD_FILE)
    except OSError:
        pass


def machine_hold():
    """Why new tasks wait on this machine now, or None."""
    if "reason" in _hold:
        return _hold["reason"]
    try:
        from .machine import hold_reason, sample
        from .settings import machine_limits, machine_name
        if "limits" not in _hold:
            try:
                with open(HOLD_FILE) as f:
                    _hold.update(json.load(f))
            except (OSError, ValueError):
                _hold.update({"machine": None, "limits": None})
        limits = _hold.get("limits") if _hold.get("limits") is not None else machine_limits(_hold.get("machine"))
        why = hold_reason(sample(), limits)
        name = _hold.get("machine") or machine_name()
        reason = (f"{name}'s {why}" if name else f"This computer's {why}") if why else None
    except Exception:
        reason = None
    _hold["reason"] = reason
    return reason
