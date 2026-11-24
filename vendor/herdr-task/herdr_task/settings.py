"""The person's settings (~/.config/collie/settings.json and per-folder), the agent each task runs, and
the Settings block a task's brief ends with."""

import json
import os
import re

from .base import Fail, HOME, MAX_RUNNING


# What each agent key starts by default. Unknown keys run as themselves; --argv overrides.
AGENTS = {"claude": ["claude"], "codex": ["codex", "--no-daemon"]}


# ---- the person's settings ------------------------------------------------------------------

SETTINGS = os.environ.get("COLLIE_TASK_SETTINGS") or os.path.join(HOME, ".config", "collie", "settings.json")
# The role instructions are herdr-core templates (`hc templates` lists them).
TEMPLATES = os.environ.get("COLLIE_TASK_TEMPLATES") or os.path.join(HOME, ".config", "herdr-core", "templates")
ASSISTANT_TEMPLATES = ("assistant", "coordinator")  # "coordinator": the Collie Coordinator role
DEFAULTS = {"tasks": {"max_running": MAX_RUNNING, "worktrees": True, "start_notes": "", "finish_notes": "",
                      "archive_after": 7, "base": "", "branch": ""},
            "automations": {"enabled": True}, "driver": {}, "worker": {}, "coordinator": {}, "backup": {},
            "agents": {"reactions": True, "feedback": True, "feedback_repo": "iodone/collie"}}


# The machine layer's key for the computer whose Herdr window wrote the file. A copy the window
# pushes to another machine says which machine that is in "here" (and holds that machine's
# spaces by their bare ids), so the same lookup works there.
LOCAL_MACHINE = "local"


def read_settings():
    """The settings file as it is ({} when there is none or it can't be read)."""
    try:
        with open(SETTINGS) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def autopilot_layers(d, space=None):
    """(Everywhere's, the space's own) Autopilot in a settings file d: {every, events, heartbeat, direction},
    each only when set. A space is found by its id on this machine (a pushed copy holds this
    machine's spaces by their bare ids, as herdr-task names them)."""
    def part(layer):
        a = (layer or {}).get("autopilot") if isinstance(layer, dict) else None
        return {k: v for k, v in a.items() if k in ("every", "events", "heartbeat", "direction") and v is not None} if isinstance(a, dict) else {}
    return part(d.get("everywhere")), part((d.get("spaces") or {}).get(space) if space else None)


def write_autopilot(space, values):
    """Sets Autopilot fields at one level of the settings file (space None: Everywhere's); a value
    None unsets it there, so it follows the level above again. Refused on a copy the window
    pushed here: the window's machine holds the truth and would put its own back."""
    d = read_settings()
    if d.get("pushed_from"):
        raise Fail("This machine's Shepherdr settings are a copy from the machine whose window sets them: change Autopilot in Settings there.")
    if space:
        layer = (d.setdefault("spaces", {})).setdefault(space, {})
    else:
        layer = d.setdefault("everywhere", {})
    a = dict(layer.get("autopilot") or {})
    for k, v in values.items():
        if v is None:
            a.pop(k, None)
        else:
            a[k] = v
    if a:
        layer["autopilot"] = a
    else:
        layer.pop("autopilot", None)
    if space and not layer:
        d["spaces"].pop(space, None)
    d["version"] = 1
    os.makedirs(os.path.dirname(SETTINGS), exist_ok=True)
    tmp = f"{SETTINGS}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
    os.replace(tmp, SETTINGS)


def reactions_on(space=None, d=None):
    """Settings › Agents › Reactions in a space, for every agent there (reactions.py): the space's
    own, else Everywhere's, else on. A layer's agents.reactions, else what SHEP-42 kept as
    assistant.reactions (when only the Assistant reacted): the window and the web app move it."""
    d = read_settings() if d is None else d
    own = (d.get("spaces") or {}).get(bare(space)) if space else None
    for layer in (own, d.get("everywhere")):
        for key in ("agents", "assistant"):
            a = layer.get(key) if isinstance(layer, dict) else None
            v = a.get("reactions") if isinstance(a, dict) else None
            if isinstance(v, bool):
                return v
    return DEFAULTS["agents"]["reactions"]


