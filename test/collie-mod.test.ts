import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffTarget,
  parseQueue,
  queuePath,
  receiptPath,
  settledDecisions,
  STAGE_WORD,
  ticketGroup,
  ticketNeed,
  ticketStage,
  todoReason,
  workingDecisions,
  workKind,
  taskTarget,
  waitingQueue,
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
    expect(ticketStage({ ...base, state: "open" }, { state: "queued" })).toBe("todo");
    expect(ticketStage({ ...base, state: "open" }, { state: "scheduled" })).toBe("todo");
    expect(ticketStage({ ...base, state: "open" }, { state: "running" })).toBe("working");
    expect(ticketStage({ ...base, state: "open" }, { state: "running" }, { worker: true })).toBe("working");
    expect(ticketStage({ ...base, state: "open" }, { state: "running" }, { worker: true, reviewer: true })).toBe("working");
    expect(ticketStage({ ...base, state: "open" }, { state: "running" }, { worker: true, blocked: true })).toBe("needs");
    expect(ticketStage({ ...base, state: "open", run: { task_ref: "HAT-42" } }, null)).toBe("working");
    expect(ticketStage({ ...base, state: "settled", settled: { at: "2026-11-13T11:00:00Z" } }, null)).toBe("settled");
    expect(Object.keys(STAGE_WORD)).toEqual(["needs", "todo", "working", "settled"]);
    expect(ticketNeed({ ...base, receipt_ref: "rc_stage" })).toBe("ready");
    expect(workKind({ ...base, state: "open", run: { kind: "review" } }, { state: "running" }, { worker: true })).toBe("review");
    expect(workKind({ ...base, state: "open", run: { kind: "build" } }, { state: "merging" }, { worker: true })).toBe("merge");
    expect(workKind({ ...base, state: "open" }, { state: "running" }, { worker: true })).toBe("build");
  });

  test("Todo 的原因来自 herdr-task：依赖 / 容量 / 定时 / 未开始", () => {
    expect(todoReason({ state: "queued", after: ["PS-3"] }, { why: "x" })).toBe("after PS-3");
    expect(todoReason({ state: "queued", waiting_ext: ["vm:WEB-2"] }, { why: "x" })).toBe("after vm:WEB-2");
    expect(todoReason({ state: "queued" }, { why: "x" })).toBe("waiting for a slot");
    expect(todoReason({ state: "scheduled" }, { why: "x" })).toBe("scheduled");
    expect(todoReason({ state: "todo" }, { why: "x" })).toBe("not started");
    expect(todoReason(null, { why: "why x" })).toBe("why x");
  });

  test("分组：Needs you 置顶、space 内 Todo → Working、Settled 收在最后", () => {
    const item = (id: string, stage: string, space: string, at: string) => ({
      decision: { id, stage, space, decided_at: at }, stage,
    });
    const groups = ticketGroup([
      item("w_old", "working", "beta", "2026-11-13T10:00:00Z"),
      item("w_new", "working", "beta", "2026-11-13T12:00:00Z"),
      item("t", "todo", "beta", "2026-11-13T09:00:00Z"),
      item("n", "needs", "alpha", "2026-11-13T11:00:00Z"),
      item("s", "settled", "alpha", "2026-11-13T13:00:00Z"),
    ], ["alpha", "beta"]);
    expect(groups.top.map((x) => x.decision.id)).toEqual(["n"]);
    expect(groups.spaces.map((x) => x.key)).toEqual(["beta"]);
    expect(groups.spaces[0].rows.map((x) => x.decision.id)).toEqual(["t", "w_new", "w_old"]);
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
  expect(panel?.children?.map((child) => child.id)).toEqual(["files", "collie", "artifacts", "working"]);
  expect(ticketBody?.children?.map((child) => child.id)).toEqual([
    "collie-ticket-artifacts",
  ]);
  for (const banned of ["files", "changes", "tasks", "artifacts", "task-pr", "task-browser"]) {
    expect(mods).not.toContain(banned);
  }
  expect(new Set(ids).size).toBe(ids.length);
});

