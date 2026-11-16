import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffTarget,
  inboxDecisions,
  parseQueue,
  queuePath,
  receiptPath,
  settledDecisions,
  workingDecisions,
  taskTarget,
  waitingQueue,
  workingBadge,
  workingCount,
} from "../lib/inbox-queue.js";

const waiting = (id: string, extra: Record<string, any> = {}) => ({
  id,
  state: "waiting",
  why: `why ${id}`,
  decided_at: "2026-11-13T10:00:00Z",
  priority: null,
  hold: null,
  card: { created_at: "2026-11-13T10:00:00Z" },
  actions: [],
  ...extra,
});

describe("mods/collie pure queue projection", () => {
  test("只投影 waiting：priority 升序、同优先级先进先出、hold 沉底，且不改输入", () => {
    const decisions = [
      waiting("dc_held", { priority: { value: 0 }, hold: { until: null } }),
      waiting("dc_second", { priority: { value: 2 }, decided_at: "2026-11-13T10:02:00Z" }),
      { ...waiting("dc_routed"), state: "routed", receipt_ref: "rc_ready" },
      waiting("dc_default", { decided_at: "2026-11-13T09:00:00Z" }),
      waiting("dc_first", { priority: { value: 0 }, decided_at: "2026-11-13T10:01:00Z" }),
      waiting("dc_earlier", { priority: { value: 2 }, decided_at: "2026-11-13T10:01:00Z" }),
      { ...waiting("dc_failed"), state: "failed" },
      { ...waiting("dc_acting"), state: "acting" },
      { ...waiting("dc_done"), state: "done" },
    ];
    const before = structuredClone(decisions);

    expect(waitingQueue(decisions).map((d) => d.id)).toEqual([
      "dc_first", "dc_earlier", "dc_second", "dc_default", "dc_held",
    ]);
    expect(decisions).toEqual(before);
    expect(workingCount(decisions)).toBe(2);
  });

  test("Working / Settled 覆盖完整生命周期，但不混入 waiting", () => {
    const rows = [
      waiting("dc_wait"),
      { ...waiting("dc_work"), state: "acting", run: { task_ref: "HAT-42" } },
      { ...waiting("dc_done"), state: "done", settled: { at: "2026-11-13T11:00:00Z" } },
      { ...waiting("dc_closed"), state: "closed", settled: { at: "2026-11-13T12:00:00Z" } },
    ];
    expect(workingDecisions(rows).map((d) => d.id)).toEqual(["dc_work"]);
    expect(settledDecisions(rows).map((d) => d.id)).toEqual(["dc_closed", "dc_done"]);
    expect(waitingQueue(rows).map((d) => d.id)).toEqual(["dc_wait"]);
  });

  test("固定过滤器覆盖 All / Needs you / Working / Review / Settled，Working 角标来自 Decision", () => {
    const rows = [
      waiting("dc_needs"),
      waiting("dc_review", { receipt_ref: "rc_12345678", card: { kind: "accept" } }),
      { ...waiting("dc_thinking"), state: "thinking" },
      { ...waiting("dc_routed"), state: "routed" },
      { ...waiting("dc_progress"), state: "acting" },
      { ...waiting("dc_done"), state: "done" },
      { ...waiting("dc_internal"), state: "new" },
    ];
    expect(inboxDecisions(rows, "all").map((d) => d.id).sort()).toEqual([
      "dc_done", "dc_needs", "dc_progress", "dc_review", "dc_routed", "dc_thinking",
    ]);
    expect(inboxDecisions(rows, "waiting").map((d) => d.id)).toEqual(["dc_needs", "dc_review"]);
    expect(inboxDecisions(rows, "working").map((d) => d.id)).toEqual(["dc_progress", "dc_routed", "dc_thinking"]);
    expect(inboxDecisions(rows, "review").map((d) => d.id)).toEqual(["dc_review"]);
    expect(inboxDecisions(rows, "settled").map((d) => d.id)).toEqual(["dc_done"]);
    expect(workingBadge(rows[2])).toBe("Thinking");
    expect(workingBadge(rows[3])).toBe("In progress");
    expect(workingBadge(rows[4])).toBe("In progress");
    expect(workingBadge(rows[0])).toBeNull();
  });

  test("同优先级同时间用 id 稳定排序", () => {
    const rows = waitingQueue([waiting("dc_b"), waiting("dc_a")]);
    expect(rows.map((d) => d.id)).toEqual(["dc_a", "dc_b"]);
  });

  test("queue.json 只接受 { decisions: [...] }，状态路径固定", () => {
    expect(parseQueue('{"decisions":[]}')).toEqual([]);
    expect(parseQueue(null)).toEqual([]);
    expect(() => parseQueue("[]")).toThrow("decisions array");
    expect(() => parseQueue('{"decisions":{}}')).toThrow("decisions array");
    expect(queuePath("/home/me/")).toBe("/home/me/.local/state/collie/queue.json");
    expect(receiptPath("/home/me", "rc_12345678")).toBe(
      "/home/me/.local/state/collie/receipts/rc_12345678.json",
    );
    expect(receiptPath("/home/me", "../queue")).toBeNull();
  });

  test("队列不凭 task/receipt 自推导：非 waiting 有 ready receipt 也不入队，waiting 无 task 仍保留", () => {
    const readyElsewhere = {
      ...waiting("dc_ready_elsewhere"),
      state: "acting",
      receipt_ref: "rc_ready",
      actions: [{ kind: "spawn_task" }],
    };
    const needsHuman = waiting("dc_needs_human", { actions: [] });
    expect(waitingQueue([readyElsewhere, needsHuman])).toEqual([needsHuman]);
  });
});