def settings_layers(s, space=None):
    """(Everywhere's, this machine's, this folder's) raw settings, least specific first: the
    folder's are those of the space working in it (--space's when several do)."""
    try:
        with open(SETTINGS) as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    spaces = d.get("spaces") or {}
    mine = [v for k, v in spaces.items() if (v or {}).get("folder") == s.loc["folder"]]
    pick = (spaces.get(bare(space)) if space and (spaces.get(bare(space)) or {}).get("folder") == s.loc["folder"] else None) or (mine[0] if mine else None)
    machine = (d.get("machines") or {}).get(d.get("here") or LOCAL_MACHINE)
    return d.get("everywhere") or {}, machine or {}, pick or {}


def settings_for(s, space=None):
    """The settings for this folder's tasks: Shepherdr settings' Everywhere, then this machine's,
    then the override of the space working in this folder (--space's when several do): the most
    specific wins. The window no longer writes agent or task values for a machine (only its
    machine-only rows, read by machine_limits/machine_option); ones set before still apply here. Written by Collie settings; herdr-task only
    reads them."""
    everywhere, machine, pick = settings_layers(s, space)
    out = {k: dict(v) for k, v in DEFAULTS.items()}

    def merge(part):
        for k, v in (part or {}).items():
            if isinstance(v, dict) and isinstance(out.get(k), dict):
                if k == "tasks":
                    v = {kk: vv for kk, vv in v.items() if kk in out[k]}
                out[k].update({kk: vv for kk, vv in v.items() if vv is not None})
            elif k in out and v is not None:
                out[k] = v
    merge(everywhere)
    merge(machine)
    merge(pick)
    return out


def notes(s, task, which, space=None):
    """A task's "When a task starts" / "finishes" notes (which: "start" or "finish"): its own
    (--start-notes / --finish-notes), else its folder's from Shepherdr settings. Herdr runs
    nothing itself: the notes go into the agents' starting prompts."""
    own = (task.get(f"{which}_notes") or "").strip()
    return own or (settings_for(s, space or task.get("space"))["tasks"].get(f"{which}_notes") or "").strip()


def notes_part(head, text):
    """ "Before you start: ..." on one line, or the head over the notes when they have several."""
    return f"{head}:\n{text}" if "\n" in text else f"{head}: {text}" if text else ""


def worktrees_on(s, space=None):
    """Tasks here get a git worktree each: in a git repo, unless the person's Shepherdr settings
    turn worktrees off for it (then it works in the folder itself, as a folder without git)."""
    return s.loc["kind"] == "repo" and settings_for(s, space)["tasks"].get("worktrees") is not False


def argv_for(pick):
    """How to start an agent from a role's settings {agent, model, effort, fast, perm} (or its own
    argv), as the chat's agent picker builds it (mods/chat/agent.js argvFor). None: no setting."""
    if not pick:
        return None
    if pick.get("argv"):
        return [str(x) for x in pick["argv"]]
    agent = pick.get("agent")
    if agent == "claude":
        a = ["claude"]
        if pick.get("model"):
            a += ["--model", pick["model"]]
        if pick.get("effort"):
            a += ["--effort", pick["effort"]]
        a += ["--settings", json.dumps({"fastMode": bool(pick.get("fast"))})]
        perm = pick.get("perm")
        if perm == "bypassPermissions":
            a.append("--dangerously-skip-permissions")
        elif perm:
            a += ["--permission-mode", "default" if perm == "manual" else perm]
        return a
    if agent == "codex":
        a = ["codex", "--no-daemon"]
        if pick.get("model"):
            a += ["-m", pick["model"]]
        if pick.get("effort"):
            a += ["-c", f'model_reasoning_effort="{pick["effort"]}"']
        # always said, so Fast off wins over a service_tier in config.toml (default: the standard tier)
        a += ["-c", 'service_tier="%s"' % ("fast" if pick.get("fast") else "default")]
        perm = pick.get("perm")
        if perm == "full":
            a.append("--dangerously-bypass-approvals-and-sandbox")
        elif perm == "read-only":
            a += ["-s", "read-only", "-a", "on-request"]
        elif perm:
            a += ["-s", "workspace-write", "-a", "on-request"]
        return a
    return [agent] if agent else None


def worker_pick(s, task, space=None, agent=None):
    """What a task's agent runs on, {agent, model, effort, fast, perm}: Settings' worker, then the
    task's own --agent / --model / --effort, then `agent` (start --agent). Another CLI than
    Settings' starts from its own defaults (models and permissions differ per CLI)."""
    cfg = settings_for(s, space)
    pick = dict((cfg.get("driver") or cfg.get("worker") or {}))
    for key in (task.get("agent"), agent):
        if key and key != pick.get("agent"):
            pick = {"agent": key}
    if not pick.get("agent") and not pick.get("argv"):
        pick["agent"] = "claude"
    for k in ("model", "effort"):
        if task.get(k):
            pick[k] = task[k]
    return pick


