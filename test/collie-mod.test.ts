import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseQueue,
  queuePath,
  receiptPath,
  settledDecisions,
  STAGE_WORD,
  ticketGroup,
  ticketNeed,
  ticketRef,
  ticketStage,
  todoReason,
  workingDecisions,
  workKind,
  taskTarget,
  orphanTickets,
  taskAgents,
  waitingQueue,
  workingCount,
  taskLifecycle,
} from "../lib/inbox-queue.js";
import { taskArtifacts } from "../core/task-artifacts.js";
import { taskReceipts, receiptTitle, receiptProofRefs } from "../core/task-receipts.js";
import { chatPane } from "../core/spaces.js";
import { tabName } from "../mods/collie-tabs/core/menus.js";
import { runTick } from "../mods/collie-tabs/core/tick.js";
import { Conversation } from "../mods/collie-chat/core/chat-log.js";

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

describe("mods/collie-inbox pure queue projection", () => {
  test("只投影 waiting：priority 升序、同优先级先进先出、hold 沉底，且不改输入", () => {
    const decisions = [
      waiting("dc_held", { priority: { value: 0 }, hold: { until: null } }),
      waiting("dc_second", { priority: { value: 2 }, decided_at: "2026-11-13T10:02:00Z" }),
      { ...waiting("dc_open"), state: "open", receipt_ref: "rc_ready" },
      waiting("dc_default", { decided_at: "2026-11-13T09:00:00Z" }),
      waiting("dc_first", { priority: { value: 0 }, decided_at: "2026-11-13T10:01:00Z" }),
      waiting("dc_earlier", { priority: { value: 2 }, decided_at: "2026-11-13T10:01:00Z" }),
      waiting("dc_card", { card: { kind: "alert" } }),
      { ...waiting("dc_open"), state: "open" },
      { ...waiting("dc_done"), state: "settled", settled: { at: "2026-11-13T11:00:00Z", outcome: "merged" } },
    ];
    const before = structuredClone(decisions);

    expect(waitingQueue(decisions).map((d) => d.id)).toEqual([
      "dc_first", "dc_earlier", "dc_second", "dc_default", "dc_card", "dc_held",
    ]);
    expect(decisions).toEqual(before);
    expect(workingCount(decisions)).toBe(2);
  });

  test("Settled 只认 Decision.settled；failed 有卡，不算 settled", () => {
    const rows = [
      waiting("dc_wait"),
      { ...waiting("dc_work"), state: "open", run: { task_ref: "HAT-42" } },
      { ...waiting("dc_done"), state: "settled", settled: { at: "2026-11-13T11:00:00Z", outcome: "merged" } },
      { ...waiting("dc_closed"), state: "settled", settled: { at: "2026-11-13T12:00:00Z", outcome: "dropped" } },
      { ...waiting("dc_card"), state: "waiting", card: { kind: "alert" }, settled: null },
    ];
    expect(workingDecisions(rows).map((d) => d.id)).toEqual(["dc_work"]);
    expect(settledDecisions(rows).map((d) => d.id)).toEqual(["dc_closed", "dc_done"]);
    expect(waitingQueue(rows).map((d) => d.id)).toEqual(["dc_card", "dc_wait"]);
  });

  test("四个 Work 状态：Needs you / Todo / Working / Settled", () => {
    const base = waiting("dc_stage");
    expect(ticketStage(base, null)).toBe("needs");
    expect(ticketStage({ ...base, state: "open" }, null)).toBe("todo");
    expect(ticketStage({ ...base, state: "open" }, { state: "todo" })).toBe("todo");
    expect(ticketStage({ ...base, state: "open" }, { state: "running" })).toBe("working");
    expect(ticketStage({ ...base, state: "open" }, { state: "running" }, { driver: true })).toBe("working");
    expect(ticketStage({ ...base, state: "open" }, { state: "running" }, { driver: true, reviewer: true })).toBe("working");
    expect(ticketStage({ ...base, state: "open" }, { state: "running" }, { driver: true, blocked: true })).toBe("needs");
    expect(ticketStage({ ...base, state: "open", run: { task_ref: "HAT-42" } }, null)).toBe("working");
    expect(ticketStage({ ...base, state: "open" }, { state: "ready" })).toBe("needs");
    expect(ticketStage({ ...base, state: "open" }, { state: "done" })).toBe("settled");
    expect(ticketStage({ ...base, state: "settled", settled: { at: "2026-11-13T11:00:00Z" } }, null)).toBe("settled");
    expect(Object.keys(STAGE_WORD)).toEqual(["needs", "todo", "working", "settled"]);
    expect(ticketNeed({ ...base, receipt_ref: "rc_stage" })).toBe("ready");
    expect(ticketNeed({ ...base, state: "open" }, { state: "ready" })).toBe("ready");
    expect(workKind({ ...base, state: "open", run: { kind: "review" } }, { state: "running" }, { driver: true })).toBe("review");
    expect(workKind({ ...base, state: "open", run: { kind: "verify" } }, { state: "running" })).toBe("verify");
    expect(workKind({ ...base, state: "open" }, { state: "running" }, { driver: true, verifier: true })).toBe("verify");
    expect(workKind({ ...base, state: "open" }, { state: "running" }, { driver: true })).toBe("build");
    expect(["todo", "running", "ready", "done"].map((state) => taskLifecycle({ state }))).toEqual(["todo", "running", "ready", "done"]);
  });

  test("Todo 显示依赖、队列并发和机器资源等待原因", () => {
    expect(todoReason({ state: "todo", depends_on: ["PS-3", "vm:WEB-2"] }, { why: "x" })).toBe("after PS-3, vm:WEB-2");
    expect(todoReason({ state: "todo", depends_on: [] }, { why: "x" })).toBe("not started");
    expect(todoReason({ state: "todo", reason: "10 tasks are running here" }, { why: "x" })).toBe("10 tasks are running here");
    expect(todoReason({ state: "todo", reason: "memory is 92% full" }, { why: "x" })).toBe("memory is 92% full");
    expect(todoReason(null, { why: "why x" })).toBe("why x");
  });

  test("All 固定分为 Needs you / Todo / Working / Settled", () => {
    const item = (id: string, stage: string, at: string) => ({
      decision: { id, stage, space: "beta", decided_at: at }, stage,
    });
    const groups = ticketGroup([
      item("w_old", "working", "2026-11-13T10:00:00Z"),
      item("w_new", "working", "2026-11-13T12:00:00Z"),
      item("t", "todo", "2026-11-13T09:00:00Z"),
      item("n", "needs", "2026-11-13T11:00:00Z"),
      item("s", "settled", "2026-11-13T13:00:00Z"),
    ]);
    expect(groups.needs.map((x) => x.decision.id)).toEqual(["n"]);
    expect(groups.todo.map((x) => x.decision.id)).toEqual(["t"]);
    expect(groups.working.map((x) => x.decision.id)).toEqual(["w_new", "w_old"]);
    expect(groups.settled.map((x) => x.decision.id)).toEqual(["s"]);
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
      state: "open",
      receipt_ref: "rc_ready",
      actions: [{ kind: "spawn_task" }],
    };
    const needsHuman = waiting("dc_needs_human", { actions: [] });
    expect(waitingQueue([readyElsewhere, needsHuman])).toEqual([needsHuman]);
  });
});

