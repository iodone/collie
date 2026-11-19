import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  decisionsDir, enqueueHelperJob, ensureHelper, helperCliArgs, helperName, jobsDir,
  runHelperJob, validateProposal,
} from "../plugins/agent/helper.ts";
import { CollieService } from "../service/main.ts";

const event = await Bun.file(new URL("../protocol/fixtures/event.json", import.meta.url)).json();
const ruleset = await Bun.file(new URL("../protocol/fixtures/ruleset.json", import.meta.url)).json();
const rolePromptRef = resolve(new URL("../templates/collie-coordinator.md", import.meta.url).pathname);
const paths: string[] = [];
const scratch = () => { const path = mkdtempSync(join(tmpdir(), "collie-helper-")); paths.push(path); return path; };
afterEach(() => { while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true }); });

function fakeHc(decision: Record<string, any> = { state: "open", why: "noop", actions: [{ kind: "noop", risk_tags: [] }] }) {
  const calls: string[][] = [];
  const helpers: Record<string, any>[] = [];
  const coordinators = [{
    address: "c1", state: "live", agent: "codex", cwd: "/space/alpha",
    labels: { "herdr.coordinator.space": "alpha", "herdr.coordinator.tab": "tab1" },
  }];
  return {
    calls, helpers,
    run: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "ls") {
        if (args.includes("herdr.role=coordinator")) return { terminals: coordinators };
        return { terminals: helpers.filter((term) => term.state === "live") };
      }
      if (args[0] === "get") {
        const address = args[1];
        return { terminal: [...coordinators, ...helpers].find((term) => term.address === address) ?? {} };
      }
      if (args[0] === "run") {
        helpers.push({
          address: "h1", state: "live", agent: "codex",
          labels: { "herdr.role": "helper", "herdr.job.space": "alpha", "herdr.coordinator": "tab1" },
        });
        return { address: "h1" };
      }
      if (args[0] === "send") {
        const job = String(args[2]).match(/^Job JSON: (.+)$/m);
        if (job) {
          const doc = JSON.parse(readFileSync(job[1], "utf8"));
          writeFileSync(doc.instruction.output_path, JSON.stringify(decision));
        }
        return {};
      }
      return {};
    },
  };
}

const options = (run: (args: string[]) => Promise<any>) => ({
  stateDir: scratch(), space: "alpha", config: { cli: "codex", model: "gpt-5", effort: "high" } as const,
  rolePromptRef, run, timeoutMs: 50, pollIntervalMs: 2, bootWaitMs: 0,
});

