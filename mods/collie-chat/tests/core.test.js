// mods/collie-chat's pure parts: a slot's agent label, the argv a Coordinator starts with, a template's front matter,
// and the rows' words. No herdr here, so these run anywhere (bun test).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { CHAT, SLOT, chatLabel, chatPane, machineOf, slotOf } from "../core/spaces.js";
import { argvFor, freshArgv, sessionOf } from "../core/agents.js";
import { parseTemplate } from "../core/template.js";
import { briefLabel, clock, dayLabel, dayOf, firstKeys, firstUser, initialOf, literal, lostMessage, LOST, shellWord } from "../core/chat-view.js";

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
