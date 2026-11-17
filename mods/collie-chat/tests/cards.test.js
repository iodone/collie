// mods/collie-chat's #22 parts, pure: reactions (core/send.js's tag line, core/chat-log.js's reading of it), secrets
// (core/secrets.js), the emoji picker's search and frecency (core/emoji.js), artifacts (core/chat-view.js
// resolveArtifacts()) and the rows over the box (core/bg-jobs.js, bgGroups(), subagentsOf()). No herdr here, so these
// run anywhere (bun test).
import { describe, expect, test } from "bun:test";

import { Conversation, excerpt, names } from "../core/chat-log.js";
import { reactionLine } from "../core/send.js";
import * as secrets from "../core/secrets.js";
import { frequent, used, withTone, found } from "../core/emoji.js";
import { artifactLine, bgGroups, published, resolveArtifacts, subagentsOf, subagentWord } from "../core/chat-view.js";
import { BgJobs, JOBS } from "../core/bg-jobs.js";

// A log record as core/chat-log.js's records() hands it over.
const rec = (off, line) => ({ off, kind: "L", data: JSON.stringify(line) });
const personSaid = (text) => ({ type: "user", timestamp: "2026-11-17T10:00:00.000Z", message: { content: text } });
const agentSaid = (text) => ({ type: "assistant", timestamp: "2026-11-17T10:00:01.000Z", message: { content: [{ type: "text", text }] } });

describe("reactions: a tag line to the agent, read back on the message it names", () => {
  test("the person's reaction lands on the agent's message, and comes off again", () => {
    const conv = new Conversation("claude");
    const said = "The build is green and the parser handles quotes.";
    conv.feed([rec(0, agentSaid(said))]);
    const id = conv.items.find((x) => x.kind === "agent").id;
    conv.feed([rec(100, personSaid(reactionLine("👍", said)))]);
    expect(conv.reactions.get(id)).toEqual([{ emoji: "👍", by: "you" }]);
    // nothing of the tag shows as a message of the person's
    expect(conv.items.filter((x) => x.kind === "user")).toHaveLength(0);
    conv.feed([rec(200, personSaid(reactionLine("👍", said, false)))]);
    expect(conv.reactions.get(id)).toEqual([]);
  });

  test("the agent's react tag lands on the person's message and never shows as its words", () => {
    const conv = new Conversation("claude");
    conv.feed([rec(0, personSaid("Ship it when the tests pass"))]);
    const id = conv.items.find((x) => x.kind === "user").id;
    conv.feed([rec(100, agentSaid('<hc react="👀" to="Ship it when the tests pass"/>'))]);
    expect(conv.reactions.get(id)).toEqual([{ emoji: "👀", by: "agent" }]);
    expect(conv.items.filter((x) => x.kind === "agent" && x.text)).toHaveLength(0);
  });

  test("the line names the message by its first words, quotes made curly, and reads back loosely", () => {
    const line = reactionLine("🎉", 'He said "ship it" and left');
    expect(line.startsWith('<hc from="person" reaction="🎉" to="')).toBe(true);
    expect(line).toContain("”");
    const to = /to="([^"]*)"/.exec(line)[1];
    expect(names('He said "ship it" and left, then came back', to)).toBe(true);
    expect(names("Something else entirely", to)).toBe(false);
    expect(excerpt("  a\n\nb   c  ", 9)).toBe("a b c");
    // a message may be named by a shorter start of the same words
    expect(names("Run the tests before you push", "Run the tests")).toBe(true);
  });
});

