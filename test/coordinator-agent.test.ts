import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { coordinatorConfig } from "../plugins/agent/coordinator.ts";
import { CollieService } from "../service/main.ts";
import { mergeCoordinator } from "../lib/inbox-settings.js";

const ruleset = await Bun.file(new URL("../protocol/fixtures/ruleset.json", import.meta.url)).json();
const paths: string[] = [];
const scratch = () => { const path = mkdtempSync(join(tmpdir(), "collie-host-")); paths.push(path); return path; };
afterEach(() => { while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true }); });
const rolePromptRef = resolve(new URL("../templates/coordinator.md", import.meta.url).pathname);

function agent() {
  const calls: string[][] = [];
  return { calls, run: async (args: string[]) => {
    if (args[0] !== "list") calls.push(args);
    if (args[0] === "add") return { id: 42, ref: "HAT-42" };
    if (args[0] === "start") return { id: 42, state: "running" };
    return {
      id: 42, key: "HAT-42", state: "ready", started_at: 1_763_664_030_000, ready_at: 1_763_666_480_000,
      evidence: { summary: "完成", details: "- 已复核", commits: { list: [["abc1234", "build"]] }, proof: { id: "proof-1", title: "tests passed" } },
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

  test("New / Build 是 human Message，不占事件预算，并实际 spawn", async () => {
    const dir = scratch();
    const worker = agent();
    const service = new CollieService({
      stateDir: dir, ruleset, rolePromptRef,
      workspaces: { "collie": { folder: "/repo/collie", cli: "codex" } },
      agent: { run: worker.run },
    });
    const created = await service.createTicket({
      space: "collie", title: "Build request", brief: "实现 New Build", kind: "build",
    });
    expect(service.ledger.cases[0]).toMatchObject({ origin: "human" });
    expect(service.ledger.cases[0].snapshot.budget.used).toBe(0);
    expect(service.ledger.cases[0].catalog.playbooks.some((book: any) => book.name === "feature")).toBe(true);
    expect(service.ledger.cases[0].instruction.role_prompt_ref).toBe(rolePromptRef);
    expect(created.ticket_ref).toBe("HAT-42");
    expect(worker.calls.map((call) => call[0])).toEqual(["add", "start", "show"]);
  });
});