describe("Coordinator helper terminal", () => {
  test("helper 名按 space 区分且不超过 hc 的 32 字限制", () => {
    expect(helperName("alpha")).toBe("collie-helper-alpha");
    expect(helperName("a/b")).toBe("collie-helper-a-b");
    expect(helperName("x".repeat(40)).length).toBeLessThanOrEqual(32);
    expect(helperName("alpha")).not.toBe(helperName("beta"));
  });

  test("CLI 参数用交互模式，而不是一次性的 exec/-p", () => {
    expect(helperCliArgs({ cli: "codex", model: "gpt-5", effort: "high" }))
      .toEqual(["codex", "--model", "gpt-5", "-c", 'model_reasoning_effort="high"', "--no-daemon", "--sandbox", "workspace-write", "--ask-for-approval", "on-request"]);
    expect(helperCliArgs({ cli: "claude", model: "default", effort: "medium" }))
      .toEqual(["claude", "--effort", "medium", "--permission-mode", "auto"]);
    expect(helperCliArgs({ cli: "codex", model: "default" }, "/state"))
      .toContain("--add-dir");
    expect(helperCliArgs({ cli: "codex", model: "default" }, "/state").slice(-2)).toEqual(["--add-dir", "/state"]);
    expect(helperCliArgs({ cli: "codex", args: ["exec"], helper_args: ["codex", "--custom"] }))
      .toEqual(["codex", "--custom"]);
  });

  test("找不到 helper 时按 labels 启动一次，再复用同一个 terminal", async () => {
    const hc = fakeHc();
    const opts = options(hc.run);
    const first = await ensureHelper(opts);
    expect(first).toMatchObject({ address: "h1", created: true });
    const started = hc.calls.find((call) => call[0] === "run")!;
    expect(started).toContain("--bg");
    expect(started).toContain("--keep");
    expect(started).toContain("--parent");
    expect(started[started.indexOf("--parent") + 1]).toBe("c1");
    expect(started[started.indexOf("--name") + 1]).toBe("collie-helper-alpha");
    expect(started[started.indexOf("--cwd") + 1]).toBe("/space/alpha");
    expect(started).toContain("herdr.role=helper");
    expect(started).toContain("herdr.job.space=alpha");
    expect(started).toContain("herdr.coordinator=tab1");
    expect(started.slice(started.indexOf("--"))).toContain("codex");

    const second = await ensureHelper(opts);
    expect(second).toMatchObject({ address: "h1", created: false });
    expect(hc.calls.filter((call) => call[0] === "run")).toHaveLength(1);
    expect(hc.calls.filter((call) => call[0] === "send")).toHaveLength(1);
  });

  test("hc 把 Claude 报成 claude-code 时仍复用同一个 helper", async () => {
    const hc = fakeHc();
    hc.helpers.push({
      address: "h1", state: "live", agent: "claude-code",
      labels: { "herdr.role": "helper", "herdr.job.space": "alpha" },
    });
    const opts = { ...options(hc.run), config: { cli: "claude", model: "default", effort: "high" } as const };
    const helper = await ensureHelper(opts);
    expect(helper).toMatchObject({ address: "h1", created: false });
    expect(hc.calls.filter((call) => call[0] === "run")).toHaveLength(0);
  });

  test("kept shell 顶着 labels 不算 helper：先清掉再启动", async () => {
    const hc = fakeHc();
    hc.helpers.push({
      address: "h0", state: "live", agent: "sh",
      labels: { "herdr.role": "helper", "herdr.job.space": "alpha" },
    });
    const opts = options(hc.run);
    const helper = await ensureHelper(opts);
    expect(helper.address).toBe("h1");
    expect(hc.calls.map((call) => call[0])).toContain("kill");
    expect(hc.calls.map((call) => call[0])).toContain("rm");
    expect(hc.calls.find((call) => call[0] === "run")!.slice(-2))
      .toEqual(["--add-dir", decisionsDir(opts.stateDir, "alpha")]);
  });

  test("没有 live Coordinator 时不启动、不退回一次性 CLI", async () => {
    const hc = fakeHc();
    hc.run = async (args: string[]) => {
      hc.calls.push(args);
      return args[0] === "ls" ? { terminals: [] } : {};
    };
    await expect(ensureHelper(options(hc.run))).rejects.toThrow("has no live Coordinator terminal");
    expect(hc.calls.some((call) => call[0] === "run")).toBe(false);
  });
});

describe("helper job IPC", () => {
  test("写 job 文件、发送路径、等待并校验 Decision", async () => {
    const hc = fakeHc({ state: "open", why: "审阅 MR", actions: [{ kind: "noop", risk_tags: [] }] });
    const opts = options(hc.run);
    const result = await runHelperJob({ id: "ca_1", space: { primary: "alpha" } }, opts);
    expect(result.address).toBe("h1");
    expect(result.decision).toMatchObject({ state: "open", why: "审阅 MR" });

    const jobs = readdirSync(jobsDir(opts.stateDir, "alpha"));
    expect(jobs).toHaveLength(1);
    const job = JSON.parse(readFileSync(join(jobsDir(opts.stateDir, "alpha"), jobs[0]), "utf8"));
    expect(job.job.id).toBe("ca_1");
    expect(job.instruction.output_path).toBe(join(decisionsDir(opts.stateDir, "alpha"), `${job.id}.json`));

    const jobSend = hc.calls.filter((call) => call[0] === "send").at(-1)!;
    expect(jobSend[2]).toContain(`Job JSON: ${join(jobsDir(opts.stateDir, "alpha"), jobs[0])}`);
    expect(jobSend[2]).toContain(`Decision output: ${job.instruction.output_path}`);
    expect(jobSend[2]).toContain("brief_ref to /pending/brief");

    await runHelperJob({ id: "ca_2", space: { primary: "alpha" } }, opts);
    expect(hc.calls.filter((call) => call[0] === "run")).toHaveLength(1);
    expect(readdirSync(jobsDir(opts.stateDir, "alpha"))).toHaveLength(2);
  });

  test("waiting 必须带 card；actions 按 decision schema 校验", () => {
    expect(() => validateProposal(
      { state: "waiting", why: "信息不足", actions: [{ kind: "ask", risk_tags: [], ask: { kind: "question", question: "哪个仓库？", options: ["accept"] } }] },
      { space: "alpha", at: "2026-11-18T00:00:00Z" },
    )).toThrow("invalid");

    expect(() => validateProposal(
      { state: "open", why: "动作缺字段", actions: [{ kind: "spawn_task" }] },
      { space: "alpha", at: "2026-11-18T00:00:00Z" },
    )).toThrow("invalid");

    const waiting = validateProposal({
      state: "waiting", why: "信息不足",
      actions: [{ kind: "ask", risk_tags: [], ask: { kind: "question", question: "哪个仓库？", options: ["accept"] } }],
      card: {
        kind: "question", question: "哪个仓库？", options: ["accept"], state: "open",
        created_at: "2026-11-18T00:00:00Z", acked_at: null, answer: null, snooze_until: null, closed_at: null,
      },
    }, { space: "alpha", at: "2026-11-18T00:00:00Z" });
    expect(waiting.state).toBe("waiting");

    const settled = validateProposal({
      state: "settled", why: "不处理", actions: [],
      settled: { at: "2020-01-01T00:00:00Z", by: "human", outcome: "dropped" },
    }, { space: "alpha", at: "2026-11-18T00:00:00Z" });
    expect(settled.settled).toEqual({ at: "2026-11-18T00:00:00Z", by: "coordinator", outcome: "dropped" });
  });

  test("同一 space 的 job 串行：后一个等前一个结束", async () => {
    const gate = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = enqueueHelperJob("queue", async () => {
      order.push("a1");
      await gate.promise;
      order.push("a2");
    });
    const second = enqueueHelperJob("queue", async () => { order.push("b"); });
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["a1", "a2", "b"]);
  });
});

