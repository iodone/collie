"""Output: a task as JSON and as one line of text."""

import json

from .base import now
from .agents import (
    agent_running, detail, live_helpers, ask_reason, held_ask, last_words, own_line, own_work, status_word, STATUSES, task_status,
)


def view(s, task, live=None):
    known, live = live is not None, live if live is not None else []
    running = [k for k in live if agent_running(k)]
    v = dict(task)
    v["depends_on"] = list(task.get("depends_on") or [])
    v["key"] = s.key(task)
    v["folder"] = s.loc["folder"]
    v["status"], v["needs"], v["why"] = task_status(task, running)
    if v["needs"] == "asks":
        k = next((k for k in running if status_word(k) == "blocked"), None)
        st = k.get("status") if k and isinstance(k.get("status"), dict) else {}
        v["why"] = own_line(task, k and k["address"]) or (
            ask_reason(task, k["address"], held_ask(k["address"]), st.get("kind"), st.get("msg")) if k else v["why"]
        )
    if v["needs"] == "reply":
        v["why"] = own_line(task) or last_words(task)
    v["own_work"] = (
        v["status"] == "working" and task["state"] == "running" and bool(running)
        and all(status_word(k) in ("idle", "done") for k in running) and own_work(task, running)
    )
    if known:
        progress_clock(s, task, v["status"])
    v["report"] = report_of(task, v["status"])
    v["status_text"] = STATUSES[v["status"]]
    v["live"] = [
        {
            "address": k["address"],
            "status": (k.get("status") or {}).get("state") if isinstance(k.get("status"), dict) else k.get("status"),
            "tab": (k.get("labels") or {}).get("herdr.tab"),
            "role": (k.get("labels") or {}).get("herdr.role") or "worker",
        }
        for k in running
    ]
    v["subagents"] = subagents(s.key(task)) if known and running and task["state"] in ("running", "ready") else []
    v["ref"], v["prefix"] = s.ref(task), s.prefix
    return v


def subagent(k):
    """One live helper, without turning its role into a Task verdict."""
    labels = k.get("labels") or {}
    status = k.get("status")
    status = status.get("state") if isinstance(status, dict) else status
    cli = labels.get("herdr.agent") or ("codex" if "codex" in str(k.get("agent") or "") else "claude" if k.get("agent") else None)
    return {
        "address": k["address"], "parent": k.get("parent"), "role": labels.get("herdr.role") or "helper", "agent": cli,
        "name": k.get("name"), "status": "working" if status == "working" else "needs" if status == "blocked" else "done",
        "at": k.get("created_ms"),
    }


def subagents(key):
    return [subagent(detail(k)) for k in live_helpers(key)]


def progress_clock(s, task, status):
    """Pause the estimated-time clock while a task needs input."""
    progress = task.get("progress")
    if not progress or not s.write:
        return
    if status == "needs" and not progress.get("paused_at"):
        progress["paused_at"] = now()
        s.dirty = True
    elif status != "needs" and progress.get("paused_at"):
        progress["at"] = progress.get("at", now()) + now() - progress.pop("paused_at")
        s.dirty = True


def estimated(progress):
    return isinstance(progress.get("left"), (int, float))


def report_of(task, status):
    """The driver's latest progress; None outside running execution."""
    progress = task.get("progress")
    if not progress or status not in ("working", "needs") or task["state"] != "running":
        return None
    left = None
    if estimated(progress):
        remaining = max(0, progress["left"] - ((progress.get("paused_at") or now()) - progress.get("at", now())))
        left = 0 if remaining < 60000 else -(-remaining // 60000)
    return {"text": progress.get("text", ""), "done": progress.get("done"), "left": left, "paused": status == "needs"}


def minutes(number):
    return "<1m" if number < 1 else f"{number}m" if number < 60 else f"{round(number / 60)}h"


def say(args, data, text):
    if getattr(args, "json", False):
        print(json.dumps(data, indent=None))
    elif text:
        print(text)


def line(v):
    word = v.get("status_text") or v["state"]
    extra = v.get("why") or v.get("reason") or ""
    if v["status"] == "ready" and not extra:
        extra = v.get("branch") or ""
    elif v["status"] == "working" and v.get("report") and not extra:
        report = v["report"]
        extra = report["text"] + (f" · {report['done']}%" if report.get("done") is not None else "")
        extra += f" · ~{minutes(report['left'])} left" if report.get("left") is not None else ""
    return f"{v['ref']:<7} {word:<9} {v['title']}" + (f"  ({extra})" if extra else "")
