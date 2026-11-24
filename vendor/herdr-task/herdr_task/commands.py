"""Task execution commands and their worktree/driver behavior."""

import argparse
import json
import os
import re
import secrets
import time

from .base import Fail, git, now, run, STORE, VERSION
from .settings import (
    agent_argv, agent_key, bare, set_opts, settings_block, settings_for, space_base,
    task_settings, worker_argv, worktrees_on,
)
from .agents import (
    agent_running, detail, fit, LINE_MAX, live_agents, ready_turns, SUMMARY_MAX, WORKING_AGAIN,
)
from .sessions import refresh_sessions
from .launch import (
    base_ref, brief, caller_labels, caller_space, current_base, default_space, folder_for, handoff, launch, name_tabs,
    parent_for, resume_argv, retag_tabs, set_branch, tab_title, task_tabs,
)
from .store import is_task_list, locate, open_store, prefixes_in_use, read_list, Store, store_files
from .queues import parse_depends_on, queue_reason, set_depends_on
from .archive import unarchive
from .output import line, minutes, say, view
from .scheduler import ensure_scheduler
from .proof import evidence, find_proof
from .when import starts_words, when_from


# ---- commands -------------------------------------------------------------------------------

def cmd_where(args):
    loc = locate(args.folder)
    with Store(loc) as st:  # makes ~/.local/share/collie/tasks and moves old lists in
        pass
    slug, path = st.slug, st.path
    say(args, {**loc, "slug": slug, "store": path, "prefix": st.prefix, "version": VERSION}, f"{loc['folder']}\n{path}")


def cmd_list(args):
    if args.all:
        folders = [d["folder"] for d in map(read_list, store_files()) if is_task_list(d)]
    else:
        folders = [locate(args.folder)["folder"]]
    groups = []
    for folder in folders:
        if not os.path.isdir(folder):
            continue
        with Store(locate(folder)) as s:
            out = []
            archived = sum(1 for t in s.data["tasks"] if t.get("archived"))
            for t in s.data["tasks"]:
                if bool(t.get("archived")) != args.archived:
                    continue
                mine = live_agents(s.key(t)) if t["state"] in ("running", "ready") else []
                if mine:
                    refresh_sessions(s, t, mine)
                v = view(s, t, [detail(k) for k in mine] if mine else [])
                if getattr(args, "slim", False):
                    v = {k: v[k] for k in (
                        "id", "key", "ref", "title", "state", "created_at", "started_at", "ready_at", "done_at", "done_by",
                        "worktree", "branch", "base", "start", "base_set", "agents", "live", "depends_on",
                        "progress", "summary", "details", "proof", "space", "project",
                    ) if k in v}
                if t["state"] == "todo" and t.get("queued_at") and not t.get("scheduled_for"):
                    v["reason"] = queue_reason(s, t)
                out.append(v)
            if args.archived:
                out.sort(key=lambda v: -(v.get("archived") or 0))
            groups.append({"folder": s.loc["folder"], "name": s.loc["name"], "kind": s.loc["kind"], "tasks": out,
                           **({} if args.archived else {"archived": archived})})
    if args.json:
        print(json.dumps(groups if args.all else groups[0]))
        return
    for g in groups:
        if args.all:
            print(f"{g['name']}  {g['folder']}")
        for v in g["tasks"]:
            if v["state"] != "done" or args.all or args.archived:
                print(("  " if args.all else "") + line(v))
        hidden = sum(1 for v in g["tasks"] if v["state"] == "done") if not args.archived else 0
        more = [f"{hidden} done"] if hidden and not args.all else []
        if g.get("archived") and not args.all:
            more.append(f"{g['archived']} archived: --archived lists them")
        if more:
            print(f"({'; '.join(more)})")
        elif not g["tasks"] and not args.all:
            print("No archived tasks." if args.archived else "No tasks.")