def worker_argv(s, task, space=None, agent=None):
    """A task's agent when nobody gave an argv: worker_pick's."""
    pick = worker_pick(s, task, space, agent)
    if pick.get("argv") and not (task.get("model") or task.get("effort")):
        return argv_for(pick)
    pick.pop("argv", None)
    pick.setdefault("agent", "claude")
    return argv_for(pick) or agent_argv(pick["agent"])


def argv_model(argv):
    """(model, effort) an agent's argv asks for, as argv_for writes them; None where it doesn't."""
    model = effort = None
    for i, a in enumerate(argv[:-1]):
        nxt = argv[i + 1]
        if a in ("--model", "-m"):
            model = nxt
        elif a == "--effort":
            effort = nxt
        elif a in ("-c", "--config") and nxt.startswith("model_reasoning_effort="):
            effort = nxt.split("=", 1)[1].strip("\"'")
    return model, effort


# ---- the Settings block: the settings that shape a task's work, as words in its brief ---------
# As in Shepherdr: settings only change what goes into an agent's starting prompt. Every brief
# ends with this block, one line per setting; a line that differs from Herdr's default says who
# changed it. The coordinator changes one task's with `add --set key=value` (and --model, --effort).
# The brief's own words win over the block.

SETTINGS_HEAD = "Settings: (from herdr-task show; where the brief above says otherwise, it wins)"
SET_BY = {"task": "set by the assistant for this task", "folder": "this folder's setting", "machine": "this machine's setting",
          "all": "your setting everywhere"}
SET_KEYS = {
    "agent": "agent", "task.agent": "agent", "model": "model", "task.model": "model",
    "effort": "effort", "task.effort": "effort", "playbook": "playbook",
}
PROOF_WORDS = ("show verifiable proof in one recipe artifact: each proof with a one-line caption, real and from this work now, "
               "plus a \"Not proven\" list; then say ready with --proof <its id>")
EFFORTS = {"none", "minimal", "lowest", "low", "medium", "high", "xhigh", "max", "ultra"}


def set_task(t, key, value):
    """Set one driver/playbook option on a task."""
    field = SET_KEYS.get(key.strip().lower())
    if not field:
        raise Fail(f"--set takes agent, model, effort or playbook, not {key!r}.")
    v = value.strip().strip("\"'").strip()
    if not v or v.lower() == "default":
        t.pop(field, None)
        return
    if field == "effort" and v.lower() not in EFFORTS:
        raise Fail(f"effort is one of {', '.join(sorted(EFFORTS))} (or default).")
    t[field] = v


def set_opts(t, args):
    """Apply add/edit's driver flags, then any --set pairs."""
    for flag in ("agent", "model", "effort"):
        v = getattr(args, flag, None)
        if v is not None:
            set_task(t, flag, v)
    for pair in getattr(args, "set", None) or []:
        if "=" not in pair:
            raise Fail(f"--set takes key=value, not {pair!r}.")
        k, v = pair.split("=", 1)
        set_task(t, k, v)


def by_layer(s, space, section, key, value, default):
    """Who set a setting that differs from Herdr's default: "folder", "machine", "all", or None."""
    if value == default:
        return None
    everywhere, machine, mine = settings_layers(s, space)
    for by, layer in (("folder", mine), ("machine", machine), ("all", everywhere)):
        if key in ((layer.get(section) or {}) if key else {}) or (not key and layer.get(section)):
            return by
    return None


def task_settings(s, t, space=None, argv=None):
    """Driver, branch and proof settings shown in the brief; no review or delivery policy."""
    space = space or t.get("space")
    cfg = settings_for(s, space)
    argv = argv or (t["agents"][-1].get("argv") if t.get("agents") else None) or worker_argv(s, t, space)
    agent = agent_key(argv)
    model, effort = argv_model(argv)
    driver_by = "task" if any(t.get(f) for f in ("agent", "model", "effort")) else by_layer(
        s, space, "driver" if cfg.get("driver") else "worker", None, bool(cfg.get("driver") or cfg.get("worker")), False
    )
    lines = [{
        "label": "Agent",
        "text": agent + (f", model {model}" if model else "") + (f", effort {effort}" if effort else ""),
        "value": {"agent": agent, "model": model, "effort": effort},
        "by": driver_by,
    }]
    if t.get("base_set"):
        lines.append({
            "label": "Base", "text": f"{t['base']}: your branch starts from it", "value": t["base"],
            "by": "folder" if t.get("base_by") == "space" else "task",
        })
    lines.append({"label": "Proof", "text": PROOF_WORDS, "value": True, "by": None})
    return lines


