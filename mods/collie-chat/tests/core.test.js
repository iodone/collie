// mods/collie-chat's pure parts: a slot's agent label, the argv a Coordinator starts with, a template's front matter,
// and the rows' words. No herdr here, so these run anywhere (bun test).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { CHAT, SLOT, chatLabel, chatPane, machineOf, slotOf } from "../core/spaces.js";
import { argvFor, freshArgv, sessionOf } from "../core/agents.js";
import { parseTemplate } from "../core/template.js";
import { briefLabel, clock, dayLabel, dayOf, firstKeys, firstUser, initialOf, literal, lostMessage, LOST, shellWord, newsWords, newsLine } from "../core/chat-view.js";
import { words, allow, deny, answer, dismiss, howAnswered } from "../core/asks.js";
import { Conversation } from "../core/chat-log.js";

describe("core/spaces.js: the chat pane a slot's agent is parked behind", () => {
  test("herdr.chat holds the pane's own id; a machine's address reads the same", () => {
    expect(CHAT).toBe("herdr.chat");
    expect(SLOT).toBe("herdr.chat.slot");
    expect(chatLabel("vm/t12")).toBe("t12");
    expect(chatLabel(null)).toBe("");
    expect(chatPane({ address: "t3", labels: { "herdr.chat": "t3" } })).toBe("t3");
    expect(chatPane({ address: "vm/t3", labels: { "herdr.chat": "t9" } })).toBe("vm/t9");
    expect(chatPane({ address: "t3" })).toBe(null);
    expect(slotOf({ labels: { "herdr.chat.slot": "coord-space-1-ab" } })).toBe("coord-space-1-ab");
    expect(machineOf("vm/t3")).toBe("vm");
    expect(machineOf("t3")).toBe(null);
  });
});

describe("core/agents.js: how a Coordinator is started", () => {
  test("a chosen Claude starts on that model, effort and permission", () => {
    const { argv, resume } = argvFor({ agent: "claude", model: "sonnet", effort: "high", fast: false, perm: "plan" }, { agent: null, argv: [] });
    expect(resume).toBe(false);
    expect(argv.slice(0, 2)).toEqual(["claude", "--model"]);
    expect(argv).toContain("sonnet");
    expect(argv).toContain("--effort");
    expect(argv).toContain('{"fastMode":false}');
    expect(argv.slice(-2)).toEqual(["--permission-mode", "plan"]);
  });

  test("a chosen Codex says its tier, and its permission as sandbox + approvals", () => {
    const { argv } = argvFor({ agent: "codex", model: "gpt-6", effort: "low", fast: true, perm: "read-only" }, { agent: null, argv: [] });
    expect(argv[0]).toBe("codex");
    expect(argv).toContain("--no-daemon");
    expect(argv).toContain('service_tier="fast"');
    expect(argv.slice(-4)).toEqual(["-s", "read-only", "-a", "on-request"]);
  });

  test("the same agent resumes its session; another agent starts fresh", () => {
    const old = { agent: "claude", argv: ["claude", "--add-dir", "/repo"], session: "abc-123" };
    const same = argvFor({ agent: "claude", perm: "plan" }, old);
    expect(same.resume).toBe(true);
    expect(same.argv.slice(-2)).toEqual(["--resume", "abc-123"]);
    expect(same.argv).toContain("--add-dir");
    const other = argvFor({ agent: "codex", perm: "read-only" }, old);
    expect(other.resume).toBe(false);
    expect(other.argv).not.toContain("--add-dir");
  });

  test("freshArgv drops what resumed a session, and a first message with it", () => {
    expect(freshArgv("claude", ["claude", "--permission-mode", "plan", "--resume", "abc", "do the thing"]))
      .toEqual(["claude", "--permission-mode", "plan"]);
    expect(freshArgv("claude", ["claude", "--model", "opus"])).toBe(null);
    expect(freshArgv("codex", ["codex", "resume", "abc", "--no-daemon"])).toEqual(["codex", "--no-daemon"]);
    expect(sessionOf("claude", "/x/9f1c0d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.jsonl")).toBe("9f1c0d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f");
  });
});

describe("core/template.js: a role template's front matter and words", () => {
  test("the shipped collie-coordinator template starts claude with its body as the first message", () => {
    const src = readFileSync(new URL("../../../templates/collie-coordinator.md", import.meta.url), "utf8");
    const { name, command, body } = parseTemplate(src);
    expect(name).toBe("collie-coordinator");
    expect(command).toBe("claude");
    expect(body.startsWith("# Coordinator")).toBe(true);
    expect(body).not.toContain("---\nname:");
  });

  test("a file without front matter is all words, no command", () => {
    expect(parseTemplate("just words")).toEqual({ head: "", body: "just words", command: null, name: null });
  });
});