describe("service ingress uses the helper", () => {
  const settings = { everywhere: { coordinator: { cli: "codex", model: "default", effort: "high", helper: "hidden" } } };

  test("service 启动时按 live Coordinator 预建 helper，再启动不重复", async () => {
    const hc = fakeHc();
    const service = new CollieService({
      stateDir: scratch(), ruleset: structuredClone(ruleset),
      workspaces: { collie: { folder: "/repo/collie" } },
      coordinator: { settings },
      helper: { run: hc.run, timeoutMs: 50, pollIntervalMs: 2, bootWaitMs: 0 },
    });
    const started = await service.ensureHelpers();
    expect(started[0]).toMatchObject({ address: "h1", created: true });
    await service.ensureHelpers();
    expect(hc.calls.filter((call) => call[0] === "run")).toHaveLength(1);
  });

  test("事件经常驻 helper 判断，绝不启动一次性 codex/claude", async () => {
    const dir = scratch();
    const hc = fakeHc({ state: "open", why: "无需动作", actions: [{ kind: "noop", risk_tags: [] }] });
    let oneShot = 0;
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(ruleset),
      workspaces: { collie: { folder: "/repo/collie" } },
      coordinator: { settings, run: async () => { oneShot += 1; throw new Error("one-shot CLI must not run"); } },
      helper: { run: hc.run, timeoutMs: 50, pollIntervalMs: 2, bootWaitMs: 0 },
    });
    const decisions = await service.process(event);
    expect(oneShot).toBe(0);
    expect(hc.calls.filter((call) => call[0] === "run")).toHaveLength(1);
    expect(decisions[0].state).toBe("open");
    expect(decisions[0].run.coordinator_ref).toBe("h1");
    expect(service.ledger.decisions.at(-1)!.case_ref).toStartWith("ca_");
  });

  test("helper 起不来时返回 waiting 卡，不偷偷跑一次性 CLI", async () => {
    const dir = scratch();
    const calls: string[][] = [];
    let oneShot = 0;
    const service = new CollieService({
      stateDir: dir, ruleset: structuredClone(ruleset),
      workspaces: { collie: { folder: "/repo/collie" } },
      coordinator: { settings, run: async () => { oneShot += 1; return ""; } },
      helper: {
        timeoutMs: 50, pollIntervalMs: 2, bootWaitMs: 0,
        run: async (args) => {
          calls.push(args);
          return args[0] === "ls" ? { terminals: [] } : {};
        },
      },
    });
    const decisions = await service.process(event);
    expect(oneShot).toBe(0);
    expect(decisions[0].state).toBe("waiting");
    expect(decisions[0].card.kind).toBe("question");
    expect(decisions[0].card.question).toContain("Coordinator helper 未就绪");
    expect(calls.some((call) => call[0] === "run")).toBe(false);
  });
});