describe("core/secrets.js: asks by name, Collie's vault, never the value", () => {
  test("a terminal's labels say what it asks for", () => {
    expect(secrets.asksIn({
      "collie.secret.ask.OPENAI_KEY": "to call the API",
      "collie.secret.ask.DATABASE_URL": "-",
      "herdr.role": "coordinator",
      "collie.secret.ask.bad name": "x",
      "collie.secret.ask.EMPTY": "",
    })).toEqual([
      { name: "DATABASE_URL", why: "" },
      { name: "OPENAI_KEY", why: "to call the API" },
    ]);
    expect(secrets.asksIn(undefined)).toEqual([]);
  });

  test("the agent hears the name, kept or declined, never the value", () => {
    expect(secrets.keptLine("OPENAI_KEY")).toContain("Kept: OPENAI_KEY");
    expect(secrets.keptLine("OPENAI_KEY")).not.toContain("sk-");
    expect(secrets.declinedLine("OPENAI_KEY")).toContain("Declined: OPENAI_KEY");
  });

  test("the vault is Collie's own store, under the home it is given", () => {
    expect(secrets.vaultFile({ home: "/Users/me" })).toBe("/Users/me/.local/share/collie/secrets/vault.json");
    expect(secrets.vaultFile({ home: "/Users/me/" })).toBe("/Users/me/.local/share/collie/secrets/vault.json");
    expect(secrets.vaultFile({ home: "/Users/me", env: { COLLIE_SECRETS_HOME: "/tmp/v" } })).toBe("/tmp/v/vault.json");
    expect(secrets.vaultDir({ home: "/Users/me" })).not.toContain(".herdr");
    expect(secrets.vaultDir({ home: "/Users/me" })).not.toContain("shepherdr");
  });

  test("keeping one writes only that name; declining takes it out", () => {
    const first = secrets.kept(null, "OPENAI_KEY", "sk-1", "to call the API", 1000);
    const v = JSON.parse(first);
    expect(v.secrets.OPENAI_KEY).toEqual({ value: "sk-1", why: "to call the API", at: 1000 });
    expect(secrets.names(first)).toEqual(["OPENAI_KEY"]);
    expect(secrets.has(first, "OPENAI_KEY")).toBe(true);
    const both = secrets.kept(first, "DATABASE_URL", "postgres://x", "", 2000);
    expect(secrets.names(both)).toEqual(["DATABASE_URL", "OPENAI_KEY"]);
    // keeping it again replaces its value, never leaves two
    const again = secrets.kept(both, "OPENAI_KEY", "sk-2", "rotated", 3000);
    expect(JSON.parse(again).secrets.OPENAI_KEY.value).toBe("sk-2");
    expect(secrets.names(again)).toEqual(["DATABASE_URL", "OPENAI_KEY"]);
    const out = secrets.declined(again, "OPENAI_KEY");
    expect(secrets.names(out)).toEqual(["DATABASE_URL"]);
    // a broken or empty file reads as no secrets
    expect(secrets.names("not json")).toEqual([]);
    expect(secrets.names(null)).toEqual([]);
  });
});

describe("core/emoji.js: the picker's frecency, tones and search", () => {
  const H = 3600000;
  test("what the person reaches for first: often, and lately", () => {
    const uses = { "👍": { n: 3, t: [H, H, H] }, "🎉": { n: 1, t: [30 * H] }, "👀": { n: 2, t: [400 * H] } };
    expect(frequent(uses, 2, 2 * H)).toEqual(["👍", "👀"]);
    expect(frequent({}, 5)).toEqual([]);
    expect(used({}, "👍", 5)).toEqual({ "👍": { n: 1, t: [5] } });
    expect(used({ "👍": { n: 2, t: [1] } }, "👍", 2)["👍"]).toEqual({ n: 3, t: [2, 1] });
  });

  test("a tone sits right after a person's or a hand's emoji, and nowhere else", () => {
    expect(withTone("👍", 2)).toBe("👍🏼");
    expect(withTone("👍", 0)).toBe("👍");
    expect(withTone("☝️", 3)).toBe("☝🏽");
    expect(withTone("🎉", 3)).toBe("🎉");
  });

  test("a search finds an emoji by name or word, best first", () => {
    const groups = [{ name: "Smileys", list: [
      { e: "👍", name: "thumbs up", words: "thumbs up yes approve ok" },
      { e: "👎", name: "thumbs down", words: "thumbs down no" },
      { e: "🎉", name: "party popper", words: "party popper celebrate" },
    ] }];
    expect(found(groups, "thumbs").map((x) => x.e)).toEqual(["👍", "👎"]);
    expect(found(groups, "THUMBS_UP").map((x) => x.e)).toEqual(["👍"]);
    // a name that starts with the words comes before one that only has them
    expect(found(groups, "party").map((x) => x.e)).toEqual(["🎉"]);
    expect(found(groups, "celebrate").map((x) => x.e)).toEqual(["🎉"]);
    expect(found(groups, "nothing")).toEqual([]);
    expect(found(groups, "")).toEqual([]);
  });
});