test("layout 保留 shepherdr 原生页面，Inbox 只是新增页面", () => {
  const layout = JSON.parse(readFileSync(new URL("../layouts/collie.json", import.meta.url), "utf8"));
  let panel: any;
  const ids: string[] = [];
  const visit = (value: any): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    if (value.id) ids.push(value.id);
    if (value.id === "panel-body") panel = value;
    Object.values(value).forEach(visit);
  };
  visit(layout);
  expect(panel.children.map((child: any) => child.id)).toEqual([
    "files", "changes", "tasks", "artifacts", "collie", "collie-detail", "working",
  ]);
  expect(new Set(ids).size).toBe(ids.length);
});

test("Inbox 是顶部 panel 页签，详情留在 Inbox 内", () => {
  const top = readFileSync(new URL("../mods/collie-tabs/main.js", import.meta.url), "utf8");
  const source = readFileSync(new URL("../mods/collie/main.js", import.meta.url), "utf8");
  expect(top).toContain('panelButton("collie", "Inbox"');
  expect(source).toContain('run("layout.select", { stack: "panel-body", child: "collie-detail" })');
  expect(source).not.toContain('child: "tasks-thread"');
  expect(source).not.toContain("standalone");
});

test("mod 只导入包内共享库拷贝，不越过 herdr 模块边界", () => {
  const source = readFileSync(new URL("../mods/collie/main.js", import.meta.url), "utf8");
  expect(source).toContain('from "./lib/inbox-queue.js"');
  expect(source).not.toContain('from "../../lib/');
  expect(source).toContain('run("layout.select", { stack: "panel-body", child: "collie-detail" })');
  expect(source).not.toContain('child: "tasks-thread"');
  const shared = readFileSync(new URL("../lib/inbox-queue.js", import.meta.url), "utf8");
  const copied = readFileSync(new URL("../mods/collie/lib/inbox-queue.js", import.meta.url), "utf8");
  expect(copied).toBe(shared);
});

test("Inbox 固定五个过滤器，引用 chip 与 Receipt/Task 详情不经过原生 Accept", () => {
  const source = readFileSync(new URL("../mods/collie/main.js", import.meta.url), "utf8");
  expect(source).toContain('[["all", "All"], ["waiting", "Needs you"], ["working", "Working"], ["review", "Review"], ["settled", "Settled"]]');
  expect(source).not.toContain('["thinking", "Thinking"]');
  expect(source).not.toContain('["progress", "In progress"]');
  expect(source).toContain('action(`collie-quote-${decision.id}`, "引用"');
  expect(source).toContain('args.push("--ticket", ticket.id)');
  expect(source).toContain("Receipt summary");
  expect(source).toContain("receipt.proof?.text");
  expect(source).toContain("Task state");
  expect(source).toContain("run.task_ref");
  expect(source).not.toContain('exec(CLI(), ["accept"');
});

test("collie-request 将重复的 --ticket 全部交给 request socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collie-request-"));
  const socket = join(dir, "service.sock");
  let posted: any;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      posted = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const child = Bun.spawn([
      process.execPath, "bin/collie-request", "--state-dir", dir, "--space", "collie", "--goal", "Ship it",
      "--ticket", "dc_first01", "--ticket", "dc_second2",
    ], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '{"ok":true}\n', stderr: "" });
    expect(posted).toEqual({ space: "collie", goal: "Ship it", ticket_refs: ["dc_first01", "dc_second2"] });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("mods/collie navigation targets", () => {
  const decision = waiting("dc_12345678");
  const receipt = {
    decision_ref: decision.id,
    task: { id: "HAT-42", space: "collie" },
  };
  const groups = [{
    folder: "/repo/collie",
    tasks: [{
      id: 42,
      key: "hat#42",
      ref: "HAT-42",
      title: "Implement inbox",
      state: "running",
      live: [{ address: "t88" }],
    }],
  }];
  const detail = {
    worktree: "/worktrees/collie/inbox",
    branch: "collie",
    base: "main",
    start: "9f2c1ab",
  };

  test("task 目标绑定 receipt 对应的真实 task，并选择 worktree 与 live terminal", () => {
    const target = taskTarget(decision, receipt, groups, detail);
    expect(target).toMatchObject({
      ref: "HAT-42",
      title: "Implement inbox",
      state: "running",
      folder: "/repo/collie",
      worktree: "/worktrees/collie/inbox",
      terminal: "t88",
      key: { machine: null, folder: "/repo/collie", slug: "hat", id: 42 },
    });
    expect(diffTarget(target)).toEqual({
      cwd: "/worktrees/collie/inbox",
      on: undefined,
      range: "9f2c1ab...HEAD",
    });
  });

  test("已结束 task 用最后 agent 的 log；远端地址补 machine", () => {
    const remote = [{
      folder: "/repo",
      slug: "hat",
      machine: "vm",
      tasks: [{
        id: 42,
        ref: "HAT-42",
        title: "Done",
        start: "abc",
        agents: [{ address: "t40", log: "/logs/t40.jsonl", agent: "codex" }],
      }],
    }];
    const target = taskTarget(decision, receipt, remote);
    expect(target).toMatchObject({
      terminal: "vm/t40",
      log: { path: "/logs/t40.jsonl", kind: "codex" },
      machine: "vm",
    });
    expect(diffTarget(target)).toMatchObject({ cwd: "/repo", on: "vm", range: "abc...HEAD" });
  });

  test("不错误跳转：receipt 不属于 decision、task 不唯一或缺 diff base 时无目标", () => {
    expect(taskTarget(decision, { ...receipt, decision_ref: "dc_other" }, groups)).toBeNull();
    expect(taskTarget(decision, receipt, [...groups, ...groups])).toBeNull();
    expect(diffTarget(taskTarget(decision, receipt, groups))).toBeNull();
  });
});