describe("core/chat-view.js: the rows' words", () => {
  test("a first message started from the template is its own quiet row", () => {
    const items = [{ kind: "tools" }, { kind: "user", text: "the template's words" }, { kind: "agent", text: "ok" }];
    const first = firstUser(items);
    expect(first).toBe(1);
    expect(briefLabel(items[1], 1, { start: 0, template: "collie-coordinator", first })).toBe("New session");
    expect(briefLabel({ kind: "user", text: "From HERD-4 (t3): hi", from: "t3" }, 3, { start: 0, template: "collie-coordinator", first })).toBe("Message from HERD-4");
    expect(briefLabel(items[1], 2, { start: 0, template: "collie-coordinator", first })).toBe(null);
    expect(briefLabel(items[1], 1, { start: 100, template: "collie-coordinator", first })).toBe(null);
  });

  test("a gone session's handover carries the template's words again", () => {
    const msg = lostMessage({ template: "---\nname: x\n---\n# Coordinator\nDo the thing.\n" });
    expect(msg.startsWith("<restart>")).toBe(true);
    expect(msg.endsWith("# Coordinator\nDo the thing.")).toBe(true);
  });

  test("LOST reads both CLIs' words for a gone session", () => {
    expect(LOST.test("No conversation found with session ID: abc")).toBe(true);
    expect(LOST.test("ERROR: No saved session found with ID abc")).toBe(true);
    expect(LOST.test("Working…")).toBe(false);
  });

  test("times and first keys", () => {
    const now = new Date(2026, 10, 17, 14, 5);
    expect(dayLabel(now.getTime(), now)).toBe("Today");
    expect(dayLabel(now.getTime() - 864e5, now)).toBe("Yesterday");
    expect(clock(now.getTime(), now)).toBe("14:05");
    expect(dayOf(now.getTime())).toBe(dayOf(now.getTime()));
    expect(firstKeys({ slot: "s", labels: { "herdr.chat.origin": "o" }, addr: "t1" })).toEqual(["s", "o", "t1"]);
    expect(literal("<yours> & <b>")).toBe("\\<yours> & \\<b>");
    expect(shellWord("a b")).toBe("'a b'");
    expect(initialOf("coord-2")).toBe("C");
  });
});

describe("core/asks.js: what Claude asks, and the hook's answers", () => {
  test("a permission, a question and a plan each say what they are", () => {
    const run = words({ tool_name: "Bash", cwd: "/repo", tool_input: { command: "npm test" } });
    expect(run.kind).toBe("permission");
    expect(run.title).toBe("Run: npm test");
    expect(run.detail).toContain("npm test");
    const plan = words({ tool_name: "ExitPlanMode", tool_input: { plan: "1. do it\n2. ship it" } });
    expect(plan.kind).toBe("plan");
    expect(plan.title).toBe("Plan to approve");
    expect(plan.detail).toContain("ship it");
    const ask = words({ tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A (Recommended)" }, { label: "B", description: "the second" }] }] } });
    expect(ask.kind).toBe("questions");
    expect(ask.title).toBe("Which?");
    expect(ask.questions[0].options[0]).toMatchObject({ name: "A", recommended: true });
    expect(ask.questions[0].options[1].description).toBe("the second");
  });

  test("answers are the hook's own decision JSON", () => {
    expect(JSON.parse(allow()).hookSpecificOutput.decision.behavior).toBe("allow");
    expect(JSON.parse(deny("no")).hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "no" });
    const a = JSON.parse(answer({ tool_input: { questions: [{ question: "Which?" }] } }, "A"));
    expect(a.hookSpecificOutput.decision.updatedInput.answers).toEqual({ "Which?": "A" });
    expect(JSON.parse(dismiss("questions")).hookSpecificOutput.decision.behavior).toBe("deny");
    expect(howAnswered({ words: { kind: "permission" } }, allow(), "in the chat")).toBe("Allowed in the chat");
    expect(howAnswered({ words: { kind: "questions" } }, answer({ tool_input: { questions: [{ question: "Q" }] } }, "A"), "in the chat")).toBe("Answered in the chat");
    expect(howAnswered({ words: { kind: "permission" } }, "", "in the chat")).toBe(null);
  });
});

describe("core/chat-view.js: task news as a slim line", () => {
  test("a Claude message's <herdr-news> line becomes a news item", () => {
    const conv = new Conversation("claude");
    const line = { type: "user", message: { content: '<herdr-news task="HAT-4" event="needs-you">HAT-4 needs you: which branch? (Fix the parser)</herdr-news>' } };
    conv.feed([{ off: 0, kind: "L", data: JSON.stringify(line) }]);
    const news = conv.items.find((x) => x.kind === "news");
    expect(news).toMatchObject({ ref: "HAT-4", event: "needs-you" });
    expect(newsLine(news)).toBe("HAT-4 needs you · which branch?");
    expect(conv.items.some((x) => x.kind === "user" && x.text?.includes("herdr-news"))).toBe(false);
  });

  test("needs-you, ready and done keep the task's own words", () => {
    const needs = { ref: "HAT-4", event: "needs-you", text: "HAT-4 needs you: which branch? (Fix the parser)" };
    expect(newsWords(needs)).toMatchObject({ mark: "needs", what: "needs you", text: "which branch?" });
    expect(newsLine(needs)).toBe("HAT-4 needs you · which branch?");
    const ready = { ref: "HAT-4", event: "ready", text: "HAT-4 is ready: Fix the parser · For AGENTS.md: run tests" };
    expect(newsWords(ready, { title: "Fix the parser" })).toMatchObject({ mark: "ready", what: "ready", text: "Fix the parser" });
    expect(newsLine({ ref: "HAT-5", event: "done", text: "HAT-5 done: Ship it (Ship it)" }, { title: "Ship it" })).toBe("HAT-5 done · Ship it");
    const started = { ref: "HAT-6", event: "started", text: "HAT-6 started: On it (Do the thing)" };
    expect(newsWords(started)).toMatchObject({ mark: "started", what: "started", text: "On it" });
  });
});