describe("artifacts: a publish in the log is the artifact it made", () => {
  const arts = [
    { id: "coverage-1a2b", title: "Coverage", version: 2, versions: [
      { v: 1, at: 1000, publisher: "t7" }, { v: 2, at: 5000, publisher: "t7" }] },
    { id: "plan-3c4d", title: "Plan", version: 1, versions: [{ v: 1, at: 9000, publisher: "t9" }] },
  ];

  test("the first version this agent published near the call, latest publish the card", () => {
    const items = [{ kind: "artifact", id: "a1", at: 1200 }, { kind: "artifact", id: "a2", at: 5200 }];
    const got = resolveArtifacts(items, arts, "t7");
    expect(got.get("a1")).toMatchObject({ id: "coverage-1a2b", title: "Coverage", version: 2, v: 1, latest: false });
    expect(got.get("a2")).toMatchObject({ v: 2, latest: true });
    // another agent's publishes never count, and a version is taken once
    expect(resolveArtifacts([{ kind: "artifact", id: "x", at: 1000000 }], arts, "t7").size).toBe(0);
    expect(resolveArtifacts([{ kind: "artifact", id: "y", at: 8000 }], arts, "t9").get("y").id).toBe("plan-3c4d");
  });

  test("the words of a published artifact", () => {
    expect(published("Coverage", 2)).toBe("Published Coverage v2");
    expect(artifactLine(2)).toBe("Artifact · v2");
  });
});

describe("core/bg-jobs.js: what the agent left running", () => {
  const run = (out) => async () => ({ stdout: out });
  const claudeOutput = "/tmp/tasks/abc123.output";

  test("a look lists the output files a shell holds; the job's row carries its path", () => {
    const jobs = new BgJobs();
    const conv = { bg: [{ id: "c1", task: "abc123", kind: "shell", label: "bun test", cmd: "bun test", at: 1000 }] };
    expect(jobs.due("claude", conv, 10000)).toBe(true);
    jobs.read("claude", "42", `ok\nF ${claudeOutput}\n`, 5000);
    expect(jobs.list("claude", conv)).toEqual([{ id: "c1", task: "abc123", kind: "shell", label: "bun test", cmd: "bun test", at: 1000, path: claudeOutput }]);
    // no task id yet: vouched for only a minute
    expect(jobs.list("claude", { bg: [{ id: "c2", kind: "monitor", label: "watch", cmd: "watch", at: 1000 }] })).toHaveLength(1);
    const old = { bg: [{ id: "c3", kind: "monitor", label: "watch", cmd: "watch", at: 5000 - 120000 }] };
    expect(jobs.list("claude", old)).toHaveLength(0);
  });

  test("nothing to look at: no jobs, and no look due", () => {
    const jobs = new BgJobs();
    expect(jobs.due("claude", { bg: [] }, 10000)).toBe(false);
    expect(jobs.due("other", { bg: [] }, 10000)).toBe(false);
    expect(jobs.list("claude", { bg: [] })).toEqual([]);
    // a look that failed doesn't vouch for anything: the log alone says
    jobs.read("claude", "42", "no", 5000);
    expect(jobs.list("claude", { bg: [{ id: "c1", task: "abc123", at: 1000 }] })).toHaveLength(1);
  });

  test("a Codex shell shows once two looks have seen it, as cmdWords says it; a harness hook never counts", () => {
    const jobs = new BgJobs();
    const look = "ok\n77 42 sh -c 'bun test --watch'\n80 42 sh -c 'session-note.sh x'\n";
    jobs.read("codex", "42", look, 1000);
    expect(jobs.list("codex", null)).toEqual([]); // its first look only
    jobs.read("codex", "42", look, 6000);
    const list = jobs.list("codex", null);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "shell", pid: "77", cmd: "bun test --watch" });
  });

  test("stopping ends its processes; its output is the file's last lines", async () => {
    const jobs = new BgJobs();
    jobs.read("claude", "42", `ok\nF ${claudeOutput}\n`, 5000);
    const job = jobs.list("claude", { bg: [{ id: "c1", task: "abc123", at: 1000 }] })[0];
    let called = null;
    const r = await jobs.stop((script, args) => { called = args; return Promise.resolve({ stdout: "" }); }, "claude", "42", job);
    expect(r).toBe(true);
    expect(called).toEqual(["jobs", "stop", "claude", "42", "abc123"]);
    // its output file is no longer held: the row goes at once
    expect(jobs.list("claude", { bg: [{ id: "c1", task: "abc123", at: 1000 }] })).toHaveLength(0);
    expect(await jobs.stop(async () => ({}), "claude", "42", {})).toBe(false);
    const out = await jobs.output(run("line 1\nline 2\n\n"), job);
    expect(out).toBe("line 1\nline 2");
    expect(await jobs.output(run("x"), {})).toBe(null);
    expect(JOBS).toContain('alive)');
    expect(JOBS).toContain("tail -n 40");
  });
});