def cmd_add(args):
    prompt = args.prompt or ""
    if args.prompt_file:
        with open(args.prompt_file) as f:
            prompt = f.read()
    at = scheduled_at(args)  # refused before anything is added
    with open_store(args) as s:
        repo = s.loc["kind"] == "repo"
        if args.worktree and not repo:
            raise Fail("Worktrees need a git repo; this folder isn't one.")
        # The person's setting wins: worktrees off for this repo means in the folder, --worktree or not.
        mode = "here" if args.here or not worktrees_on(s) else "worktree"
        t = s.new(args.title.strip(), prompt, mode)
        set_opts(t, args)
        space = bare(args.space) if args.space else caller_space()
        t["space"] = space or None
        set_base(s, t, args.base, space, new=True)
        set_branch(s, t, getattr(args, "branch", None))
        set_notes(t, args)
        if args.depends_on:
            set_depends_on(s, t, parse_depends_on(s, args.depends_on))
        if at:
            # Started later by the scheduler, with no caller to ask: its space is kept now.
            schedule(s, t, at, {"space": space or default_space()})
        v = view(s, t)
    if at:
        ensure_scheduler_quietly()
    say(args, {**v, **({"reason": starts_words(at, now())} if at else {})},
        s.ref(t) + (f": starts {starts_words(at, now())}" if at else ""))


# ---- scheduler metadata ----------------------------------------------------------------------
# A future start or a queue wait is metadata on a todo task, never another Task state.

def scheduled_at(args):
    """--at / --in as a moment (ms), or None when neither was given."""
    at, within = getattr(args, "at", None), getattr(args, "in_", None)
    if at is None and within is None:
        return None
    return when_from(at, within)


def schedule(s, t, at, plan=None):
    if t["state"] != "todo":
        raise Fail(f"{s.ref(t)} has already started; only a todo task can be scheduled.")
    t["scheduled_for"] = at
    if plan is not None:
        t["queue"] = plan
    for key in ("queued_at", "held"):
        t.pop(key, None)
    s.dirty = True


def unschedule(t):
    """Clear a future start without changing the todo state."""
    for key in ("scheduled_for", "queue", "queued_at", "held"):
        t.pop(key, None)


def ensure_scheduler_quietly():
    try:
        ensure_scheduler(quiet=True)
    except Exception:
        pass


def set_base(s, t, base, space=None, new=False):
    """--base: the branch a worktree task branches from and compares its delivery against.
    Without it a new task takes its space's base branch (Shepherdr settings > Tasks > Base branch,
    as Shepherdr's space.base: captured when added, so a later change only touches new tasks);
    unset, the folder's current branch, kept unmarked. "" goes back to the folder's."""
    if base is None:
        own = space_base(s, space) if new and t.get("mode") == "worktree" else ""
        main = s.loc["folder"]
        if own and own != current_base(main):
            try:
                base_ref(main, own)
            except Fail as e:
                raise Fail(f"This space's base branch is {own} (Shepherdr settings > Tasks > Base branch), but: {e} "
                           "Change the setting, or pass --base.")
            t["base"], t["base_set"], t["base_by"] = own, True, "space"
        return
    t.pop("base_by", None)
    base = base.strip()
    if t.get("worktree"):
        raise Fail(f"{s.ref(t)} already has its worktree from {t.get('base')}; its base can't change now.")
    if not base:
        t.pop("base", None)
        t.pop("base_set", None)
        return
    if t.get("mode") != "worktree":
        raise Fail("--base is for tasks in a worktree; this one works in the folder itself.")
    main = s.loc["folder"]
    base_ref(main, base)
    if base == current_base(main):
        t.pop("base", None)
        t.pop("base_set", None)
    else:
        t["base"], t["base_set"] = base, True


def set_notes(t, args):
    """--start-notes / --finish-notes: this task's own, replacing its folder's ("" goes back to the folder's)."""
    for which in ("start", "finish"):
        v = getattr(args, f"{which}_notes", None)
        if v is not None and v.strip():
            t[f"{which}_notes"] = v.strip()
        elif v is not None:
            t.pop(f"{which}_notes", None)