test("Inbox 是顶部 panel 页签，ticket 详情留在 Inbox 内", () => {
  const top = readFileSync(new URL("../mods/collie-tabs/main.js", import.meta.url), "utf8");
  const source = readFileSync(new URL("../mods/collie-inbox/main.js", import.meta.url), "utf8");
  expect(top).toContain('panelButton("collie", "Inbox"');
  expect(source).toContain('run("layout.select", { stack: STACK, child: TICKET })');
  expect(source).toContain('run("layout.select", { stack: BODY, child });');
  expect(source).not.toContain('"tasks-thread"');
  expect(source).not.toContain('collie-detail');
  expect(source).not.toContain('decisionId');
  expect(source).not.toContain("standalone");
});

test("mod 只导入包内共享库拷贝，不越过 herdr 模块边界", () => {
  const source = readFileSync(new URL("../mods/collie-inbox/main.js", import.meta.url), "utf8");
  expect(source).toContain('from "./lib/inbox-queue.js"');
  expect(source).toContain('from "./lib/artview.js"');
  expect(source).toContain('from "./core/task-artifacts.js"');
  expect(source).not.toContain('from "../../lib/');
  expect(source).not.toContain('"tasks-thread"');
  expect(source).not.toContain('collie-detail');
  expect(source).not.toContain('decisionId');
  const shared = readFileSync(new URL("../lib/inbox-queue.js", import.meta.url), "utf8");
  const copied = readFileSync(new URL("../mods/collie-inbox/lib/inbox-queue.js", import.meta.url), "utf8");
  expect(copied).toBe(shared);

  // #6: the ticket's list and the viewer's toolbar are one collie-owned mod.
  const arts = readFileSync(new URL("../mods/collie-artifacts/main.js", import.meta.url), "utf8");
  expect(arts).toContain('from "./lib/artview.js"');
  expect(arts).toContain('from "./core/task-artifacts.js"');
  expect(arts).toContain('from "./lib/ui.js"');
  expect(arts).toContain('from "./bar.js"');
  expect(arts).not.toContain('from "../');
  expect(arts).not.toContain("chat-image");
  expect(arts).not.toContain("artifact-sidebar");
  const bar = readFileSync(new URL("../mods/collie-artifacts/bar.js", import.meta.url), "utf8");
  expect(bar).toContain('from "./lib/artview.js"');
  expect(bar).toContain('from "./lib/ui.js"');
  expect(bar).not.toContain('from "../');
  expect(bar).not.toContain("chat-image");
  expect(bar).not.toContain("artifact-sidebar");
  expect(bar).not.toContain("panel-right");
});