test("Artifacts 只绑定 artifact.task 与 Task.proof，proof 排第一", () => {
  const task = { ref: "HAT-42", folder: "/repo", machine: "vm", proof: { id: "art-proof", title: "Proof" } };
  const at = (id: string, extra: Record<string, any> = {}) => ({ id, folder: "/repo", machine: "vm", at: 1, ...extra });
  const arts = [
    at("art-explicit-old", { task: "HAT-42" }),
    at("art-explicit-new", { task: "HAT-42", at: 2 }),
    at("art-proof", { at: 0 }),
    at("art-publisher", { versions: [{ publisher: "t88", at: 3 }], at: 3 }),
    at("art-case", { task: "hat-42" }),
    at("art-local", { task: "HAT-42", machine: null }),
    at("art-other-folder", { task: "HAT-42", folder: "/other" }),
  ];
  expect(taskArtifacts(arts, task)).toEqual(["art-proof", "art-explicit-new", "art-explicit-old"]);
  expect(taskArtifacts(arts, { ...task, proof: null })).toEqual(["art-explicit-new", "art-explicit-old"]);
  expect(taskArtifacts(arts, { ...task, ref: "OTHER-1", proof: null })).toEqual([]);
});

test("Receipts 按 Task ref 关联，保留每次 ready 并按时间倒序", () => {
  const task = { ref: "HAT-42" };
  const receipt = (id: string, ref: string, received_at: string, summary: string) => ({
    id, task: { id: ref }, received_at, summary, details: "details",
    proof: { id: `proof-${id}`, title: "Proof", refs: [`artifact:proof-${id}`] },
  });
  const rows = taskReceipts([
    receipt("rc_old", "HAT-42", "2026-11-20T10:00:00Z", "old"),
    receipt("rc_other", "HAT-43", "2026-11-22T10:00:00Z", "other"),
    receipt("rc_new", "hat-42", "2026-11-21T10:00:00Z", "new"),
  ], task);
  expect(rows.map((r) => r.id)).toEqual(["rc_new", "rc_old"]);
  expect(receiptTitle(rows[0])).toBe("new");
  expect(receiptProofRefs(rows[0])).toEqual(["artifact:proof-rc_new"]);
});