def settings_block(s, t, space=None, argv=None):
    rows = [f"- {x['label']}: {x['text']}" + (f" ({SET_BY[x['by']]})" if x["by"] else "") for x in task_settings(s, t, space, argv)]
    return "\n".join([SETTINGS_HEAD, *rows])





def space_base(s, space=None):
    """The branch a space's new tasks branch from (Collie settings > Tasks > Base branch,
    per space); "" when unset: the folder's current branch."""
    return str(settings_for(s, space)["tasks"].get("base") or "").strip()


# Shepherdr settings > Tasks > Branch names (tasks.branch, #570): a folder's new task branches.
# {n}: the task's number, {key}: its id (SHEP-4), {slug}: its title's words. Unset: this.
BRANCH_PATTERN = "task/{n}-{slug}"


def branch_pattern_problem(pattern):
    """Why a Branch names pattern can't be used, or None (core/settings.js branchPattern says the same)."""
    p = str(pattern or "").strip()
    if not p:
        return None
    if "{n}" not in p and "{key}" not in p:
        return "Put {n} or {key} in it, so each task's branch is its own."
    if re.search(r"\{(?!(?:n|key|slug)\})[^}]*\}", p):
        return "Only {n}, {key} and {slug} can be filled in."
    sample = p.replace("{n}", "4").replace("{key}", "ABC-4").replace("{slug}", "fix-login")
    if (sample.startswith("-") or sample.startswith("/") or sample.endswith("/") or sample.endswith(".") or sample.endswith(".lock")
            or re.search(r"[\s~^:?*\[\\]|\.\.|@\{|//|/\.", sample)):
        return "That isn't a name git allows for a branch."
    return None




def agent_argv(key, argv_json=None):
    if argv_json:
        argv = json.loads(argv_json)
        if not isinstance(argv, list) or not argv:
            raise Fail("--argv must be a JSON list")
        argv = [str(x) for x in argv]
    else:
        argv = list(AGENTS.get(key, [key]))
    # Codex runs its commands outside hc without --no-daemon.
    if agent_key(argv) == "codex" and "--no-daemon" not in argv:
        argv.append("--no-daemon")
    return argv


def agent_key(argv):
    return os.path.basename(argv[0])


def bare(i):
    """Ids as labels use them: "vm/sp12" -> "sp12"."""
    return i.split("/")[-1] if i else i


def machine_limits(machine=None):
    """A machine's start limits (Settings > Machines; HERD-40): Everywhere's ("everywhere" ->
    "machine"), then that machine's own ("machines" -> its key -> "machine"; "local" is this
    computer, and a file Herdr pushed to another machine names it in "here"). Each is a number,
    or null for off; one not set is Shepherdr's default (machine.HOLD)."""
    from .machine import hold_limits
    try:
        with open(SETTINGS) as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    key = machine or d.get("here") or "local"
    out = dict((d.get("everywhere") or {}).get("machine") or {})
    out.update(((d.get("machines") or {}).get(key) or {}).get("machine") or {})
    return hold_limits(out)


def machine_option(name, default=None, machine=None):
    """One of a machine's own settings (Settings > Machines; HERD-61: low_priority, worker_memory):
    Everywhere's "machine" layer, then the machine's own; set in neither: default."""
    try:
        with open(SETTINGS) as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    if not isinstance(d, dict):
        return default
    key = machine or d.get("here") or "local"
    out = default
    for layer in ((d.get("everywhere") or {}).get("machine") or {}, ((d.get("machines") or {}).get(key) or {}).get("machine") or {}):
        if name in layer:
            out = layer[name]
    return out


def machine_name():
    """This machine's name as Herdr's window knows it (a pushed settings file's "here"), else None."""
    try:
        with open(SETTINGS) as f:
            return json.load(f).get("here") or None
    except (OSError, ValueError, AttributeError):
        return None
