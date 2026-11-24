import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollieService } from "../service/main.ts";
import { CollaborationRegistry } from "../service/collaboration.ts";

const ruleset = await Bun.file(new URL("../protocol/fixtures/ruleset.json", import.meta.url)).json();
const paths: string[] = [];
const scratch = () => { const path = mkdtempSync(join(tmpdir(), "collie-verify-")); paths.push(path); return path; };
afterEach(() => { while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true }); });

function fakeAgent() {
  const calls: string[][] = [];
  return { calls, run: async (args: string[]) => {
    if (args[0] !== "list") calls.push(args);
    if (args[0] === "add") return { id: 7, key: "VER-7", ref: "VER-7" };
    if (args[0] === "start") return { id: 7, state: "running" };
    return {
      id: 7, key: "VER-7", state: "ready", started_at: 1_763_664_030_000, ready_at: 1_763_666_480_000,
      evidence: { summary: "done", details: "- verified", commits: { list: [["abc1234", "x"]] }, proof: { id: "proof-7", title: "checks" } },
    };
  } };
}

describe("playbook verify", () => {
  test("feature playbook verify=true 不变成 task verify 门禁", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const service = new CollieService({
      stateDir: dir, configDir: dir, ruleset, agent: { run: agent.run },
      collaboration: new CollaborationRegistry(dir),
      workspaces: { verify: { folder: dir } },
    });
    await service.createTicket({ space: "verify", title: "verify task", brief: "check", kind: "build" });
    expect(agent.calls[0]).not.toContain("verify=on");
    expect(agent.calls[0]).not.toContain("review=on");
  });

  test("Settings 只转发 driver runner；reviewer/verifier 仍由 brief 和 playbook 编排", async () => {
    const dir = scratch();
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      driver: { agent: "codex", model: "gpt-5", effort: "high" },
      reviewer: { agent: "claude", model: "sonnet", effort: "low" },
      verifier: { agent: "codex", model: "o3", effort: "xhigh" },
    }));
    const agent = fakeAgent();
    const service = new CollieService({
      stateDir: dir, configDir: dir, ruleset, agent: { run: agent.run }, settingsPath,
      collaboration: new CollaborationRegistry(dir),
      workspaces: { verify: { folder: dir } },
    });
    await service.createTicket({ space: "verify", title: "runner task", brief: "check", kind: "build" });
    expect(service.ledger.events).toHaveLength(0);
    expect(service.ledger.messages).toHaveLength(2);
    expect(service.ledger.messages[0].source).toBe("human");
    expect(service.ledger.messages[1].source).toBe("herdr-task");
    expect(agent.calls[0]).toContain("--agent");
    expect(agent.calls[0]).toContain("codex");
    expect(agent.calls[0]).toContain("--model");
    expect(agent.calls[0]).toContain("gpt-5");
    expect(agent.calls[0]).toContain("--effort");
    expect(agent.calls[0]).toContain("high");
    expect(agent.calls[0]).not.toContain("--reviewer");
    expect(agent.calls[0]).not.toContain("--reviewer-model");
    expect(agent.calls[0]).not.toContain("--reviewer-effort");
    expect(agent.calls[0]).not.toContain("claude");
    const brief = await Bun.file(agent.calls[0][agent.calls[0].indexOf("--prompt-file") + 1]).text();
    expect(brief.includes('; runner: {"agent":"claude","model":"sonnet","effort":"low"}')).toBe(true);
    expect(brief.includes('; runner: {"agent":"codex","model":"o3","effort":"xhigh"}')).toBe(true);
  });
});