test("Orphan Tasks project todo/running/ready/done and deduplicate only canonical refs", () => {
  const states = ["todo", "running", "ready", "done"];
  const tasks = states.map((state, i) => ({
    id: i + 1, key: `collie#${i + 1}`, ref: `COLL-${i + 1}`, title: state, state, space: "sp",
    created_at: 1, started_at: 2, ready_at: 3, done_at: 4,
  }));
  const groups = [{ folder: "/repo/collie", slug: "collie", tasks }];
  const orphans = orphanTickets([], groups);
  expect(orphans.map((d) => d.id)).toEqual(["task:COLL-1", "task:COLL-2", "task:COLL-3", "task:COLL-4"]);
  expect(orphans.map((d) => ticketStage(d, taskTarget(d, null, groups)))).toEqual(["todo", "working", "needs", "settled"]);
  expect(orphanTickets([{ id: "dc_linked", run: { task_ref: "COLL-2" } }], groups).map((d) => d.id))
    .toEqual(["task:COLL-1", "task:COLL-3", "task:COLL-4"]);
  expect(orphanTickets([{ id: "dc_legacy", run: { task_ref: "collie#2" } }], groups)).toHaveLength(4);
});
test("Tab counts read only ready Tasks and live blocked agents", () => {
  const source = readFileSync(new URL("../mods/collie-tabs/inbox-engine.js", import.meta.url), "utf8");
  expect(source).toContain('if (x.state !== "ready") continue');
  expect(source).toContain('kind: x.state');
  expect(source).toContain('x.kind === "ready" && !x.live?.some((a) => blocked.has(a))');
  expect(source).toContain('k.status === "blocked"');
  expect(source).not.toContain("merge_requested");
  expect(source).not.toContain('"auto", "list"');
  expect(source).not.toContain("inbox.autos");
});

type LayoutNode = {
  id?: string;
  content?: { mod?: string };
  children?: LayoutNode[];
};