describe("core/chat-view.js: the rows over the box, grouped, and an agent's subagents", () => {
  test("one of a kind shows alone; two or more group by kind", () => {
    const one = bgGroups([{ id: "a", kind: "shell", at: 1 }]);
    expect(one).toHaveLength(1);
    expect(one[0].words).toBe(null);
    const two = bgGroups([{ id: "a", kind: "shell", at: 1 }, { id: "b", kind: "monitor", at: 2 }]);
    expect(two[0]).toMatchObject({ kind: "proc", words: "2 background processes", status: "working" });
    expect(two[0].newest.id).toBe("b");
    const sub = bgGroups([{ id: "s1", kind: "child", status: "working", at: 1 }, { id: "s2", kind: "child", status: "needs", at: 2 }]);
    expect(sub[0]).toMatchObject({ kind: "sub", words: "2 subagents", status: "needs" });
    expect(subagentWord("needs")).toBe("Needs you");
  });

  test("its hc helpers, by parent, oldest first; a task's worker or another agent never counts", () => {
    const terms = [
      { address: "t7", labels: { "herdr.role": "coordinator" } },
      { address: "t8", parent: "t7", labels: { "herdr.role": "reviewer", "herdr.agent": "codex" }, status: { state: "working" }, created_ms: 200 },
      { address: "t9", parent: "t7", labels: { "herdr.role": "helper" }, state: "ended", finished_ms: 300, created_ms: 100 },
      { address: "t10", parent: "t7", labels: { "herdr.role": "worker" }, status: { state: "working" }, created_ms: 50 },
      { address: "vm/t11", parent: "t8", labels: { "herdr.role": "helper" }, status: { state: "blocked" }, created_ms: 400 },
    ];
    // another machine's terminal names its parent on that machine ("vm/t8")
    const got = subagentsOf(terms, "vm/t8", 1000);
    expect(got.map((x) => x.address)).toEqual(["vm/t11"]);
    expect(got[0].title).toBe("Helper");
    expect(got[0].status).toBe("needs");
    const mine = subagentsOf(terms, "t7", 1000);
    expect(mine.map((x) => x.title)).toEqual(["Helper", "Reviewer · Codex"]);
    expect(mine[0]).toMatchObject({ status: "done", ended: 300 });
    // an ended one stays an hour
    expect(subagentsOf(terms, "t7", 300 + 3600001).map((x) => x.address)).toEqual(["t8"]);
    expect(subagentsOf(terms, null)).toEqual([]);
  });
});