def cmd_show(args):
    with open_store(args) as s:
        t = s.find(args.id)
        live = [detail(k) for k in live_agents(s.key(t))]
        refresh_sessions(s, t, live)
        v = view(s, t, live)
        if t["state"] == "todo" and t.get("queued_at") and not t.get("scheduled_for"):
            v["reason"] = queue_reason(s, t)
        v["settings"] = task_settings(s, t)
        block = settings_block(s, t)
        if getattr(args, "evidence", False):
            v["evidence"] = evidence(s, t)
    text = [line(v), f"folder: {v['folder']}"]
    if v.get("worktree"):
        text.append(f"worktree: {v['worktree']} (branch {v['branch']}, base {v.get('base')})")
    elif v.get("branch") and v.get("mode") == "worktree":
        text.append(f"branch: {v['branch']} (set for this task)")
    if v.get("base_set"):
        text.append(f"base: {v['base']} (" + ("its space's base branch" if v.get("base_by") == "space" else "set for this task") + ")")
    if v.get("depends_on"):
        text.append("depends on: " + ", ".join(v["depends_on"]))
    if v.get("agents_md"):
        text.append(f"for AGENTS.md: {v['agents_md']}")
    if v.get("why") and v["status"] == "needs":
        text.append(f"needs the person: {v['why']}")
    if v.get("proof"):
        text.append(f"proof: {v['proof']['title']} ({v['proof']['id']})")
    if v.get("archived"):
        text.append(f"archived: {time.strftime('%Y-%m-%d %H:%M', time.localtime(v['archived'] / 1000))} (still kept; writing to it brings it back)")
    for k in v["live"]:
        text.append(f"agent: {k['address']} {k['status'] or ''}")
    if v.get("prompt"):
        text.append("\n" + v["prompt"].strip())
    text.append("\n" + block)
    say(args, v, "\n".join(text))


def begin(s, t, argv, space, parent=None):
    """Start the task's driver and record running execution facts."""
    t["state"], t["started_at"] = "running", now()
    t["ready_at"], t["done_at"], t["done_by"] = None, None, None
    for key in ("queue", "queued_at", "attention", "held", "scheduled_for", "ready_turns"):
        t.pop(key, None)
    if t.get("mode") == "worktree" and not t.get("worktree") and not worktrees_on(s, space):
        t["mode"] = "here"
    folder_for(s, t)
    parent = parent_for(parent, space)
    return launch(s, t, argv, space, brief(s, t, parent, space, argv), parent=parent)


def cmd_start(args):
    with open_store(args) as s:
        t = s.find(args.id)
        live = [k for k in map(detail, live_agents(s.key(t))) if agent_running(k)]
        if live:
            raise Fail(f"{s.ref(t)} is already running ({live[0]['address']}). Use switch to replace it.")
        if t["state"] not in ("todo", "running", "ready"):
            raise Fail(f"{s.ref(t)} is {t['state']}; only todo, running or ready tasks can start.")
        if args.here:
            t["mode"] = "here"
        elif args.worktree and worktrees_on(s):
            t["mode"] = "worktree"
        set_branch(s, t, getattr(args, "branch", None))
        q = t.get("queue") or {}
        space = bare(args.space) if args.space else (q.get("space") or t.get("space") or default_space())
        argv = agent_argv(None, args.argv) if args.argv else worker_argv(s, t, space, args.agent) if args.agent else \
            (q.get("argv") or worker_argv(s, t, space))
        parent = args.parent or q.get("parent")
        plan = {"argv": argv, "space": space, "parent": parent, **({"custom": True} if args.argv else {})}
        at = scheduled_at(args)
        reason = None
        resumed = False
        if at:
            schedule(s, t, at, plan)
            v = view(s, t)
            reason = "scheduled"
        elif t["state"] == "todo" and not args.now and (reason := queue_reason(s, t)):
            t["queued_at"] = now()
            t.pop("scheduled_for", None)
            t["queue"] = plan
            s.dirty = True
            v = view(s, t)
        elif t["state"] in ("running", "ready"):
            back_to_work(s, t, "rework" if t["state"] == "ready" else "restarted")
            a, resumed = start_again(s, t, space, args.agent, args.argv, parent=parent)
            v = view(s, t)
        else:
            a = begin(s, t, argv, space, parent)
            v = view(s, t)
    try:
        ensure_scheduler(quiet=True)
    except Exception:
        pass
    if reason == "scheduled":
        say(args, {**v, "reason": starts_words(at, now())}, f"{s.ref(t)} starts {starts_words(at, now())}.")
        return
    if reason:
        say(args, {**v, "reason": reason}, f"{s.ref(t)} will start when it can ({reason}).")
        return
    out = {**v, "terminal": a["address"], "space": space, "parent": a.get("parent"), "resumed": resumed}
    say(args, out, f"{s.ref(t)} started: {a['address']} in {folder_desc(t, s)}")