test("layout 只保留 collie 自有页面，不再挂 shep 的 Tasks/Assistant 页面", () => {
  const layout: unknown = JSON.parse(
    readFileSync(new URL("../layouts/collie.json", import.meta.url), "utf8"),
  );
  let panel: LayoutNode | undefined;
  let ticketBody: LayoutNode | undefined;
  const ids: string[] = [];
  const mods: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    // JSON.parse output is walked by this test only; the fields read below exist in the layout schema.
    const node = value as LayoutNode;
    if (node.id) ids.push(node.id);
    if (typeof node.content?.mod === "string") mods.push(node.content.mod);
    if (node.id === "panel-body") panel = node;
    if (node.id === "collie-ticket-body") ticketBody = node;
    Object.values(node).forEach(visit);
  };
  visit(layout);
  expect(panel?.children?.map((child) => child.id)).toEqual(["files", "collie", "receipts"]);
  expect(panel?.children?.[2].content).toEqual({ mod: "collie-inbox", props: { view: "receipts-panel" } });
  expect(ticketBody?.children?.map((child) => child.id)).toEqual([
    "collie-ticket-term",
    "collie-ticket-detail",
    "collie-ticket-receipts",
  ]);
  for (const banned of ["files", "changes", "tasks", "artifacts", "task-pr", "task-browser"]) {
    expect(mods).not.toContain(banned);
  }
  expect(new Set(ids).size).toBe(ids.length);
});

test("ticket 详情使用固定的 Terminal 与 Detail 布局", () => {
  const layout = JSON.parse(readFileSync(new URL("../layouts/collie.json", import.meta.url), "utf8"));
  const node = (value: any, id: string): any => value?.id === id ? value
    : (value?.children ?? []).map((child: any) => node(child, id)).find(Boolean) ?? null;
  const ticket = node(layout, "collie-ticket");
  const body = node(layout, "collie-ticket-body");
  expect(ticket.type).toEqual("column");
  expect(ticket.children.map((child: any) => child.id)).toEqual(["collie-ticket-head", "collie-ticket-body"]);
  expect(ticket.children[0]).toMatchObject({
    type: "block", size: { px: 127 }, content: { mod: "collie-inbox", props: { view: "head" } },
  });
  expect(body.type).toEqual("stack");
  expect(body.children.map((child: any) => child.id)).toEqual(["collie-ticket-term", "collie-ticket-detail", "collie-ticket-receipts"]);
  expect(body.children[0].content).toEqual({ agent: "focused" });
  expect(body.children[1].content).toEqual({ mod: "collie-inbox", props: { view: "detail" } });
  expect(body.children[2].content).toEqual({ mod: "collie-inbox", props: { view: "receipts" } });
  expect(body.active).toEqual("collie-ticket-detail");
  const stack = node(layout, "collie");
  expect(stack.type).toEqual("stack");
  expect(stack.children.map((child: any) => child.id)).toEqual(["collie-list", "collie-ticket"]);
  expect(stack.active).toEqual("collie-list");

});

test("Inbox 的过滤器对应四个 Work 状态，回复回到 coordinator chat", () => {
  const source = readFileSync(new URL("../mods/collie-inbox/main.js", import.meta.url), "utf8");
  expect(source).toContain('[["all", "All"], ["needs", "Needs you"], ["todo", "Todo"], ["working", "Working"], ["settled", "Settled"]]');
  expect(source).not.toContain('["thinking", "Thinking"]');
  expect(source).not.toContain('["progress", "In progress"]');
  expect(source).toContain('id(`inbox-actions-${decision.id}`)');
  expect(source).toContain("async function replyToCoordinator");
  expect(source).toContain("replyContext(decision, target, receipt)");
  expect(source).toContain("function coordinatorAgent(chat)");
  expect(source).toContain("chatPane(k) === chat.pane");
  expect(source).toContain('k.labels?.[SLOT] === slot');
  expect(source).toContain('exec("hc", ["send", addr, replyContext(decision, target, receipt)]');
  expect(source).toContain('["accept", "Accept"');
  expect(source).toContain('["archive", "Archive"');
  expect(source).toContain('["quote", "Quote"');
  expect(source).not.toContain('["delete", "Delete"');
  expect(source).toContain('at: "pointer"');
  expect(source).toContain("closeOverlay(id)");
  expect(source).not.toContain("delete-confirm");
  expect(source).toContain('id("accept-confirm")');
  expect(source).toContain("replyToCoordinator(decision, target, receipt)");
  expect(source).toContain('run("pane.focus", { pane: chat.pane })');
  expect(source).not.toContain("collie-quote");
  expect(source).not.toContain("openDecision");
  expect(source).not.toContain("answerDecision");
  expect(source).not.toContain("primaryAction");
  expect(source).not.toContain("Input.new");
  expect(source).not.toContain("this.tickets");
  expect(source).not.toContain("collie-request");
  expect(source).toContain("openViewer");
  expect(source).toContain("receiptProofRefs");
  expect(source).not.toContain('div().font_semibold().child("Inbox")');
  expect(source).not.toContain('child("New / Build")');
  expect(source).toContain('filterAction(`inbox-${id}`, label, this.filter === id');
  expect(source).not.toContain('exec(CLI(), ["accept"');
});


