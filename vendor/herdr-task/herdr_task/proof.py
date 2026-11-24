"""A task's proof and what its Accept card shows (as Shepherdr's merge card): the proof artifact
its agent made, and the evidence from Git, GitHub and that artifact, never the agent's own words
(only its summary)."""

import hashlib
import json
import os
import re

from .base import Fail, HOME, git

ARTIFACTS = os.environ.get("COLLIE_ARTIFACTS_HOME") or os.path.join(HOME, ".local/share/collie/artifacts")
# Files named on the card, and commits.
FEW = 3


def artifacts_of(folder):
    """This folder's artifacts, newest first (collie-artifact's list for it; the same slug rule)."""
    rel = os.path.relpath(folder, HOME) if folder == HOME or folder.startswith(HOME + "/") else folder
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", "home" if rel == "." else rel.strip("/")).strip("-") or "root"
    for name in (slug, f"{slug}-{hashlib.sha1(folder.encode()).hexdigest()[:6]}"):
        try:
            with open(os.path.join(ARTIFACTS, name + ".json")) as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        if d.get("folder") in (None, folder):
            return d.get("artifacts") or []
    return []


def find_proof(s, t, given=None):
    """The explicitly bound proof artifact, {id, title}: --proof selects it directly; otherwise
    the newest artifact for this canonical task ref with Proof in its title. A proof is always a
    recipe (the person accepts from their phone too): a custom panel is refused."""
    arts = artifacts_of(s.loc["folder"])
    if given:
        a = next((a for a in arts if a.get("id") == given.strip()), None)
        if not a:
            raise Fail(f"No artifact {given} in {s.loc['folder']} (collie-artifact list shows them).")
    else:
        ref = s.ref(t).upper()
        mine = [a for a in arts if (a.get("task") or "").upper() == ref and re.search(r"\bproof\b", a.get("title") or "", re.I)]
        a = mine[0] if mine else None
    if not a:
        return None
    files = a.get("files") or []
    if "main.js" in files or "recipe.json" not in files:
        raise Fail(f"Your proof {a['id']} is a custom panel, which the person can't open on their phone. Make it a recipe "
                   f"(recipe.json; `collie-artifact guide`, A task's proof), `collie-artifact update {a['id']} <dir>`, then run ready again.")
    return {"id": a["id"], "title": a.get("title") or a["id"]}


def task_artifacts(s, t, proof=None):
    """Other artifacts explicitly bound to this canonical task ref, newest first."""
    ref, skip = s.ref(t).upper(), (proof or {}).get("id")
    return [{"id": a["id"], "title": a.get("title") or a["id"]} for a in artifacts_of(s.loc["folder"])
            if a.get("id") and a["id"] != skip and (a.get("task") or "").upper() == ref]


def numstat(out, files):
    """git --numstat lines added into files {path: [added, removed]} (binary files count 0)."""
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            a, r, path = parts
            cur = files.setdefault(path, [0, 0])
            cur[0] += int(a) if a.isdigit() else 0
            cur[1] += int(r) if r.isdigit() else 0





def evidence(s, t):
    """What an Accept card shows: {summary, details, commits: {count, list}, diff: {files, added, removed,
    list} or None, git (False: not a git folder), scope, checks, proof, artifacts (its others)}."""
    main, out = s.loc["folder"], {"summary": t.get("summary"), "details": t.get("details"), "proof": t.get("proof") or find_proof(s, t)}
    out["artifacts"] = task_artifacts(s, t, out["proof"])
    commits, files = [], {}
    fmt = "--format=%h%x09%s"
    if s.loc["kind"] != "repo":
        out.update(git=False, commits={"count": 0, "list": []}, diff=None)
        return out
    if t.get("mode") == "worktree" and t.get("branch"):
        # Its branch past where it meets its base: exactly what Accept merges.
        ok, tip, _ = git(main, "rev-parse", "--verify", "--quiet", f"refs/heads/{t['branch']}")
        tip = tip if ok and tip else t.get("head")
        base = t.get("base") or "main"
        since = base if git(main, "rev-parse", "--verify", "--quiet", base)[0] else t.get("start")
        if tip and since:
            ok, log, _ = git(main, "log", fmt, f"{since}..{tip}")
            commits = [line.split("\t", 1) for line in log.splitlines() if "\t" in line] if ok else []
            ok, diff, _ = git(main, "diff", "--numstat", f"{since}...{tip}")
            if ok:
                numstat(diff, files)
            else:
                files = None
        out["scope"] = f"{t['branch']} into {base}"
    else:
        # In the folder itself: the commits made here while it worked (other work committed here
        # meanwhile counts too, so the card says "while it worked").
        start, end = (t.get("started_at") or 0) // 1000, ((t.get("ready_at") or 0) // 1000 + 60) or None
        rng = [f"--since=@{start}"] + ([f"--until=@{end}"] if end else [])
        ok, log, _ = git(main, "log", fmt, *rng)
        commits = [line.split("\t", 1) for line in log.splitlines() if "\t" in line] if ok else []
        ok, diff, _ = git(main, "log", "--numstat", "--format=", *rng)
        if ok:
            numstat(diff, files)
        else:
            files = None
        out["scope"] = "committed here while it worked"
    out["git"] = True
    out["commits"] = {"count": len(commits), "list": [{"sha": c[0], "subject": c[1]} for c in commits[:FEW]]}
    out["diff"] = None if files is None else {
        "files": len(files), "added": sum(v[0] for v in files.values()), "removed": sum(v[1] for v in files.values()),
        "list": [{"path": p, "added": v[0], "removed": v[1]} for p, v in sorted(files.items(), key=lambda x: -(x[1][0] + x[1][1]))[:FEW]]}
    return out