test("ticket 详情复用 shepherdr 的任务视图，只留 Terminal 与 Artifacts", () => {
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
  expect(body.children.map((child: any) => child.id)).toEqual(["collie-ticket-artifacts"]);
  expect(body.children[0].content).toEqual({ mod: "collie-artifacts" });
  expect(body.active).toEqual("collie-ticket-artifacts");
  const stack = node(layout, "collie");
  expect(stack.type).toEqual("stack");
  expect(stack.children.map((child: any) => child.id)).toEqual(["collie-list", "collie-ticket"]);
  expect(stack.active).toEqual("collie-list");

  const source = readFileSync(new URL("../mods/collie-inbox/main.js", import.meta.url), "utf8");
  expect(source).toContain('["terminal", "Terminal", { disabled: !live }]');
  expect(source).toContain('["artifacts", this.artsLabel(), {}]');
  expect(source).toContain('segmented("collie-thread-mode"');
  expect(source).not.toContain('"Chat"');
  expect(source).not.toContain('"Files"');
  expect(source).not.toContain('"Changes"');
  expect(source).not.toContain('"Pull request"');
  expect(source).not.toContain('"Browser"');
  expect(source).toContain('id: TERM, type: "block", content: { terminal: address }');
  expect(source).toContain('setShared("tasks.thread.artifacts"');
  expect(source).toContain('setShared("tasks.thread", threadOf(target, decision))');
  expect(source.match(/taskDot\(stage === "needs" \? need : stage, \{ pct, halo: stage === "needs" && need === "needs" \}\)/g)).toHaveLength(2);
  expect(source).toContain("STAGE_WORD[stage] ?? stage");
  const dot = readFileSync(new URL("../lib/ticket-dot.js", import.meta.url), "utf8");
  expect(dot).toContain("mods/collie-inbox/task/pie/");
  expect(dot).toContain("mods/collie-inbox/task/tick.svg");
  const copied = readFileSync(new URL("../mods/collie-inbox/lib/ticket-dot.js", import.meta.url), "utf8");
  expect(copied).toBe(dot);
  expect(source).toContain("label: STAGE_WORD.needs");
  expect(source).toContain("this.spaceHead(t, group.key, group.rows.length)");
  expect(source).toContain("this.settledLine(t)");
  expect(source).toContain("${STAGE_WORD.settled} ${this.groups.settled.length}");
  expect(source).toContain("ticketGroup(this.staged");
});

test("Inbox 的过滤器对应四个 Work 状态，回复回到 coordinator chat", () => {
  const source = readFileSync(new URL("../mods/collie-inbox/main.js", import.meta.url), "utf8");
  expect(source).toContain('[["all", "All"], ["needs", "Needs you"], ["todo", "Todo"], ["working", "Working"], ["settled", "Settled"]]');
  expect(source).not.toContain('["thinking", "Thinking"]');
  expect(source).not.toContain('["progress", "In progress"]');
  expect(source).toContain('action(`collie-reply-${decision.id}`, "回复"');
  expect(source).toContain("async function replyToCoordinator");
  expect(source).toContain("replyContext(decision, target, receipt)");
  expect(source).toContain("function coordinatorAgent(chat)");
  expect(source).toContain("chatPane(k) === chat.pane");
  expect(source).toContain('k.labels?.[SLOT] === slot');
  expect(source).not.toContain("chat.terminal");
  expect(source).toContain('exec("hc", ["send", addr, replyContext(decision, target, receipt)]');
  expect(source).toContain('run("pane.focus", { pane: chat.pane })');
  expect(source).not.toContain("collie-quote");
  expect(source).not.toContain("openDecision");
  expect(source).not.toContain("answerDecision");
  expect(source).not.toContain("primaryAction");
  expect(source).not.toContain("Input.new");
  expect(source).not.toContain("this.tickets");
  expect(source).not.toContain("collie-request");
  expect(source).toContain('openViewer({ id: receipt.proof.id');
  expect(source).not.toContain('div().font_semibold().child("Inbox")');
  expect(source).not.toContain('child("New / Build")');
  expect(source).toContain('filterAction(`inbox-${id}`, label, this.filter === id');
  expect(source).toContain("receipt?.proof?.id");
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
      proof: "art-proof-0001",
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
      proof: "art-proof-0001",
      key: { machine: null, folder: "/repo/collie", slug: "hat", id: 42 },
    });
    expect(diffTarget(target)).toEqual({
      cwd: "/worktrees/collie/inbox",
      on: undefined,
      range: "9f2c1ab...HEAD",
    });
  });

  test("open decision 没有 receipt 时用 run.task_ref 找到同一个 task", () => {
    const open = { ...decision, state: "open", run: { task_ref: "hat#42" } };
    expect(taskTarget(open, null, groups)).toMatchObject({
      ref: "HAT-42", folder: "/repo/collie", state: "running", terminal: "t88",
    });
    const byRef = { ...open, run: { task_ref: "HAT-42" } };
    expect(taskTarget(byRef, null, groups)?.ref).toBe("HAT-42");
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
    expect(mods).toContain("collie-artifacts");
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