describe("mods/collie-inbox navigation targets", () => {
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
      agents: [{ address: "t88", log: "/logs/t88.jsonl", at: 1 }],
      proof: { id: "art-proof-0001", title: "Proof" },
      depends_on: ["HAT-41"],
      base_set: true,
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
      base_set: true,
      agents: [{ address: "t88", log: "/logs/t88.jsonl", at: 1 }],
      proof: { id: "art-proof-0001", title: "Proof" },
      depends_on: ["HAT-41"],
      key: { machine: null, folder: "/repo/collie", slug: "hat", id: 42 },
    });
  });

  test("ticket terminal 固定 driver，不因 helper 最后启动而漂移", () => {
    const withHelpers = [{
      ...groups[0],
      tasks: [{ ...groups[0].tasks[0], live: [
        { address: "t90", role: "reviewer", status: "working" },
        { address: "t88", role: "worker", status: "working" },
      ] }],
    }];
    expect(taskTarget(decision, receipt, withHelpers)?.terminal).toBe("t88");
  });

  test("helper-only 不抢占 Terminal，保留 reviewer tab 与 ended-driver 历史", () => {
    const task = groups[0].tasks[0];
    const helperOnly = [{
      ...groups[0],
      tasks: [{ ...task, agents: [], live: [{ address: "t90", role: "reviewer", status: "working" }] }],
    }];
    const target = taskTarget(decision, receipt, helperOnly);
    expect(target?.terminal).toBeNull();
    expect(taskAgents(target, [])).toEqual([{ address: "t90", role: "reviewer", status: "working" }]);

    const endedDriver = [{
      ...groups[0],
      tasks: [{ ...task, live: [{ address: "t90", role: "reviewer", status: "working" }] }],
    }];
    expect(taskTarget(decision, receipt, endedDriver)?.terminal).toBe("t88");
  });
  test("已完成 reviewer 仍保留 Ticket role terminal 入口", () => {
    const target = taskTarget(decision, receipt, groups);
    const terms = [{
      address: "t113", state: "finished", status: null,
      labels: { "herdr.task": "hat#42", "herdr.role": "reviewer" },
    }];
    expect(taskAgents(target, terms)).toEqual([{ address: "t113", status: null, role: "reviewer" }]);
  });

  test("没有 Task ref 时显示 Decision id，不伪造 COLLIE 前缀", () => {
    expect(ticketRef({ id: "dc_981784fe037a4e91", run: {} }, null)).toBe("dc_981784fe037a4e91");
    expect(ticketRef({ id: "dc_other", run: { task_ref: "mier-12" } }, null)).toBe("MIER-12");
    expect(ticketRef({ id: "dc_other", run: {} }, { ref: "mate-2" })).toBe("MATE-2");
  });

  test("open decision 只用 canonical run.task_ref 找到同一个 task", () => {
    const open = { ...decision, state: "open", run: { task_ref: "HAT-42" } };
    expect(taskTarget(open, null, groups)).toMatchObject({
      ref: "HAT-42", folder: "/repo/collie", state: "running", terminal: "t88",
    });
    expect(taskTarget({ ...open, run: { task_ref: "hat#42" } }, null, groups)).toBeNull();
    expect(taskTarget({ ...open, run: { task_ref: "42" } }, null, groups)).toBeNull();
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
  });

  test("不错误跳转：receipt 不属于 decision 或 task 不唯一时无目标", () => {
    expect(taskTarget(decision, { ...receipt, decision_ref: "dc_other" }, groups)).toBeNull();
    expect(taskTarget(decision, receipt, [...groups, ...groups])).toBeNull();
  });
});

