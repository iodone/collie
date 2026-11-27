import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollieService } from "../service/main.ts";
import { coordinate } from "../kernel/coordinator.ts";
import { Ingress } from "../kernel/ingress.ts";

const event = await Bun.file(new URL("../protocol/fixtures/event.json", import.meta.url)).json();
const baseRules = await Bun.file(new URL("../protocol/fixtures/ruleset.json", import.meta.url)).json();
const decisionFixture = await Bun.file(new URL("../protocol/fixtures/decision.json", import.meta.url)).json();
const caseFixture = await Bun.file(new URL("../protocol/fixtures/case.json", import.meta.url)).json();
const paths: string[] = [];
const scratch = () => { const path = mkdtempSync(join(tmpdir(), "collie-service-")); paths.push(path); return path; };
afterEach(() => { while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true }); });

function fakeAgent() {
  const calls: string[][] = [];
  return { calls, run: async (args: string[]) => {
    if (args[0] !== "list") calls.push(args);
    if (args[0] === "add") return { id: 42, ref: "HAT-42" };
    if (args[0] === "start") return { id: 42, state: "running" };
    if (args[0] === "list") return [{ tasks: [{ ref: "HAT-42", key: "HAT-42", state: "done" }] }];
    return {
      id: 42, key: "HAT-42", state: "ready", started_at: 1_763_664_030_000, ready_at: 1_763_666_480_000,
      evidence: { summary: "后台任务完成", details: "- 已复核", commits: { list: [["abc1234", "M6"]] }, proof: { id: "proof-1", title: "tests passed" } },
    };
  } };
}

function waitingReceipt() {
  const at = "2026-11-13T10:41:30Z";
  const question = "任务已 ready，要接受这次交付吗？";
  return {
    state: "waiting", why: "等待人验收 ready 交付",
    actions: [{ kind: "ask", risk_tags: [], ask: { kind: "accept", question, options: ["accept", "rework", "drop"] } }],
    card: { kind: "accept", question, options: ["accept", "rework", "drop"], state: "open", created_at: at,
      acked_at: null, answer: null, snooze_until: null, closed_at: null },
  };
}

function spawnThen(receiptDecision: () => Record<string, any>) {
  return (job: Record<string, any>) => job.message.type === "task.ready" ? receiptDecision() : {
    state: "open", why: "MR 更新需要 worker", actions: [{ kind: "spawn_task", risk_tags: [], spawn: {
      title: event.title, brief_ref: "/tmp/brief.md", base: "current", access: "edit",
    } }],
  };
}