def folder_desc(t, s):
    return f"{t['worktree']} ({t['branch']})" if t.get("worktree") else s.loc["folder"]


def ready_words(args):
    """The ready summary in one line, refused past SUMMARY_MAX (as Shepherdr's) before anything
    changes; --details, any length, as written."""
    said = " ".join(str(args.summary or "").split())
    if len(said) > SUMMARY_MAX:
        raise Fail(f"That summary is {len(said)} characters: write a shorter one, {SUMMARY_MAX} at most, in plain words on "
                   f"what the person now sees or can do (no file names, flags or jargon). Put the detail in --details \"…\" "
                   f"(a few short bullets in plain words, folded in the Accept card) or in your proof, then run ready again.")
    return said, str(args.details or "").strip()


def cmd_ready(args):
    said, details = ready_words(args)
    if not said:
        raise Fail("ready needs --summary: say what this delivery achieved.")
    if not details:
        raise Fail("ready needs --details: record how the work was done and checked.")
    with open_store(args) as s:
        t = s.find(args.id)
        if t["state"] != "running":
            raise Fail(f"{s.ref(t)} is {t['state']}; only a running task can become ready.")
        me = os.environ.get("HC_TERMINAL_ID")
        if me and any(a["address"] == me for a in t["agents"]):
            refresh_sessions(s, t, [k for k in live_agents(s.key(t)) if k["address"] == me])
        worktree = t.get("worktree") if t.get("mode") == "worktree" else None
        if worktree and os.path.isdir(worktree):
            if git(worktree, "status", "--porcelain", "--untracked-files=no")[1]:
                raise Fail(f"{worktree} has uncommitted changes. Commit them, then run ready again.")
            t["head"] = git(worktree, "rev-parse", "HEAD")[1]
        proof = find_proof(s, t, getattr(args, "proof", None))
        if not proof:
            raise Fail("ready needs verifiable proof: publish a proof artifact, then pass --proof <its id>.")
        t["summary"] = said
        t["details"] = details or None
        t["proof"] = proof
        note = " ".join(str(args.agents_md or "").split())
        if note:
            t["agents_md"] = note[:300]
        for key in ("attention", "retry", "back"):
            t.pop(key, None)
        t["progress"] = None
        t["state"], t["ready_at"] = "ready", now()
        t["done_at"], t["done_by"] = None, None
        t["ready_turns"] = ready_turns(live_agents(s.key(t)))
        s.dirty = True
        v = view(s, t)
    say(args, v, f"{s.ref(t)} is ready. Proof: {proof['title']}.")























def parse_left(text):
    """Time left as an agent writes it: 5m, 90s, 1h, 1h30m, 2 (minutes); in ms."""
    t = str(text).strip().lower().replace(" ", "")
    if re.fullmatch(r"\d+(?:\.\d+)?", t):
        return int(float(t) * 60000)
    parts = re.findall(r"(\d+(?:\.\d+)?)(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)", t)
    if not parts or "".join(a + b for a, b in parts) != t:
        raise Fail(f"--left takes a time like 5m, 90s or 1h30m, not \"{text}\".")
    return int(sum(float(n) * {"h": 3600000, "m": 60000, "s": 1000}[u[0]] for n, u in parts))