describe("chrome / tabs / settings / toasts 自包含（#8）", () => {
  const file = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  // The files #8 rewrote: no shep asset, no shep shared key, no shep settings read.
  const files = [
    "mods/collie-chrome/main.js",
    "mods/collie-tabs/main.js",
    "mods/collie-tabs/coordinator.js",
    "mods/collie-tabs/inbox-engine.js",
    "mods/collie-tabs/core/spaces.js",
    "mods/collie-pane-chat/main.js",
    "mods/collie-settings/main.js",
    "mods/collie-artifacts/main.js",
    "mods/collie-artifacts/bar.js",
    "lib/artview.js",
    "mods/collie-inbox/lib/artview.js",
    "mods/collie-artifacts/lib/artview.js",
    "mods/collie-artifacts/lib/ui.js",
    "lib/ui.js",
    "mods/collie-inbox/lib/ui.js",
    "mods/collie-tabs/lib/ui.js",
    "mods/collie-chrome/lib/ui.js",
    "mods/collie-settings/lib/ui.js",
    "layouts/collie.json",
  ];

  test("不再引用 shep 资产、shep shared key 或 tabs-tasks 动作", () => {
    const banned = [
      "workspace-chrome-shepherdr",
      "shepherdr-settings",
      "mods/toasts",
      '"toasts"',
      "chat.calls",
      "chat.callreq",
      "voice.startreq",
      "tabs-tasks.",
      "counts.red",
      "counts.green",
      "tabbar.tabs",
      "openSettings",
      "hasToasts",
    ];
    for (const path of files) {
      const source = file(path);
      for (const word of banned) expect([path, word, source.includes(word)]).toEqual([path, word, false]);
      // The sidebar and pane-header mods (#7, and Shepherdr's pane-chat) are only named where a layout mounts them;
      // collie's own collie-pane-chat is not Shepherdr's pane-chat.
      for (const gone of ["spaces-chat", "pane-chat", "chat-call"]) {
        const word = new RegExp(`(^|[^\\w-])${gone.replace(/-/g, "\\-")}\\b`);
        expect([path, gone, word.test(source)]).toEqual([path, gone, false]);
      }
    }
  });

  test("每个引用的 mods/<mod>/<file>.svg 都存在", () => {
    const root = new URL("../", import.meta.url);
    for (const path of files) {
      for (const [svg] of file(path).matchAll(/mods\/[\w./-]+\.svg/g)) {
        expect([path, svg, existsSync(new URL(svg, root))]).toEqual([path, svg, true]);
      }
    }
  });

  test("toast() 交给 herdr 的 notify()，alert 变 error", () => {
    const source = file("lib/ui.js");
    expect(source).toContain("return notify({ ...n, level: n.level === \"alert\" ? \"error\" : n.level ?? \"info\" });");
    expect(source).not.toContain("setShared");
  });

  test("layout 用 herdr 的 workspace-status，不再挂 shep 的 toasts", () => {
    const layout: unknown = JSON.parse(file("layouts/collie.json"));
    const mods: string[] = [];
    const ids: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      const node = value as { id?: string; content?: { mod?: string }; children?: unknown[] };
      if (node.id) ids.push(node.id);
      if (node.content?.mod) mods.push(node.content.mod);
      Object.values(node).forEach(visit);
    };
    visit(layout);
    expect(mods).not.toContain("toasts");
    expect(mods).toContain("workspace-status");
    expect(mods).not.toContain("workspace-status-chat");
    expect(ids).not.toContain("toasts");
    // #6's artifacts and #7's chat are collie's own mods now; the sidebar is herdr's shipped one and the pane header
    // is collie's port of Shepherdr's pane-chat.
    expect(mods).toContain("spaces");
    expect(mods).toContain("collie-pane-chat");
    expect(mods).not.toContain("pane");
    expect(mods).not.toContain("collie-artifacts");
    expect(mods).not.toContain("task-artifacts");
    for (const gone of ["spaces-chat", "pane-chat", "chat-call", "chat"]) expect(mods).not.toContain(gone);
    expect(ids).not.toContain("chat-call");
  });

  test("service unit 的 PATH 包含 collie helper 目录", () => {
    const source = file("bin/collie");
    expect(source).toContain("{root}/.local/bin:{root}/.config/herdr-app/bin:");
  });

  test("mod runtime 不直接读 process.env（Herdr 全局没有 process）", () => {
    for (const path of [
      "mods/collie-inbox/main.js",
      "mods/collie-tabs/inbox-engine.js",
      "mods/collie-tabs/tick.js",
      "mods/collie-chat/secrets.js",
    ]) expect([path, file(path).includes("process.env")]).toEqual([path, false]);
  });
});

