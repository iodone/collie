import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { coordinatorConfig, runCoordinator } from "../plugins/agent/coordinator.ts";
import { InboxService } from "../service/main.ts";
import { mergeCoordinator } from "../lib/inbox-settings.js";

const ruleset = await Bun.file(new URL("../protocol/fixtures/ruleset.json", import.meta.url)).json();
const paths: string[] = [];
const scratch = () => { const path = mkdtempSync(join(tmpdir(), "collie-host-")); paths.push(path); return path; };
afterEach(() => { while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true }); });
const rolePromptRef = resolve(new URL("../templates/collie-coordinator.md", import.meta.url).pathname);

function agent() {
  const calls: string[][] = [];
  return { calls, run: async (args: string[]) => {
    calls.push(args);
    if (args[0] === "add") return { id: 42, key: "HAT-42" };
    if (args[0] === "start") return { id: 42, state: "running" };
    return {
      id: 42, key: "HAT-42", state: "ready", started: 1_763_664_030_000, ready_at: 1_763_666_480_000,
      evidence: { summary: "完成", details: "- 已复核", commits: { list: [["abc1234", "build"]] }, proof: { id: "proof-1", title: "tests passed" } },
      reviews: [{ result: "report", by: "t99", head: "abc1234" }],
    };
  } };
}

describe("Coordinator Host", () => {
  test("space 覆盖 Everywhere，未配置不静默换 CLI", () => {
    const settings = {
      everywhere: { coordinator: { cli: "codex", model: "default", effort: "high" } },
      spaces: { alpha: { coordinator: { cli: "claude", effort: "medium" } } },
    };
    expect(coordinatorConfig(settings, "alpha")).toEqual({ cli: "claude", model: "default", effort: "medium" });
    expect(() => coordinatorConfig({}, "alpha")).toThrow("needs coordinator.cli");
  });

  test("Inbox 设置保留 space 覆盖，并校验 CLI / effort", () => {
    const current = { spaces: { alpha: { coordinator: { cli: "claude" } } } };
    const next = mergeCoordinator(current, { cli: "codex", model: "default", effort: "high" });
    expect(next.spaces).toEqual(current.spaces);
    expect(next.everywhere.coordinator.cli).toBe("codex");
    expect(() => mergeCoordinator({}, { cli: "other", model: "default", effort: "high" })).toThrow("claude or codex");
    expect(() => mergeCoordinator({}, { cli: "codex", model: "default", effort: "extreme" })).toThrow("invalid effort");
  });

  test("headless 输出 Decision 与 session，resume 使用原 session", async () => {
    const calls: any[] = [];
    const result = await runCoordinator({
      instruction: { role_prompt_ref: rolePromptRef, output_contract: "urn:collie:decision:v1" },
    }, { cli: "codex" }, {
      session: "session-1",
      run: async (input) => {
        calls.push(input);
        return JSON.stringify({ session_id: "session-1", result: JSON.stringify({ state: "routed", why: "构建", actions: [{ kind: "noop", risk_tags: [] }] }) });
      },
    });
    expect(calls[0].command).toBe("codex");
    expect(calls[0].args.slice(0, 4)).toEqual(["exec", "resume", "session-1", "--json"]);
    expect(result.session).toBe("session-1");
    expect(result.decision.why).toBe("构建");
  });

  test("New / Build 走 chat_turn，不占 job 预算，并实际 spawn", async () => {
    const dir = scratch();
    const worker = agent();
    const service = new InboxService({
      stateDir: dir, ruleset, rolePromptRef,
      workspaces: { "collie": { folder: "/repo/collie", cli: "codex" } },
      agent: { run: worker.run },
      decide: () => ({ state: "routed", why: "人主动发起构建", actions: [{ kind: "spawn_task", risk_tags: [], spawn: {
        title: "Build request", brief_ref: "/tmp/brief.md", base: "current", review: true, merge: false, access: "edit", tells: "needed",
      } }] }),
    });
    const decision = await service.request("collie", "实现 New Build", ["COLLIE-42"]);
    expect(service.ledger.cases[0].snapshot.space_note).toContain("COLLIE-42");
    expect(decision.run.task_ref).toBe("HAT-42");
    expect(service.ledger.cases[0]).toMatchObject({ stream: "chat_turn", wake: false, visibility: "chat" });
    expect(service.ledger.cases[0].snapshot.budget.used).toBe(0);
    expect(worker.calls.map((call) => call[0])).toEqual(["add", "start", "show"]);
  });
});