def cmd_status(args):
    """A task agent says what it's doing, how far along it is and the time left, at the start and
    at each natural step (as Shepherdr's `shepherdr status`). Herdr guesses nothing: it shows
    what the agent said and counts the minutes down while it works."""
    text = " ".join(str(args.text or "").split())
    if not text:
        raise Fail("Say what you're doing: herdr-task status <id> \"Fixing the two failing tests\" --done 40 --left 5m")
    if args.done is not None and not 0 <= args.done <= 100:
        raise Fail("--done is a percentage, 0 to 100.")
    left = parse_left(args.left) if args.left else None
    with open_store(args) as s:
        t = s.find(args.id)
        if t["state"] != "running":
            raise Fail(f"{s.ref(t)} is {t['state']}; only a running task can report progress.")
        shown = fit(text)
        # set: when it was said ("at" moves on while it waits, for the minutes left).
        t["progress"] = {"text": shown, "at": now(), "set": now(), **({"done": args.done} if args.done is not None else {}),
                         **({"left": left} if left is not None else {})}
        s.dirty = True
        v = view(s, t, [detail(k) for k in live_agents(s.key(t))])
    note = f" Cut to {LINE_MAX} characters: \"{shown}\". Keep it shorter next time." if shown != text else ""
    # Every status gives the time left, a rough guess beats none (SHEP-13): one without it asks for it.
    if left is None:
        note += " Add --left with your best guess of the time left (like 20m) to every status."
    say(args, {**v, "cut": shown != text}, f"{s.ref(t)}: {shown}" + (f" · {args.done}%" if args.done is not None else "")
        + (f" · ~{minutes(round(left / 60000))} left" if left is not None else "") + "." + note)


ALERT = "herdr.alert"


def cmd_alert(args):
    """An agent tells the person something that can't wait (as Shepherdr's `shepherdr alert`): a
    toast and a sound in every Herdr window. Never asks permission. A task's agent (or an alert
    --task names) always reaches the person; an Assistant's follows its space's Notify (Off:
    nothing). It sets the core label herdr.alert on the caller's own terminal, which every Herdr
    client sees at once, here or on another machine; Herdr shows each new one once (inbox.js)."""
    title, body = " ".join(str(args.title or "").split()), " ".join(str(args.body or "").split())
    if not title:
        raise Fail("Say what can't wait: herdr-task alert \"Deploy is down\" --body \"Checks fail on main since 12:40\"")
    if len(title) > 240 or len(body) > 4000:
        raise Fail("Keep an alert short: a title and a line or two of why.")
    me = os.environ.get("HC_TERMINAL_ID")
    if not me:
        raise Fail("Run it from an agent's own terminal (there's no HC_TERMINAL_ID here).")
    labels = caller_labels()
    ref = None
    if args.task:
        with open_store(argparse.Namespace(folder=args.folder, id=args.task), write=False) as s:
            ref = s.ref(s.find(args.task))
    elif labels.get("herdr.task"):
        # Its own task: "<slug>#<n>" -> HERD-44, from that list's prefix.
        slug, _, n = labels["herdr.task"].rpartition("#")
        try:
            with open(os.path.join(STORE, f"{slug}.json")) as f:
                pre = json.load(f).get("prefix")
        except (OSError, ValueError):
            pre = None
        ref = f"{pre}-{n}" if pre else None
    # The label holds what a toast shows (inbox.js cuts it again to fit).
    alert = {"id": secrets.token_hex(4), "at": now(), "title": title[:120], "body": body[:300],
             **({"task": ref} if ref else {}), **({"about": True} if args.task else {})}
    r = run(["hc", "label", me, f"{ALERT}={json.dumps(alert, ensure_ascii=False, separators=(',', ':'))}"])
    if r.returncode != 0:
        raise Fail((r.stderr or r.stdout).strip() or "hc label failed")
    say(args, alert, "Alert sent.")