test("Coordinator helper 有活终端时自动拿到 pane，不藏在后台", () => {
  const source = readFileSync(new URL("../mods/collie-chat/main.js", import.meta.url), "utf8");
  expect(source).toContain('const live = terminals().find((k) => k.state === "live" && k.labels?.["herdr.role"] === "helper")');
  expect(source).toContain('if (live && !panes().some((p) => p.terminal === live.address))');
  expect(source).toContain('this.openHelperTab({ address: live.address, role: "helper", label: "Helper" }, cx)');
  expect(source).toContain("ensureTerminalTab({ terminal: live.address, name: \"Helper\", focus: true, cx })");
});

test("Coordinator startup injects the installed Collie CLI skill", () => {
  const source = readFileSync(new URL("../mods/collie-chat/main.js", import.meta.url), "utf8");
  expect(source).toContain('cat "$HOME/.config/collie/skills/cli/SKILL.md"');
  expect(source).toContain("const skillBody = skillSrc.replace");
  expect(source).toContain("const body = [rawBody.trim(), skillBody]");
});

test("tick wrapper runs local and deduplicated remote ticks without a service handoff", async () => {
  const calls: Array<[string, string[]]> = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    return cmd === "sh" ? { stdout: "vm\nvm.secret\nlaptop\n" } : { stdout: "" };
  };
  const terminals = () => [
    { address: "vm/t1", state: "live", labels: { "herdr.role": "coordinator" } },
    { address: "laptop/t2", state: "live", labels: { "herdr.resume": "yes" } },
    { address: "t3", state: "live", labels: { "herdr.role": "coordinator" } },
  ];
  await runTick({ exec, cli: "/bin/collie-task", store: "/store", terminals });
  expect(calls).toEqual([
    ["/bin/collie-task", ["tick", "--json"]],
    ["sh", ["-c", 'ls "$1/.remote" 2>/dev/null; true', "x", "/store"]],
    ["/bin/collie-task", ["--on", "vm", "tick", "--json"]],
    ["/bin/collie-task", ["--on", "laptop", "tick", "--json"]],
  ]);
});

test("chat logs keep publish commands as tools, never inferred artifact cards", () => {
  const claude = new Conversation("claude");
  claude.feed([{ off: 1, kind: "J", data: JSON.stringify({
    type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Bash", input: { command: "collie-artifact publish ./proof" } }] },
  }) }]);
  const codex = new Conversation("codex");
  codex.feed([{ off: 1, kind: "J", data: JSON.stringify({
    type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: { command: "collie-artifact update art-1 ./proof" } },
  }) }]);
  for (const conversation of [claude, codex]) {
    expect(conversation.items.some((item) => item.kind === "artifact")).toBe(false);
    expect(conversation.items.some((item) => item.kind === "tools")).toBe(true);
  }
});

test("current chat labels retain their terminal machine; old prefixed labels are not normalized", () => {
  expect(chatPane({ address: "vm/t1", labels: { "herdr.chat": "p9" } })).toBe("vm/p9");
  expect(chatPane({ address: "vm/t1", labels: { "herdr.chat": "vm/p9" } })).toBe("vm/vm/p9");
  expect(chatPane({ address: "t1", labels: { "herdr.chat": "p9" } })).toBe("p9");
  expect(tabName("tb12", "Codex")).toBe("Codex");
  expect(tabName("Build", "Codex")).toBe("Build");
});

