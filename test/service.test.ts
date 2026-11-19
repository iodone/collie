import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollieService } from "../service/main.ts";

const event = await Bun.file(new URL("../protocol/fixtures/event.json", import.meta.url)).json();
const baseRules = await Bun.file(new URL("../protocol/fixtures/ruleset.json", import.meta.url)).json();
const paths: string[] = [];
const scratch = () => { const path = mkdtempSync(join(tmpdir(), "collie-service-")); paths.push(path); return path; };
afterEach(() => { while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true }); });

function fakeAgent() {
  const calls: string[][] = [];
  return { calls, run: async (args: string[]) => {
    calls.push(args);
    if (args[0] === "add") return { id: 42, key: "HAT-42" };
    if (args[0] === "start") return { id: 42, state: "running" };
    if (args[0] === "list") return [{ tasks: [{ ref: "HAT-42", key: "HAT-42", state: "done" }] }];
    return {
      id: 42, key: "HAT-42", state: "ready", started: 1_763_664_030_000, ready_at: 1_763_666_480_000,
      evidence: { summary: "后台任务完成", details: "- 已复核", commits: { list: [["abc1234", "M6"]] }, proof: { id: "proof-1", title: "tests passed" } },
      reviews: [{ result: "report", by: "t99", head: "abc1234" }],
    };
  } };
}

describe("M6 后台双循环", () => {
  test("没有窗口：事件经 coordinator 派到 ready，Ledger 有回执，queue 只有 Accept 卡", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const service = new CollieService({
      stateDir: dir, ruleset: baseRules, agent: { run: agent.run },
      workspaces: { "collie": { folder: "/repo/collie", cli: "codex" } },
      decide: () => ({ state: "open", why: "MR 更新需要 worker", actions: [{ kind: "spawn_task", risk_tags: [], spawn: {
        title: event.title, brief_ref: "/tmp/brief.md", base: "current", review: true, merge: false, access: "edit", tells: "needed",
      } }] }),
    });
    const decisions = await service.process(event);

    expect(agent.calls.map((call) => call[0])).toEqual(["add", "start", "show"]);
    expect(service.ledger.receipts).toHaveLength(1);
    expect(service.ledger.receipts[0].summary).toBe("后台任务完成");
    expect(decisions[0].state).toBe("waiting");
    expect(decisions[0].origin).toBe("event");
    expect(decisions[0].run.task_ref).toBe("HAT-42");
    expect(decisions[0].card.kind).toBe("accept");
    const queue = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(queue.decisions).toHaveLength(1);
    expect(queue.decisions[0].receipt_ref).toBe(service.ledger.receipts[0].id);
    expect(JSON.parse(readFileSync(join(dir, "receipts", `${service.ledger.receipts[0].id}.json`), "utf8")).task.id).toBe("HAT-42");
    expect(agent.calls.flat()).not.toContain("tell-assistant");

    let ledgerWasUpdatedBeforeResume = false;
    const answered = await service.answerCard(decisions[0].id, {
      option: "accept", at: "2026-11-13T11:00:00Z", by: "human",
    }, "machine/t88", async () => {
      ledgerWasUpdatedBeforeResume = service.ledger.decisions.find((item) => item.id === decisions[0].id).state === "open";
      return {};
    });
    expect(ledgerWasUpdatedBeforeResume).toBe(true);
    expect(answered.decision.occurrence.hops).toBe(0);
    expect(service.ledger.waiting()).toEqual([]);

    const next = await service.process({ ...event, id: "ev_nextcommit01", key: "mr!93@next" });
    expect(agent.calls.map((call) => call[0])).toEqual(["add", "start", "show", "add", "start", "show"]);
    expect(next[0].event_ref).toBe("ev_nextcommit01");
    expect(service.ledger.waiting()).toHaveLength(1);
  });

  test("coordinator 的 spawn 决定也进入 herdr-task 双循环", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(baseRules), agent: { run: agent.run },
      workspaces: { "collie": { folder: "/repo/collie", cli: "codex" } },
      decide: () => ({ state: "open", why: "MR 更新需要 worker", actions: [{ kind: "spawn_task", risk_tags: [], spawn: {
        title: event.title, brief_ref: "/tmp/brief.md", base: "current", review: true, merge: false, access: "edit", tells: "needed",
      } }] }),
    });
    const decisions = await service.process(event);
    expect(agent.calls.map((call) => call[0])).toEqual(["add", "start", "show"]);
    expect(decisions[0].card.kind).toBe("accept");
    expect(service.ledger.receipts).toHaveLength(1);
  });

  test("真人 accept 后 delivery 发出命令并 settled，未授权不会调用", async () => {
    const dir = scratch();
    const payload = join(dir, "payload.json");
    writeFileSync(payload, JSON.stringify({ repo: "example/collie", id: 93, body: "LGTM" }));
    const external: string[][] = [];
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(baseRules),
      delivery: { gitlab: async (args) => { external.push(args); return {}; } },
      decide: () => ({ state: "open", why: "评审通过后评论 MR", actions: [{ kind: "emit_command", risk_tags: ["outbound_message"], egress: {
        target: "gitlab", op: "comment", payload_ref: payload,
      } }] }),
    });
    const waiting = await service.process(event);
    await expect(service.deliver(waiting[0].id)).rejects.toThrow("human accept");
    expect(external).toEqual([]);
    const answered = await service.answerCard(waiting[0].id, {
      option: "accept", at: "2026-11-13T11:00:00Z", by: "human",
    }, "machine/t88", async () => ({}));
    const done = await service.deliver(waiting[0].id);
    expect(external[0]).toContain("note");
    expect(done.state).toBe("settled");
    expect(done.settled.outcome).toBe("commented");
    expect(answered.decision.occurrence.hops).toBe(0);
  });

  test("服务重启恢复活跃 lane，同 MR 不重复唤醒 coordinator", async () => {
    const dir = scratch();
    const first = new CollieService({ stateDir: dir, ruleset: structuredClone(baseRules) });
    await first.process(event);
    expect(first.ledger.cases).toHaveLength(1);

    const restarted = new CollieService({ stateDir: dir, ruleset: structuredClone(baseRules) });
    const decisions = await restarted.process({ ...event, id: "ev_restartmerge1", key: "mr!93@restart" });
    expect(decisions).toEqual([]);
    expect(restarted.ledger.cases).toHaveLength(1);
    expect(restarted.ledger.decisions).toHaveLength(1);
  });

  test("hops 熔断只出 alert 卡，不触碰 herdr-task", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const service = new CollieService({ stateDir: dir, ruleset: baseRules, agent: { run: agent.run } });
    const decisions = await service.process({ ...event, hops: 9 });
    expect(decisions[0].card.kind).toBe("alert");
    expect(decisions[0].occurrence.hops).toBe(9);
    expect(agent.calls).toEqual([]);
  });
});