def back_to_work(s, t, why, said=WORKING_AGAIN):
    """Move a ready task to running for explicit rework; its next delivery needs a new ready call."""
    if t["state"] != "ready":
        return False
    t["state"], t["started_at"] = "running", now()
    t["ready_at"], t["done_at"], t["done_by"] = None, None, None
    t["summary"], t["details"], t["proof"] = None, None, None
    t.pop("ready_turns", None)
    t["back"] = {"at": now(), "why": why}
    t["progress"] = {"text": fit(said), "at": now(), "set": now(), "by": "herdr"}
    s.dirty = True
    return True











def cmd_unarchive(args):
    with open_store(args) as s:
        t = s.find(args.id)
        was = bool(t.get("archived"))
        unarchive(s, t)
        v = view(s, t)
    say(args, v, f"{s.ref(t)} is back in its list." if was else f"{s.ref(t)} isn't archived.")


def cmd_edit(args):
    with open_store(args) as s:
        t = s.find(args.id)
        old = t["title"]
        if args.title is not None:
            t["title"] = args.title.strip() or t["title"]
        if args.prompt is not None:
            t["prompt"] = args.prompt
        if args.prompt_file:
            with open(args.prompt_file) as f:
                t["prompt"] = f.read()
        pick = [t.get(k) for k in ("agent", "model", "effort")]
        set_opts(t, args)
        if [t.get(k) for k in ("agent", "model", "effort")] != pick:
            # The next agent started for it runs on the new choice (start_again), a queued one too.
            t["pick_at"] = now()
            q = t.get("queue") or {}
            if q.get("argv") and not q.get("custom"):
                q["argv"] = worker_argv(s, t, q.get("space"))
        set_base(s, t, args.base)
        set_notes(t, args)
        if args.depends_on is not None:
            set_depends_on(s, t, parse_depends_on(s, args.depends_on))
        at = scheduled_at(args) if (args.at or "").strip() or args.in_ is not None else None
        if at:
            schedule(s, t, at)
        elif args.at is not None:
            unschedule(t)  # --at "": back to To do
        if args.here or args.worktree:
            if t["state"] != "todo":
                raise Fail("Where a task works can only change before it starts.")
            if args.worktree and s.loc["kind"] != "repo":
                raise Fail("Worktrees need a git repo.")
            t["mode"] = "here" if args.here else "worktree"
        if t["mode"] != "worktree" and not t.get("worktree"):
            t.pop("branch", None)
        set_branch(s, t, getattr(args, "branch", None))
        s.dirty = True
        tabs = task_tabs(s, t) if t["title"] != old else []
        v = view(s, t)
    left = name_tabs([(tab, tab_title(s, t)) for tab in tabs])
    if at:
        ensure_scheduler_quietly()
    say(args, {**v, "rename": left}, f"{s.ref(t)} saved" + (f": starts {starts_words(at, now())}." if at else "."))


def cmd_config(args):
    with open_store(args) as s:
        cfg = s.data.setdefault("config", {})
        tabs = False
        if args.prefix is not None:
            new = args.prefix.strip().upper()
            if not re.fullmatch(r"[A-Z]{2,5}", new):
                raise Fail("A prefix is 2 to 5 letters, like HAT.")
            owner = prefixes_in_use(s.path).get(new)
            if owner:
                raise Fail(f"{new} is taken by {owner}.")
            if new != s.prefix:
                s.data["prefix"] = new
                s.dirty = tabs = True
        out = {"folder": s.loc["folder"], "prefix": s.prefix, "max_running": s.max_running(), "settings": settings_for(s),
               "worktrees": worktrees_on(s)}
    out["rename"] = retag_tabs(s) if tabs else []
    n = out["max_running"]
    where = "a worktree each" if out["worktrees"] else "in the folder itself"
    say(args, out, f"{out['folder']}: tasks {out['prefix']}-n, at most {n} at once, {where}.")