describe("M6 后台双循环", () => {
  test("ready 回执形成 Message/Case 再经 Coordinator，人 accept 同时终结 Task 与 Decision", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const service = new CollieService({
      stateDir: dir, ruleset: baseRules, agent: { run: agent.run },
      workspaces: { "collie": { folder: "/repo/collie", cli: "codex" } },
      decide: spawnThen(waitingReceipt),
    });
    const decisions = await service.process(event);

    expect(agent.calls.map((call) => call[0])).toEqual(["add", "start", "show"]);
    expect(service.ledger.receipts).toHaveLength(1);
    expect(service.ledger.receipts[0].summary).toBe("后台任务完成");
    expect(service.ledger.cases).toHaveLength(2);
    expect(service.ledger.cases[1].message.type).toBe("task.ready");
    expect(service.ledger.messages[0].source).toBe("herdr-task");
    expect(decisions[0].state).toBe("waiting");
    expect(decisions[0].origin).toBe("event");
    expect(decisions[0].run.task_ref).toBe("HAT-42");
    expect(decisions[0].card.kind).toBe("accept");
    const queue = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(queue.decisions).toHaveLength(1);
    expect(queue.decisions[0].receipt_ref).toBe(service.ledger.receipts[0].id);
    expect(JSON.parse(readFileSync(join(dir, "receipts", `${service.ledger.receipts[0].id}.json`), "utf8")).task.id).toBe("HAT-42");

    const answered = await service.answerCard(decisions[0].id, {
      option: "accept", at: "2026-11-13T11:00:00Z", by: "human",
    });
    expect(agent.calls.map((call) => call[0])).toEqual(["add", "start", "show", "accept"]);
    expect(agent.calls.at(-1)).toContain("HAT-42");
    expect(agent.calls.at(-1)).toContain("--done-by");
    expect(agent.calls.at(-1)).toContain("human");
    expect(answered.decision.state).toBe("settled");
    expect(answered.decision.settled.outcome).toBe("accepted");
    expect(answered.decision.occurrence.hops).toBe(1);
    expect(service.ledger.waiting()).toEqual([]);

    const next = await service.process({ ...event, id: "ev_nextcommit01", key: "mr!93@next" });
    expect(agent.calls.map((call) => call[0])).toEqual(["add", "start", "show", "accept", "add", "start", "show"]);
    expect(next[0].event_ref).toBe("ev_nextcommit01");
    expect(service.ledger.waiting()).toHaveLength(1);
  });

  test("Case.snapshot.running 来自真实 Task store，只含 running Task", async () => {
    const dir = scratch();
    const now = new Date("2026-11-13T10:41:30Z");
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(baseRules), now: () => now,
      agent: { run: async () => [{ tasks: [
        { ref: "COLL-42", space: "collie", state: "running", started_at: now.getTime() - 5_000 },
        { ref: "COLL-41", space: "collie", state: "ready", started_at: now.getTime() - 50_000 },
        { ref: "COLL-40", space: "collie", state: "done", started_at: now.getTime() - 500_000 },
      ] }] },
      decide: () => ({ state: "open", why: "read running snapshot", actions: [{ kind: "noop", risk_tags: [] }] }),
    });
    await service.process(event);
    expect(service.ledger.cases[0].snapshot.running).toEqual([{
      task_id: "COLL-42", state: "running", state_changed_at: "2026-11-13T10:41:25.000Z", elapsed_seconds: 5,
    }]);
  });

  test("Coordinator accept 先执行 task accept，再落 settled Decision", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(baseRules), agent: { run: agent.run },
      workspaces: { "collie": { folder: "/repo/collie", cli: "codex" } },
      decide: spawnThen(() => ({
        state: "settled", why: "proof 充分，接受交付", actions: [{ kind: "noop", risk_tags: [] }],
        settled: { at: "2026-11-13T10:42:00Z", by: "coordinator", outcome: "accepted" },
      })),
    });
    const decisions = await service.process(event);
    expect(agent.calls.map((call) => call[0])).toEqual(["add", "start", "show", "accept"]);
    expect(agent.calls.at(-1)).toContain("coordinator");
    expect(decisions[0].state).toBe("settled");
    expect(decisions[0].settled.outcome).toBe("accepted");
    expect(decisions[0].card).toBeNull();
    expect(service.ledger.receipts).toHaveLength(1);
  });

  test("task accept 失败时 Decision 保持未 settled 并出人处理卡", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const run = async (args: string[]) => {
      if (args[0] === "accept") throw new Error("accept refused");
      return agent.run(args);
    };
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(baseRules), agent: { run },
      workspaces: { collie: { folder: "/repo/collie" } },
      decide: spawnThen(() => ({
        state: "settled", why: "尝试接受", actions: [{ kind: "noop", risk_tags: [] }],
        settled: { at: "2026-11-13T10:42:00Z", by: "coordinator", outcome: "accepted" },
      })),
    });
    const decisions = await service.process(event);
    expect(decisions[0]).toMatchObject({ state: "waiting", settled: null });
    expect(decisions[0].card.question).toContain("accept refused");
    expect(decisions[0].receipt_ref).toBe(service.ledger.receipts[0].id);
  });

  test("Coordinator drop 调 task done，rework 只重启同一 task ref", async () => {
    const dropDir = scratch();
    const dropAgent = fakeAgent();
    const dropService = new CollieService({
      stateDir: dropDir, ruleset: structuredClone(baseRules), agent: { run: dropAgent.run },
      workspaces: { collie: { folder: "/repo/collie" } },
      decide: spawnThen(() => ({
        state: "settled", why: "不再继续", actions: [{ kind: "noop", risk_tags: [] }],
        settled: { at: "2026-11-13T10:42:00Z", by: "coordinator", outcome: "dropped" },
      })),
    });
    const dropped = await dropService.process(event);
    expect(dropAgent.calls.map((call) => call[0])).toEqual(["add", "start", "show", "done"]);
    expect(dropAgent.calls.at(-1)).toContain("--done-by");
    expect(dropAgent.calls.at(-1)).toContain("coordinator");
    expect(dropped[0].settled.outcome).toBe("dropped");

    const reworkDir = scratch();
    const reworkAgent = fakeAgent();
    let receiptRound = 0;
    const reworkService = new CollieService({
      stateDir: reworkDir, ruleset: structuredClone(baseRules), agent: { run: reworkAgent.run },
      workspaces: { collie: { folder: "/repo/collie" } },
      decide: spawnThen(() => {
        receiptRound += 1;
        return receiptRound === 1
          ? { state: "open", why: "交付需要返工", actions: [{ kind: "noop", risk_tags: [] }] }
          : {
            state: "settled", why: "返工后接受", actions: [{ kind: "noop", risk_tags: [] }],
            settled: { at: "2026-11-13T10:43:00Z", by: "coordinator", outcome: "accepted" },
          };
      }),
    });
    const reworked = await reworkService.process(event);
    expect(reworkAgent.calls.map((call) => call[0])).toEqual(["add", "start", "show", "start", "show", "accept"]);
    expect(reworkAgent.calls.filter((call) => call[0] === "add")).toHaveLength(1);
    expect(reworkAgent.calls.filter((call) => call[0] === "start").at(-1)?.[1]).toBe("HAT-42");
    expect(reworked[0]).toMatchObject({ state: "settled", settled: { outcome: "accepted" }, run: { task_ref: "HAT-42" } });
    expect(reworkService.ledger.receipts).toHaveLength(2);
  });

  test("真人 accept 后 delivery 发出命令并 settled，未授权不会调用", async () => {
    const dir = scratch();
    const payload = join(dir, "payload.json");
    writeFileSync(payload, JSON.stringify({ repo: "example/collie", id: 93, body: "LGTM" }));
    const external: string[][] = [];
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(baseRules),
      agent: { run: async () => ({ tasks: [] }) },
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
    expect(external).toHaveLength(1);
    expect(external[0]).toContain("note");
    expect(answered.delivered).toBe(true);
    expect(answered.decision.state).toBe("settled");
    expect(answered.decision.settled.outcome).toBe("commented");
    expect(answered.decision.occurrence.hops).toBe(0);
  });

  test("服务重启恢复活跃 lane，同 MR 不重复唤醒 coordinator", async () => {
    const dir = scratch();
    const emptyTaskStore = async () => ({ tasks: [] });
    const first = new CollieService({ stateDir: dir, ruleset: structuredClone(baseRules), agent: { run: emptyTaskStore } });
    await first.process(event);
    expect(first.ledger.cases).toHaveLength(1);

    const restarted = new CollieService({ stateDir: dir, ruleset: structuredClone(baseRules), agent: { run: emptyTaskStore } });
    const decisions = await restarted.process({ ...event, id: "ev_restartmerge1", key: "mr!93@restart" });
    expect(decisions).toEqual([]);
    expect(restarted.ledger.cases).toHaveLength(1);
    expect(restarted.ledger.decisions).toHaveLength(1);
  });

  test("boot 从 Ledger 精确重建损坏 queue，不增加 Ledger entry", async () => {
    const dir = scratch();
    const emptyTaskStore = async () => ({ tasks: [] });
    const first = new CollieService({ stateDir: dir, ruleset: structuredClone(baseRules), agent: { run: emptyTaskStore } });
    await first.process(event);
    const before = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")).entries.length;
    writeFileSync(join(dir, "queue.json"), "corrupt");
    const restarted = new CollieService({ stateDir: dir, ruleset: structuredClone(baseRules), agent: { run: emptyTaskStore } });
    expect(JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"))).toEqual({ decisions: restarted.ledger.decisions });
    expect(JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")).entries).toHaveLength(before);
  });

  test("drain 按文件名顺序处理并标记 done，重复 drain 不增加 Ledger entry", async () => {
    const dir = scratch();
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(baseRules), agent: { run: async () => ({ tasks: [] }) },
      decide: () => ({ state: "open", why: "drain in order", actions: [{ kind: "noop", risk_tags: [] }] }),
    });
    const incoming = join(dir, "incoming");
    mkdirSync(incoming, { recursive: true });
    const source = (n: number) => ({
      ...structuredClone(event), id: `ev_drain${String(n).padStart(4, "0")}`, key: `drain-${n}`,
      object: { ...event.object, id: `mr!${n}` },
      merge: { ...event.merge, lane_key: `mr-review:mr:mr!${n}`, object_key: `mr:mr!${n}` },
    });
    writeFileSync(join(incoming, "02-second.json"), JSON.stringify(source(2)));
    writeFileSync(join(incoming, "01-first.json"), JSON.stringify(source(1)));
    const drained = await service.drain(incoming);
    expect(drained.map((decision) => decision.event_ref)).toEqual(["ev_drain0001", "ev_drain0002"]);
    expect(existsSync(join(incoming, "01-first.json.done"))).toBe(true);
    expect(existsSync(join(incoming, "02-second.json.done"))).toBe(true);
    const before = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")).entries.length;
    expect(await service.drain(incoming)).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")).entries).toHaveLength(before);
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

  test("task 未 ready 就结束时不伪造 receipt/done，waiting Card 可 rework 同一 task", async () => {
    const dir = scratch();
    const run = async (args: string[]) => {
      if (args[0] === "add") return { id: 9, ref: "FAIL-9" };
      if (args[0] === "start") return { id: 9, state: "running" };
      return { id: 9, key: "FAIL-9", state: "done", started_at: 1, ready_at: 2 };
    };
    const calls: string[][] = [];
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(baseRules), agent: { run: async (args) => { if (args[0] !== "list") calls.push(args); return run(args); } },
      workspaces: { collie: { folder: "/repo/collie" } },
      decide: () => ({ state: "open", why: "需要 worker", actions: [{ kind: "spawn_task", risk_tags: [], spawn: {
        title: "will fail", brief_ref: "/tmp/brief.md", base: "current", access: "edit",
      } }] }),
    });
    const decisions = await service.process(event);
    expect(decisions[0].state).toBe("waiting");
    expect(decisions[0].card.kind).toBe("alert");
    expect(decisions[0].card.question).toContain("Task 未交付");
    expect(service.ledger.receipts).toEqual([]);
    expect(calls.map((call) => call[0])).toEqual(["add", "start", "show"]);

    const reworked = await service.answerCard(decisions[0].id, {
      option: "rework", at: "2026-11-13T11:00:00Z", by: "human",
      annotations: [{ file: "review", note: "retry" }],
    }, "machine/t88", async () => ({}));
    expect(calls.map((call) => call[0])).toEqual(["add", "start", "show", "start", "show"]);
    expect(calls.filter((call) => call[0] === "start").at(-1)?.[1]).toBe("FAIL-9");
    expect(calls.filter((call) => call[0] === "add")).toHaveLength(1);
    expect(reworked.decision.state).toBe("waiting");
    expect(reworked.decision.card.kind).toBe("alert");
    expect(service.ledger.receipts).toEqual([]);
  });

  test("ready→rework→running→ready→accept 复用同一 Decision 和 Task", async () => {
    const dir = scratch();
    const calls: string[][] = [];
    let starts = 0;
    let reworkShows = 0;
    const ready = (round: number) => ({
      id: 42, key: "HAT-42", ref: "HAT-42", state: "ready", started_at: 1, ready_at: round + 1,
      evidence: {
        summary: `round ${round} ready`, details: `round ${round} details`, commits: { list: [["abc1234", "work"]] },
        proof: { id: `proof-${round}`, title: `round ${round} proof` },
      },
    });
    const run = async (args: string[]) => {
      if (args[0] !== "list") calls.push(args);
      if (args[0] === "add") return { id: 42, key: "HAT-42", ref: "HAT-42" };
      if (args[0] === "start") { starts += 1; return { id: 42, ref: "HAT-42", state: "running" }; }
      if (args[0] === "accept") return { id: 42, ref: "HAT-42", state: "done", done_by: "human" };
      if (args[0] === "list") return [];
      if (starts === 1) return ready(1);
      reworkShows += 1;
      return reworkShows === 1
        ? { id: 42, ref: "HAT-42", state: "running", started_at: 1 }
        : ready(2);
    };
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(baseRules),
      agent: { run, sleep: async () => {} },
      workspaces: { collie: { folder: "/repo/collie" } },
      decide: spawnThen(waitingReceipt),
    });
    const initial = await service.process(event);
    const decisionId = initial[0].id;
    const reworked = await service.answerCard(decisionId, {
      option: "rework", at: "2026-11-13T11:00:00Z", by: "human",
      annotations: [{ file: "review", note: "second round" }],
    }, "machine/t88", async () => ({}));

    expect(calls.map((call) => call[0])).toEqual(["add", "start", "show", "start", "show", "show"]);
    expect(reworked.decision).toMatchObject({ id: decisionId, state: "waiting", run: { task_ref: "HAT-42" } });
    expect(service.ledger.receipts).toHaveLength(2);
    expect(service.ledger.receipts[1].summary).toBe("round 2 ready");
    expect(service.ledger.decisions).toHaveLength(1);

    const accepted = await service.answerCard(decisionId, {
      option: "accept", at: "2026-11-13T11:01:00Z", by: "human",
    });
    expect(calls.map((call) => call[0])).toEqual(["add", "start", "show", "start", "show", "show", "accept"]);
    expect(calls.filter((call) => call[0] === "add")).toHaveLength(1);
    expect(calls.filter((call) => call[0] === "start")).toHaveLength(2);
    expect(accepted.decision).toMatchObject({ id: decisionId, state: "settled", settled: { outcome: "accepted" } });
    expect(service.ledger.decisions).toHaveLength(1);
  });

  test("真人 accept/archive 命令失败不落 answered/settled，重试只有一个终态 revision", async () => {
    for (const option of ["accept", "archive"] as const) {
      const dir = scratch();
      const agent = fakeAgent();
      let terminalAttempts = 0;
      let service: CollieService;
      let decisionId = "";
      const run = async (args: string[]) => {
        if (args[0] === (option === "accept" ? "accept" : "done")) {
          terminalAttempts += 1;
          expect(service.ledger.decisions.find((item) => item.id === decisionId)?.state).not.toBe("settled");
          if (terminalAttempts === 1) throw new Error("human terminal failed");
          return { ref: "HAT-42", state: "done", done_by: "human" };
        }
        return agent.run(args);
      };
      service = new CollieService({
        stateDir: dir, ruleset: structuredClone(baseRules), agent: { run },
        workspaces: { collie: { folder: "/repo/collie" } },
      });
      const created = await service.createTicket({ space: "collie", title: `human ${option}`, brief: "finish", kind: "build" });
      decisionId = created.decision_id;
      const before = service.ledger.history("decision").length;
      const answer = { option, at: "2026-11-13T11:00:00Z", by: "human" };
      await expect(service.answerCard(created.decision_id, answer)).rejects.toThrow("human terminal failed");
      expect(service.ledger.history("decision")).toHaveLength(before);
      expect(service.ledger.decisions.find((item) => item.id === created.decision_id)).toMatchObject({
        state: "waiting", settled: null, card: { answer: null },
      });

      const retried = await service.answerCard(created.decision_id, answer);
      expect(terminalAttempts).toBe(2);
      expect(retried.decision).toMatchObject({
        state: "settled", settled: { outcome: option === "accept" ? "accepted" : "archived", by: "human" },
      });
      expect(service.ledger.history("decision").filter((item) => item.id === created.decision_id && item.state === "settled")).toHaveLength(1);
    }
  });

  test("review task: running → ready → waiting receipt，Inbox 不提前结案", async () => {
    const dir = scratch();
    let shown = 0;
    const run = async (args: string[]) => {
      if (args[0] === "add") return { id: 11, key: "REV-11", ref: "REV-11" };
      if (args[0] === "start") return { id: 11, state: "running" };
      if (args[0] === "list") return [];
      shown += 1;
      if (shown === 1) return { id: 11, key: "REV-11", state: "running", started_at: 1 };
      return {
        id: 11, key: "REV-11", state: "ready", started_at: 1, ready_at: 2,
        evidence: { summary: "review posted", details: "- reviewed", commits: { list: [["abc1234", "review"]] }, proof: { id: "proof-11", title: "review" } },
      };
    };
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(baseRules), agent: { run, pollIntervalMs: 1, maxPolls: 5 },
      workspaces: { collie: { folder: "/repo/collie" } },
    });
    const created = await service.createTicket({ space: "collie", title: "review flow", brief: "review it", kind: "review" });
    expect(created.ticket_ref).toBe("REV-11");
    const decision = service.ledger.decisions.find((item) => item.id === created.decision_id)!;
    expect(decision.state).toBe("waiting");
    expect(decision.receipt_ref).toStartWith("rc_");
    expect(decision.card.kind).toBe("accept");
    expect(service.ledger.receipts[0].task.state).toBe("ready");
    expect(JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")).decisions[0].card.kind).toBe("accept");
  });

  test("人 archive ready Card 调 task done，并与 Decision 同时终结", async () => {
    const dir = scratch();
    const agent = fakeAgent();
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(baseRules), agent: { run: agent.run },
      workspaces: { collie: { folder: "/repo/collie" } },
    });
    const created = await service.createTicket({ space: "collie", title: "archive ready", brief: "stop", kind: "build" });
    const answered = await service.answerCard(created.decision_id, {
      option: "archive", at: "2026-11-13T11:00:00Z", by: "human",
    });
    expect(agent.calls.map((call) => call[0])).toEqual(["add", "start", "show", "done"]);
    expect(agent.calls.at(-1)).toContain("human");
    expect(answered.decision).toMatchObject({ state: "settled", settled: { outcome: "archived", by: "human" } });
  });

  test("预算耗尽进入 Todo，保留当前 Task 并可立即执行", async () => {
    const dir = scratch();
    const ruleset = structuredClone(baseRules);
    ruleset.budget.per_hour = 2;
    let calls = 0;
    const taskCalls: string[][] = [];
    const service = new CollieService({
      stateDir: dir, ruleset,
      decide: () => { calls += 1; return { state: "open", why: `noop ${calls}`, actions: [{ kind: "noop", risk_tags: [] }] }; },
      agent: { run: async (args: string[]) => {
        taskCalls.push(args);
        return args[0] === "show" ? { ref: "COLL-42", folder: "/repo" } : { ref: "COLL-42", state: "running" };
      } },
    });
    for (let n = 1; n <= 3; n += 1) {
      const dispatch = new Ingress().ingest({
        ...event,
        id: `ev_budget${String(n).padStart(10, "0")}`,
        key: `mr!${n}@head`,
        object: { ...event.object, id: `mr!${n}` },
        merge: { ...event.merge, lane_key: `mr-review:mr:mr!${n}`, object_key: `mr:mr!${n}` },
      }).dispatches[0];
      service.ledger.append("message", dispatch.event);
      await coordinate(dispatch, {
        ledger: service.ledger, ruleset,
        decide: () => { calls += 1; return { state: "open", why: `noop ${n}`, actions: [{ kind: "noop", risk_tags: [] }] }; },
        now: () => new Date("2026-11-13T10:00:00Z"),
      });
    }
    const deferred = service.ledger.decisions.at(-1);
    expect(calls).toBe(2);
    expect(deferred.state).toBe("open");
    expect(deferred.card).toBeNull();
    const archived = await service.archiveDecision(deferred.id);
    expect(archived.state).toBe("settled");
    expect(archived.settled.outcome).toBe("archived");

    const current = service.ledger.append("decision", {
      ...deferred, id: "dc_budgetcurrent", why: "继续当前任务", run: { task_ref: "COLL-42", coordinator_ref: null },
    });
    const message = service.ledger.messages.at(-1);
    const dispatch = { kind: "coordinator", laneKey: message.merge.lane_key, space: current.space, message };
    const held = await coordinate(dispatch, {
      ledger: service.ledger, ruleset, decisionId: current.id,
      decide: () => { calls += 1; return { state: "open", why: "should not run", actions: [{ kind: "noop", risk_tags: [] }] }; },
      now: () => new Date("2026-11-13T10:00:00Z"),
    });
    expect(held.state).toBe("open");
    expect(held.card).toBeNull();
    expect(held.run.task_ref).toBe("COLL-42");

    const result = await service.runDecision(current.id);
    expect(calls).toBe(2);
    expect(taskCalls).toEqual([
      ["show", "COLL-42", "--json"],
      ["start", "COLL-42", "--folder", "/repo", "--space", "collie", "--json"],
    ]);
    expect(result.state).toBe("open");
    expect(result.run.task_ref).toBe("COLL-42");
  });

  test("helper job 在 service 重启后无结果时转 waiting Card", async () => {
    const dir = scratch();
    const service = new CollieService({ stateDir: dir, ruleset: structuredClone(baseRules) });
    service.ledger.append("case", { id: "ca_recover01" });
    service.ledger.append("decision", { id: "dc_recover01", case_ref: "ca_recover01", state: "open", why: "thinking" });
    const jobs = join(dir, "helper", "collie", "jobs");
    mkdirSync(jobs, { recursive: true });
    const output = join(dir, "helper", "collie", "decisions", "hj_recover01.json");
    writeFileSync(join(jobs, "hj_recover01.json"), JSON.stringify({ id: "hj_recover01", job: { id: "ca_recover01" }, instruction: { output_path: output } }));
    const recovered = await service.recoverHelperJobs();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ state: "waiting", card: { kind: "alert" } });
  });

  test("已写 helper output 重启后提交一次；坏 output 出卡，settled case 不再处理", async () => {
    const dir = scratch();
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(baseRules), agent: { run: async () => ({ tasks: [] }) },
    });
    const caseRef = "ca_recovervalid1";
    const decisionId = "dc_recovervalid1";
    service.ledger.append("case", { ...structuredClone(caseFixture), id: caseRef });
    service.ledger.append("decision", {
      ...structuredClone(decisionFixture), id: decisionId, case_ref: caseRef, origin: "event",
      state: "open", why: "Coordinator 正在分析输入并生成 Decision", actions: [], card: null, settled: null,
    });
    const jobs = join(dir, "helper", "collie", "jobs");
    mkdirSync(jobs, { recursive: true });
    mkdirSync(join(dir, "helper", "collie", "decisions"), { recursive: true });
    const output = join(dir, "helper", "collie", "decisions", "hj_valid01.json");
    writeFileSync(join(jobs, "hj_valid01.json"), JSON.stringify({
      id: "hj_valid01", job: { ...structuredClone(caseFixture), id: caseRef }, instruction: { output_path: output },
    }));
    const question = "恢复的判断要人确认";
    writeFileSync(output, JSON.stringify({
      state: "waiting", why: "恢复 helper 输出",
      actions: [{ kind: "ask", risk_tags: [], ask: { kind: "question", question, options: ["accept", "drop"] } }],
      card: { kind: "question", question, options: ["accept", "drop"], state: "open",
        created_at: "2026-11-13T10:00:00Z", acked_at: null, answer: null, snooze_until: null, closed_at: null },
    }));
    const recovered = await service.recoverHelperJobs();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: decisionId, state: "waiting", why: "恢复 helper 输出" });
    const recoveredRevisions = service.ledger.history("decision").filter((item) => item.id === decisionId).length;
    expect(recoveredRevisions).toBeGreaterThan(1);
    expect(await service.recoverHelperJobs()).toEqual([]);
    expect(service.ledger.history("decision").filter((item) => item.id === decisionId)).toHaveLength(recoveredRevisions);

    const badDir = scratch();
    const bad = new CollieService({ stateDir: badDir, ruleset: structuredClone(baseRules) });
    const badCase = "ca_badoutput1";
    bad.ledger.append("case", { ...structuredClone(caseFixture), id: badCase });
    bad.ledger.append("decision", {
      ...structuredClone(decisionFixture), id: "dc_badoutput1", case_ref: badCase, origin: "event",
      state: "open", why: "thinking", actions: [], card: null, settled: null,
    });
    bad.ledger.append("decision", {
      ...structuredClone(decisionFixture), id: "dc_settled01", case_ref: "ca_settled01", state: "settled",
      settled: { at: "2026-11-13T10:00:00Z", by: "human", outcome: "dropped" },
    });
    const badJobs = join(badDir, "helper", "collie", "jobs");
    mkdirSync(badJobs, { recursive: true });
    mkdirSync(join(badDir, "helper", "collie", "decisions"), { recursive: true });
    const badOutput = join(badDir, "helper", "collie", "decisions", "hj_bad01.json");
    writeFileSync(join(badJobs, "hj_bad01.json"), JSON.stringify({
      id: "hj_bad01", job: { ...structuredClone(caseFixture), id: badCase }, instruction: { output_path: badOutput },
    }));
    writeFileSync(badOutput, "not json");
    const settledOutput = join(badDir, "helper", "collie", "decisions", "hj_settled01.json");
    writeFileSync(join(badJobs, "hj_settled01.json"), JSON.stringify({
      id: "hj_settled01", job: { ...structuredClone(caseFixture), id: "ca_settled01" }, instruction: { output_path: settledOutput },
    }));
    writeFileSync(settledOutput, "also not json");
    const malformed = await bad.recoverHelperJobs();
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toMatchObject({ id: "dc_badoutput1", state: "waiting", card: { kind: "alert" } });
    expect(await bad.recoverHelperJobs()).toEqual([]);
    expect(bad.ledger.decisions.find((item) => item.id === "dc_settled01")?.state).toBe("settled");
  });

  test("settled/noop 关闭 lane，下一次同对象事件重新判断", async () => {
    const dir = scratch();
    const noop = () => ({
      state: "settled", why: "无需处理", actions: [{ kind: "noop", risk_tags: [] }],
      settled: { at: "2026-11-13T10:00:00Z", by: "coordinator", outcome: "dropped" },
    });
    const service = new CollieService({ stateDir: dir, ruleset: structuredClone(baseRules), decide: noop });
    await service.process({ ...event, id: "ev_nooplane01", key: "mr!nooplane@1" });
    const snapshot = service.ingress.snapshot();
    expect(snapshot.lanes).toHaveLength(1);
    expect(snapshot.lanes[0][1].open).toBe(false);
    const next = await service.process({ ...event, id: "ev_nooplane02", key: "mr!nooplane@2" });
    expect(next).toHaveLength(1);
    expect(next[0].state).toBe("settled");
    expect(service.ingress.snapshot().lanes[0][1].open).toBe(false);
  });

  test("多 space 事件不静默选边：生成 waiting Card", async () => {
    const dir = scratch();
    const service = new CollieService({ stateDir: dir, ruleset: structuredClone(baseRules), agent: { run: async () => ({ tasks: [] }) } });
    const decided = await service.process({ ...event, id: "ev_multispace01", key: "mr!93@multi", space_candidates: ["collie", "miergo"] });
    expect(decided).toHaveLength(1);
    expect(decided[0].state).toBe("waiting");
    expect(decided[0].card.kind).toBe("question");
    expect(decided[0].card.question).toContain("多个 space");
  });
});