def cmd_rm(args):
    with open_store(args) as s:
        t = s.find(args.id)
        ref = s.ref(t)
        s.data["tasks"].remove(t)
        for other in s.data["tasks"]:
            other["depends_on"] = [dep for dep in other.get("depends_on") or [] if dep != ref]
        s.dirty = True
    note = f" Its worktree {t['worktree']} is still there." if t.get("worktree") and os.path.isdir(t["worktree"]) else ""
    say(args, {"id": t["id"], "removed": True}, f"{s.ref(t)} removed.{note}")


def last_agent(t):
    return t["agents"][-1] if t["agents"] else None


def start_again(s, t, space, key=None, argv_json=None, message=None, parent=None):
    """Starts an agent for the task: the last agent's own session when it's the same kind of agent
    and the session is known; else a fresh one with a handoff. `message` goes after either."""
    unarchive(s, t)
    prev = last_agent(t)
    parent = parent_for(parent or (prev or {}).get("parent"), space)
    # The last agent's argv again, unless the task's agent, model or effort changed since (edit).
    keep = prev and prev.get("argv") and (t.get("pick_at") or 0) <= (prev.get("at") or 0)
    argv = agent_argv(None, argv_json) if argv_json else worker_argv(s, t, space, key) if key else \
        (prev["argv"] if keep else worker_argv(s, t, space))
    same = prev and agent_key(argv) == prev.get("agent")
    res = resume_argv(argv, prev["session"]) if same and prev.get("session") else None
    if res:
        return launch(s, t, argv, space, message, parent=parent, resume=res), True
    text = handoff(s, t, prev, parent, argv) + (("\n\n" + message) if message else "")
    return launch(s, t, argv, space, text, parent=parent), False


def cmd_switch(args):
    with open_store(args) as s:
        t = s.find(args.id)
        live = [k for k in map(detail, live_agents(s.key(t))) if agent_running(k)]
        refresh_sessions(s, t, live)
        old = live[-1] if live else None
        labels = (old or {}).get("labels") or {}
        space = (labels.get("herdr.task.space") or labels.get("herdr.space") or (bare(args.space) if args.space else None)
                 or t.get("space") or default_space())
        if t["state"] not in ("running", "ready"):
            raise Fail(f"{s.ref(t)} is {t['state']}; only running or ready tasks can switch agents.")
        back_to_work(s, t, "agent switched")
        a, resumed = start_again(s, t, space, args.agent, args.argv, parent=args.parent)
        v = view(s, t)
    ended = []
    if old and not args.keep:
        # The new agent took over: end the old one (its terminal, shell and all).
        run(["hc", "kill", old["address"]])
        ended.append(old["address"])
    say(args, {**v, "terminal": a["address"], "space": space, "parent": a.get("parent"), "resumed": resumed, "ended": ended},
        f"{s.ref(t)}: {a['agent']} {a['address']} {'resumed its session' if resumed else 'took over'}" + (f", {old['address']} ended" if ended else ""))


def complete(s, t, done_by):
    """Finalize execution facts only; delivery is owned by the playbook/Decision."""
    t["state"], t["done_at"], t["done_by"] = "done", now(), done_by
    t["progress"] = None
    for key in ("queue", "queued_at", "scheduled_for", "held", "ready_turns", "attention", "retry", "back"):
        t.pop(key, None)
    s.dirty = True


def cmd_accept(args):
    with open_store(args) as s:
        t = s.find(args.id)
        if t["state"] != "ready":
            raise Fail(f"{s.ref(t)} is {t['state']}; only a ready task can be accepted.")
        complete(s, t, args.done_by)
        v = view(s, t)
    say(args, v, f"{s.ref(t)} accepted: done.")


def cmd_done(args):
    with open_store(args) as s:
        t = s.find(args.id)
        if t["state"] == "done":
            raise Fail(f"{s.ref(t)} is already done.")
        complete(s, t, args.done_by)
        v = view(s, t)
    say(args, v, f"{s.ref(t)} is done.")
