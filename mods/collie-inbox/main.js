// One Inbox workbench: canonical Decision and Task refs, live roles, and settled history.
// All rows come from the Ledger projection; collie-task is read only for navigation.
// A ticket opens on Detail, with Terminal and task-local Role / Agent views.
import { View, div, svg } from "gpui-kit";
import { TextView } from "gpui-base";
import {
  appHome, closeOverlay, exec, focused, home, layout, openOverlay, panes, props, readTextFile, run,
  setShared, shared, spaces, terminals, theme, writeTextFile,
} from "herdr";
import {
  parseQueue, queuePath, receiptPath, STAGE_WORD, taskTarget, orphanTickets, taskAgents,
  ticketGroup, ticketNeed, ticketRef, ticketStage, todoReason, waitingQueue, workKind, workingCount,
} from "./lib/inbox-queue.js";
import { ownProgress, taskDot } from "./lib/ticket-dot.js";
import { openViewer } from "./lib/artview.js";
import { SLOT, chatPane } from "./core/spaces.js";
import { taskReceipts, sortReceipts, receiptTitle, receiptProofRefs } from "./core/task-receipts.js";
import { RADIUS, TEXT, plainError, segmented, toast } from "./lib/ui.js";

const v = () => div().flex().flex_col();
const h = () => div().flex().flex_row();
const CLI = () => (globalThis.process?.env?.COLLIE_TASK_CLI) ?? `${appHome()}/bin/collie-task`;
const COLLIE_CLI = () => `${appHome()}/bin/collie`;
const RECEIPTS_CLI = () => (globalThis.process?.env?.COLLIE_RECEIPTS_CLI) ?? `${appHome()}/bin/collie-receipts`;
const ANSWER_CLI = () => (globalThis.process?.env?.COLLIE_ANSWER_CLI) ?? `${appHome()}/bin/collie-answer`;
const ticket = () => shared("collie.ticket") ?? null;
const actionTicket = () => shared("collie.action") ?? ticket() ?? {};
function closeActionOverlay() {
  const id = shared("collie.actionOverlay");
  if (id) closeOverlay(id);
  setShared("collie.actionOverlay", null);
}
function closeAcceptOverlay() {
  const id = shared("collie.acceptOverlay");
  if (id) closeOverlay(id);
  setShared("collie.acceptOverlay", null);
}

// The ticket page: collie's task view nodes (the same ids in layouts/collie.json).
const STACK = "collie", LIST = "collie-list", TICKET = "collie-ticket";
const HEAD = "collie-ticket-head", BODY = "collie-ticket-body";
const TERM = "collie-ticket-term", DETAIL = "collie-ticket-detail", RECEIPTS = "collie-ticket-receipts";
const EDGE = 12;
const ID_FONT = "JetBrains Mono";
const RECEIPTS_EVERY = 15000;

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) { const hit = find(child, id); if (hit) return hit; }
  return null;
}

const isLive = (address) => Boolean(address) && terminals().some((k) => k.address === address && k.state === "live");
const receiptsKeyOf = (target) => `${target?.machine ?? ""}|${target?.folder ?? ""}|${target?.ref ?? ""}`;

// The % done a working ticket shows: its agent's own report first (as the agent reports), else collie-task's.
function pctOf(target) {
  const own = ownProgress([target?.terminal]);
  const done = target?.progress?.done;
  return typeof own?.pct === "number" ? own.pct : typeof done === "number" ? done : null;
}

// Minutes the agent said are left (collie-task status), counted down while it works.
function minutesLeft(progress) {
  if (typeof progress?.left !== "number") return null;
  const left = Math.max(0, progress.left - ((progress.paused_at ?? Date.now()) - (progress.at ?? Date.now())));
  return left < 60000 ? 0 : Math.ceil(left / 60000);
}

const shortLeft = (minutes) => minutes == null ? null : minutes < 1 ? "<1m" : minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
const selectableText = (id, text) => TextView.markdown(id, String(text ?? " ")).raw_html(false).selectable(true);

function copyTaskTitle(title, cx) {
  cx.write_to_clipboard(String(title));
  toast({ title: "Task name copied", body: String(title), level: "success" });
}

// Who is at work on the ticket: the task's live agents, by herdr.role. A build's reviewer is a
// helper agent (never in the task's agents), so its terminal's label is the authority.
function liveRoles(target) {
  const key = target?.key;
  const label = key ? `${key.slug}#${key.id}` : null;
  const record = Array.isArray(target?.live) ? target.live : [];
  const terms = label ? terminals().filter((k) => k.state === "live" && k.labels?.["herdr.task"] === label) : [];
  const has = (role) => record.some((a) => a.role === role && a.status !== "done")
    || terms.some((k) => k.labels?.["herdr.role"] === role && k.status !== "done");
  const helper = (role) => Boolean(role) && role !== "driver" && role !== "worker";
  const driver = record.some((a) => !helper(a.role) && a.status !== "done")
    || terms.some((k) => !helper(k.labels?.["herdr.role"]) && k.status !== "done");
  const blocked = record.some((a) => a.status === "blocked") || terms.some((k) => k.status === "blocked");
  const other = record.some((a) => helper(a.role) && !["reviewer", "verifier"].includes(a.role) && a.status !== "done")
    || terms.some((k) => helper(k.labels?.["herdr.role"]) && !["reviewer", "verifier"].includes(k.labels?.["herdr.role"]) && k.status !== "done");
  return { driver, reviewer: has("reviewer"), verifier: has("verifier"), other, blocked };
}

const roleName = (role) => role ? role.charAt(0).toUpperCase() + role.slice(1) : "Agent";
const roleTabName = (agent, agents) => {
  const base = roleName(agent.role);
  const same = agents.filter((item) => item.role === agent.role);
  return same.length <= 1 ? base : `${base} ${same.findIndex((item) => item.address === agent.address) + 1}`;
};

function agentHistoryLog(agent) {
  if (agent?.log?.path && agent.log.kind) return agent.log;
  try {
    const saved = JSON.parse(agent?.labels?.["herdr.resume"] ?? "null");
    return saved?.log && saved?.kind ? { path: saved.log, kind: saved.kind } : null;
  } catch { return null; }
}

const stageOf = (decision, target) => ticketStage(decision, target, liveRoles(target));
const kindOf = (decision, target) => workKind(decision, target, liveRoles(target));

// What the Receipts view and the header read (shared "tasks.thread" / "tasks.thread.receipts").
function threadOf(target, decision) {
  return {
    terminal: target?.terminal ?? null,
    task: target?.ref ?? decision?.run?.task_ref ?? decision?.id ?? null,
    title: target?.title ?? null,
    key: target?.key ?? null,
    log: target?.log ?? null,
    note: target?.note ?? null,
    at: Date.now(),
  };
}

function selectPage(child) {
  run("layout.select", { stack: "panel-body", child: STACK });
  run("layout.select", { stack: STACK, child: TICKET });
  if (child) run("layout.select", { stack: BODY, child });
  run("layout.show", { id: "panel" });
}

function backToInbox() {
  run("layout.select", { stack: STACK, child: LIST });
}

// One layout block shows the selected driver or Role agent, including read-only history.
// Writes are optimistic-concurrency checked so a concurrent layout edit is never overwritten.
async function pointContent(content, cx) {
  const path = `${appHome()}/layouts/${shared("layout")}.json`;
  for (let i = 0; ; i++) {
    const text = await readTextFile(path);
    const tree = JSON.parse(text ?? "null"), body = find(tree, BODY);
    if (!body) throw new Error("This layout has no ticket terminal.");
    const node = { id: TERM, type: "block", content };
    const at = body.children.findIndex((child) => child.id === TERM);
    if (at < 0) body.children.push(node); else body.children[at] = node;
    try { await writeTextFile(path, JSON.stringify(tree, null, 2), text); break; }
    catch (e) { if (i >= 2) throw e; }
  }
  const loaded = () => JSON.stringify(find(layout(), TERM)?.content) === JSON.stringify(content);
  for (let i = 0; i < 30 && !loaded(); i++) {
    await new Promise((done) => cx.timer.after(100, () => done()));
  }
  if (!loaded()) throw new Error("Herdr didn't load the selected agent.");
}

async function showTerminal(cx, agent = null, name = "Terminal") {
  const address = agent?.address ?? ticket()?.target?.terminal ?? null;
  const finished = agent?.state === "finished";
  if (!address || (!finished && !isLive(address))) return;
  try {
    const content = finished
      ? { mod: "collie-chat", props: { terminal: address, thread: true, title: name, log: agentHistoryLog(agent) } }
      : { terminal: address };
    if (finished && !content.props.log) throw new Error("This terminal has no readable session history.");
    setShared("collie.ticket.agent", agent?.address ?? null);
    if (JSON.stringify(find(layout(), TERM)?.content) !== JSON.stringify(content)) await pointContent(content, cx);
    selectPage(TERM);
    if (!finished) run("pane.focus", { terminal: address });
  } catch (e) {
    toast({ title: "Agent view didn't open", body: plainError(e), level: "error" });
  }
}

function showDetail() {
  setShared("collie.ticket.agent", null);
  selectPage(DETAIL);
}

// A ticket always opens on Detail; Terminal and Role views are explicit choices.
function openTicket(decision, target, receipt, _cx, showReceipt = false) {
  setShared("collie.ticket", { decision, target, receipt, at: Date.now() });
  setShared("collie.ticket.agent", null);
  setShared("tasks.thread.receipt", showReceipt ? receipt : null);
  setShared("tasks.thread", threadOf(target, decision));
  if (!target?.ref) setShared("tasks.thread.receipts", {
    ref: decision.run?.task_ref ?? decision.id,
    machine: target?.machine ?? null,
    list: receipt ? [receipt] : [],
  });
  selectPage(showReceipt ? RECEIPTS : DETAIL);
}

async function loadTasks() {
  try {
    const result = await exec(CLI(), ["list", "--all", "--json", "--slim"]);
    return result.code === 0 ? JSON.parse(result.stdout || "[]") : [];
  } catch { return []; }
}

async function navigation(decisions, groups = null) {
  const linked = decisions.filter((d) => d.receipt_ref || d.run?.task_ref);
  if (!linked.length) return new Map();
  const receipts = await Promise.all(linked.map(async (decision) => {
    const path = receiptPath(home(), decision.receipt_ref);
    if (path) {
      try { return JSON.parse(await readTextFile(path) ?? "null"); } catch { return null; }
    }
    return { decision_ref: decision.id, task: { id: decision.run.task_ref } };
  }));
  groups ??= await loadTasks();
  const entries = await Promise.all(linked.map(async (decision, i) => {
    const receipt = receipts[i];
    let target = taskTarget(decision, receipt, groups);
    if (target && (!target.start || !target.worktree)) {
      try {
        const shown = await exec(CLI(), ["show", target.ref, "--folder", target.folder, "--json"]);
        if (shown.code === 0) {
          const detail = JSON.parse(shown.stdout);
          target = taskTarget(decision, receipt, groups, detail);
        }
      } catch { /* keep the list-only target */ }
    }
    return [decision.id, { target, receipt }];
  }));
  return new Map(entries);
}

function filterAction(id, label, selected, onClick, t) {
  return h().id(id).h(24).px(9).flex_none().items_center().justify_center().rounded(6)
    .text_size(12).bg(selected ? t.selected : t.chrome).text_color(selected ? t.foreground : t.muted)
    .cursor_pointer().hover((s) => s.bg(selected ? t.selected : t.hover).text_color(t.foreground))
    .on_click((e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
    .child(label);
}

// Work state chips: semantic color, not a gray label. Accept cards keep the green tick's color.
function stateColor(t, stage, need = null) {
  if (stage === "needs") return need === "ready" ? t.ansi2 : t.ansi1;
  if (stage === "todo") return t.accent;
  if (stage === "working") return t.ansi3;
  return t.ansi2;
}

function stateChip(t, stage, need = null, kind = null, outcome = null) {
  const color = stateColor(t, stage, need);
  const gerund = kind === "build" ? "building" : kind === "review" ? "reviewing" : kind === "verify" ? "verifying" : null;
  const suffix = stage === "working" ? gerund : stage === "settled" ? outcome : null;
  const label = suffix ? `${STAGE_WORD[stage] ?? stage} · ${suffix}` : STAGE_WORD[stage] ?? stage;
  return h().flex_none().h(16).px(5).items_center().rounded(4).bg(color + "1f")
    .text_size(11).font_medium().text_color(color).child(label);
}

// The person's one action in the Inbox: hand this ticket to the coordinator chat as context,
// focus it, and let the LLM explain the evidence and suggest options. The person decides there.
function coordinatorChat() {
  const here = focused();
  const ps = panes();
  const chat = ps.find((p) => p.mod === "collie-chat" && p.tab === here?.tab) ?? ps.find((p) => p.mod === "collie-chat");
  if (chat) return chat;
  // A closed chat leaves its Coordinator terminal in the same tab. Quote must still reach it.
  const space = spaces().find((item) => item.id === here?.space) ?? spaces().find((item) => item.active);
  const agent = terminals().find((k) => k.state === "live"
    && (k.labels?.["herdr.role"] === "coordinator" || ["assistant", "coordinator"].includes(k.template))
    && k.labels?.["herdr.space"] === space?.id);
  if (!agent) return null;
  const tab = space?.tabs.find((item) => item.id === agent.labels?.["herdr.tab"]);
  if (!tab) return null;
  return { pane: ps.find((p) => p.terminal === agent.address)?.pane ?? null, tab: tab.id, terminal: agent.address };
}

// The agent a coordinator chat holds: the one parked behind its pane (herdr.chat), else the one its slot started
// (herdr.chat.slot; shared "coordinator.slots" says which pane a slot is). A chat pane is no terminal of its own,
// so the old reply, sent to the pane's terminal, was always dropped.
function coordinatorAgent(chat) {
  if (!chat) return null;
  if (chat.terminal) return chat.terminal;
  const parked = terminals().find((k) => k.state === "live" && chatPane(k) === chat.pane);
  if (parked) return parked.address;
  const slot = Object.entries(shared("coordinator.slots") ?? {}).find(([, s]) => s?.pane === chat.pane)?.[0] ?? null;
  if (!slot) return null;
  return terminals().find((k) => k.state === "live" && k.labels?.[SLOT] === slot)?.address ?? null;
}

function replyContext(decision, target, receipt) {
  const title = receipt?.summary ?? target?.title ?? decision.card?.question ?? decision.why;
  const lines = [
    `我想处理这张 Ticket：${ticketRef(decision, target)} · ${title}`,
    `Decision ${decision.id}`,
  ];
  if (receipt?.id) lines.push(`Receipt ${receipt.id}`);
  if (receipt?.details) lines.push(`交付细节：${receipt.details}`);
  const refs = receiptProofRefs(receipt);
  if (refs.length) lines.push(`可复核证据：${refs.join("、")}`);
  if (decision.why && decision.why !== title) lines.push(`Decision 背景：${decision.why}`);
  if (decision.card?.question && decision.card.question !== title && decision.card.question !== decision.why) {
    lines.push(`问题：${decision.card.question}`);
  }
  lines.push("请先只解读依据并给出建议，不要执行任何动作；等我在 chat 里确认。");
  return lines.join("\n");
}

async function replyToCoordinator(decision, target, receipt) {
  const chat = coordinatorChat();
  if (!chat) {
    toast({ title: "Coordinator unavailable", body: "Open the Coordinator chat before quoting this Receipt.", level: "error" });
    return false;
  }
  const addr = coordinatorAgent(chat);
  if (!addr) {
    toast({ title: "Coordinator unavailable", body: "The Coordinator chat has no live agent to receive this Quote.", level: "error" });
    return false;
  }
  try {
    const result = await exec("hc", ["send", addr, replyContext(decision, target, receipt)]);
    if (result.code !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || "hc send failed");
  } catch (error) {
    toast({ title: "Quote failed", body: plainError(error), level: "error" });
    return false;
  }
  const space = spaces().find((item) => item.tabs.some((tab) => tab.id === chat.tab));
  if (space && !space.active) run("space.select", { id: space.id });
  run("tab.select", { id: chat.tab });
  run("pane.focus", { pane: chat.pane });
  if (shared("collie.action")) {
    closeActionOverlay();
    closeAcceptOverlay();
  }
  return true;
}

function action(id, label, enabled, onClick, t) {
  return h().id(id).h(26).px(9).flex_none().items_center().justify_center().rounded(6)
    .text_size(12).text_color(enabled ? t.foreground : t.dim).border_1().border_color(t.border)
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); }))
    .child(label);
}

export default class Inbox extends View {
  init(_props, cx) {
    this.view = _props?.view ?? props()?.view ?? "queue";
    const kept = ["all", "needs", "todo", "working", "settled"];
    const saved = shared("inbox.filter") ?? "all";
    this.filter = kept.includes(saved) ? saved : "all";
    this.rows = [];
    this.staged = [];
    this.groups = { needs: [], todo: [], working: [], settled: [] };
    this.decisions = [];
    this.targets = new Map();
    this.receipts = new Map();
    this.error = null;
    this.loading = false;
    if (this.view === "queue") {
      try {
        this.settledOpen = localStorage.getItem("collie.settledOpen.v2") === "1";
      } catch { this.settledOpen = false; }
      try { this.folded = new Set(JSON.parse(localStorage.getItem("collie.folded") ?? "[]")); } catch { this.folded = new Set(); }
      this.refresh(cx);
      cx.timer.every(3000, (cx) => this.refresh(cx));
    } else if (this.view === "head") {
      // The header keeps the live terminal and the shown ticket's Receipts current.
      this.receiptsBusy = false;
      this.receiptsKey = null;
      this.receiptsAt = 0;
      this.agentTerms = [];
      this.agentTermsBusy = false;
      this.pollReceipts(cx);
      this.syncAgents(cx);
      cx.timer.every(3000, (cx) => { this.pollReceipts(cx); this.syncAgents(cx); cx.notify(); });
    } else if (this.view === "receipts-panel") {
      this.panel = { list: [], loading: true, error: null };
      this.panelBusy = false;
      this.loadReceiptPanel(cx);
      cx.timer.every(15000, (cx) => this.loadReceiptPanel(cx));
    }
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const parsed = parseQueue(await readTextFile(queuePath(home())));
        const groups = await loadTasks();
        const decisions = [...parsed, ...orphanTickets(parsed, groups)];
        const links = await navigation(decisions, groups);
        this.decisions = decisions;
        this.targets = new Map([...links].map(([id, value]) => [id, value.target]));
        this.receipts = new Map([...links].map(([id, value]) => [id, value.receipt]));
        this.staged = this.decisions.map((decision) => ({
          decision, stage: stageOf(decision, this.targets.get(decision.id)), target: this.targets.get(decision.id),
        }));
        this.rows = this.rowsFor();
        this.groups = ticketGroup(this.staged);
        this.error = null;
        setShared("inbox.queue", { waiting: waitingQueue(this.decisions).length, working: workingCount(this.decisions), at: Date.now() });
        // The open ticket follows its Decision and Task as they change.
        const open = ticket();
        if (open?.decision?.id) {
          const decision = this.decisions.find((d) => d.id === open.decision.id);
          if (decision) {
            const target = this.targets.get(decision.id);
            setShared("collie.ticket", { decision, target, receipt: this.receipts.get(decision.id), at: open.at ?? Date.now() });
            setShared("tasks.thread", threadOf(target, decision));
          }
        }
      } catch (e) {
        this.rows = [];
        this.staged = [];
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  loadReceiptPanel(cx) {
    if (this.panelBusy) return;
    this.panelBusy = true;
    cx.spawn(async (cx) => {
      try {
        const parsed = parseQueue(await readTextFile(queuePath(home())));
        const groups = await loadTasks();
        const links = await navigation(parsed, groups);
        this.decisions = parsed;
        this.targets = new Map([...links].map(([id, value]) => [id, value.target]));
        this.receipts = new Map([...links].map(([id, value]) => [id, value.receipt]));
        const result = await exec(RECEIPTS_CLI(), ["list", "--json"]);
        const out = result.code === 0 ? JSON.parse(result.stdout || "{}") : {};
        this.panel = { list: sortReceipts(out.receipts), loading: false, error: null };
      } catch (error) {
        this.panel = { list: [], loading: false, error: String(error?.message ?? error) };
      } finally {
        this.panelBusy = false;
        cx.notify();
      }
    });
  }

  receiptPanelRow(t, receipt, index) {
    return h().id(`panel-receipt-${receipt.id}`).w_full().min_w(0).px(10).py(9).gap(10).items_start().rounded(RADIUS.control).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((e, cx) => {
        cx.stop_propagation();
        const decision = this.decisions.find((d) => d.id === receipt.decision_ref);
        if (decision) openTicket(decision, this.targets.get(decision.id), receipt, cx, true);
      })
      .child(v().flex_1().min_w(0).gap(3)
        .child(div().min_w(0).truncate().text_size(13).font_medium().child(receiptTitle(receipt)))
        .child(div().min_w(0).truncate().text_size(TEXT.label).text_color(t.muted).child(receipt.task?.id ?? receipt.decision_ref))
        .child(h().gap(8).items_center().text_size(TEXT.label)
          .child(div().text_color(t.dim).child(this.receiptTime(receipt)))
          .when(Boolean(receiptProofRefs(receipt).length), (el) => el.child(div().text_color(t.accent).child("Proof")))))
      .child(div().flex_none().font_family(ID_FONT).text_size(TEXT.label).text_color(t.dim).child(`#${index + 1}`));
  }

  receiptsPanelView(t) {
    const p = this.panel ?? { list: [], loading: true, error: null };
    return v().id("receipts-panel").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(v().flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .children((p.list ?? []).map((r, i) => this.receiptPanelRow(t, r, i)))
        .when(p.loading, (el) => el.child(div().p(18).text_center().text_color(t.dim).child("Looking for receipts…")))
        .when(p.error, (el) => el.child(div().p(18).text_color(t.ansi1).child(p.error)))
        .when(!p.loading && !p.error && !(p.list ?? []).length, (el) => el.child(v().items_center().justify_center().p(24).gap(6)
          .child(div().text_size(TEXT.title).text_color(t.muted).child("No receipts yet"))
          .child(div().text_size(TEXT.label).text_color(t.dim).child("Task delivery records appear here after ready.")))));
  }

  // The shown ticket's durable Receipts; no terminal logs or helper output are inferred.
  pollReceipts(cx) {
    if (this.view !== "head") return;
    const current = ticket();
    const target = current?.target;
    const ref = target?.ref ?? current?.decision?.run?.task_ref;
    if (!ref) return;
    const key = receiptsKeyOf({ ...target, ref });
    if (this.receiptsBusy || (this.receiptsKey === key && Date.now() - this.receiptsAt < RECEIPTS_EVERY)) return;
    this.receiptsBusy = true;
    cx.spawn(async (cx) => {
      try {
        const result = await exec(RECEIPTS_CLI(), ["list", "--task", ref, "--json"]);
        const out = result.code === 0 ? JSON.parse(result.stdout || "{}") : {};
        const list = taskReceipts(out.receipts, { ref });
        const value = { ref, machine: target?.machine ?? null, list };
        const active = ticket();
        const activeRef = active?.target?.ref ?? active?.decision?.run?.task_ref;
        if (activeRef === ref && JSON.stringify(value) !== JSON.stringify(shared("tasks.thread.receipts") ?? null)) {
          setShared("tasks.thread.receipts", value);
        }
      } finally {
        this.receiptsKey = key;
        this.receiptsAt = Date.now();
        this.receiptsBusy = false;
        cx.notify();
      }
    });
  }

  receiptsLabel() {
    const a = shared("tasks.thread.receipts"), w = shared("tasks.thread");
    const n = a && w && a.ref === w.task ? a.list.length : 0;
    return n ? `Receipts ${n}` : "Receipts";
  }

  rowsFor() {
    return this.staged.filter((x) => this.filter === "all" || x.stage === this.filter).map((x) => x.decision);
  }

  setFilter(filter, cx) {
    this.filter = filter;
    setShared("inbox.filter", filter);
    this.rows = this.rowsFor();
    cx.notify();
  }

  menuItem(id, label, onClick, t) {
    return h().id(id).h(28).px(8).flex_none().items_center().rounded(5).cursor_pointer()
      .text_size(TEXT.label).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_click((e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
      .child(label);
  }

  actionMenuView(t) {
    const { decision, target, receipt } = actionTicket();
    const stage = stageOf(decision, target);
    const budgetTodo = stage === "todo" && String(decision.why ?? "").startsWith("全局预算 ");
    const items = stage === "todo" ? [
      ...((budgetTodo || target?.ref) ? [["run", "Run now", (cx) => this.runDecision(cx)]] : []),
      ["archive", "Archive", (cx) => this.answerReady("archive", cx)],
      ["quote", "Quote", () => replyToCoordinator(decision, target, receipt)],
    ] : stage === "needs" && ticketNeed(decision, target) === "ready" ? [
      ["accept", "Accept", () => this.openAccept(decision, target, receipt)],
      ["archive", "Archive", (cx) => this.answerReady("archive", cx)],
      ["quote", "Quote", () => replyToCoordinator(decision, target, receipt)],
    ] : [["quote", "Quote", () => replyToCoordinator(decision, target, receipt)]];
    return v().id("inbox-action-menu").size_full().p(4).bg(t.popover).text_color(t.foreground)
      .children(items.map(([id, label, onClick]) => this.menuItem(`inbox-${id}-${decision.id}`, label, onClick, t)));
  }

  openActionMenu(decision, target, receipt) {
    setShared("collie.action", { decision, target, receipt });
    const budgetTodo = stageOf(decision, target) === "todo" && String(decision.why ?? "").startsWith("全局预算 ");
    const count = stageOf(decision, target) === "todo" ? (budgetTodo || target?.ref ? 3 : 2)
      : stageOf(decision, target) === "needs" && ticketNeed(decision, target) === "ready" ? 3 : 1;
    const id = openOverlay({ mod: "collie-inbox", kind: "popup", frame: "none", width: 150, height: count * 32 + 8, at: "pointer", props: { view: "action-menu", decisionId: decision.id } });
    setShared("collie.actionOverlay", id);
  }

  rowMenu(decision, target, receipt, t) {
    return h().id(`inbox-actions-${decision.id}`).size(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((e, cx) => { cx.stop_propagation(); this.openActionMenu(decision, target, receipt); cx.notify(); })
      .child(svg("mods/collie-chrome/more.svg").size(15));
  }

  row(decision, t) {
    const target = this.targets.get(decision.id);
    const receipt = this.receipts.get(decision.id);
    const title = decision.card?.question ?? target?.title ?? decision.why;
    const stage = stageOf(decision, target);
    const need = stage === "needs" ? ticketNeed(decision, target) : null;
    const kind = stage === "working" ? kindOf(decision, target) : null;
    const pct = stage === "working" ? pctOf(target) : null;
    const left = stage === "working" ? shortLeft(minutesLeft(target?.progress)) : null;
    const said = stage === "working" ? (target?.progress?.text ?? ownProgress([target?.terminal])?.msg ?? null) : null;
    const reason = stage === "needs" ? decision.why
      : stage === "todo" ? todoReason(target, decision)
      : stage === "settled" ? decision.why
      : said ?? decision.why;
    return h().id(`inbox-${decision.id}`).relative().flex_none().px(8).py(8).gap(12).items_center().rounded(8)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((e, cx) => { cx.stop_propagation(); openTicket(decision, target, receipt, cx); })
      .child(v().w(14).flex_none().self_start().gap(2)
        .child(h().w(14).h(20).items_center().justify_center()
          .child(taskDot(stage === "needs" ? need : stage, { pct, halo: stage === "needs" && need === "needs" })))
        .when(Boolean(left), (el) => el.child(h().w(14).h(16).items_center().justify_center().whitespace_nowrap()
          .font_family(ID_FONT).text_size(11).font_semibold().text_color(t.ansi3).child(left))))
      .child(v().flex_1().min_w(0).gap(2)
        .child(h().h(20).min_w(0).items_center()
          .child(div().flex_1().min_w(0).truncate().text_color(stage === "settled" ? t.muted : t.foreground).child(title)))
        .child(h().h(18).min_w(0).gap(6).items_center().text_size(12)
          .child(div().flex_none().font_family(ID_FONT).text_size(11).text_color(t.dim).child(ticketRef(decision, target)))
          .child(stateChip(t, stage, need, kind, decision.settled?.outcome))
          .when(Boolean(target?.playbook), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(target.playbook)))
          .when(Boolean(reason), (el) => el.child(div().id(`inbox-reason-${decision.id}`).h(18).flex_shrink_1().min_w(0).overflow_hidden()
            .text_color(t.muted).child(selectableText(`inbox-reason-text-${decision.id}`, reason))))
          .child(div().flex_shrink(1000).min_w(0).truncate().text_color(t.dim).child(`· ${decision.space}`))))
      .child(this.rowMenu(decision, target, receipt, t));
  }

  saveUi() {
    try {
      localStorage.setItem("collie.settledOpen.v2", this.settledOpen ? "1" : "0");
      localStorage.setItem("collie.folded", JSON.stringify([...this.folded]));
    } catch {}
  }

  // A group heading (the Inbox's group()): the fold chevron in the rows' icon
  // column, the label and its count right by it.
  groupHead(t, { id, label, count, top = false, shut = false, onFold = null }) {
    return h().id(id).h(28).flex_none().px(8).gap(12).items_center().rounded(RADIUS.card).text_size(TEXT.label)
      .when(Boolean(onFold), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((e, cx) => { cx.stop_propagation(); onFold(cx); cx.notify(); }))
      .child(h().w(14).h(14).flex_none().items_center().justify_center()
        .child(svg(`mods/collie-chrome/chevron-${shut ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim)))
      .child(h().flex_1().min_w(0).gap(6).items_center()
        .child(div().min_w(0).truncate().when(top, (el) => el.text_size(TEXT.body).font_semibold().text_color(t.foreground))
          .when(!top, (el) => el.font_medium().text_color(t.muted)).child(label))
        .when(count > 0, (el) => el.child(div().flex_none().text_color(t.dim).child(String(count)))));
  }

  // All: four state groups; Settled has its own persisted, default-closed state.
  listBody(t) {
    if (this.filter !== "all") return this.rows.map((decision) => this.row(decision, t));
    const body = [];
    for (const stage of ["needs", "todo", "working"]) {
      const rows = this.groups[stage] ?? [];
      const shut = this.folded.has(stage);
      body.push(this.groupHead(t, { id: `collie-group-${stage}`, label: STAGE_WORD[stage], count: rows.length, top: stage === "needs", shut,
        onFold: () => {
          const folded = new Set(this.folded);
          if (shut) folded.delete(stage); else folded.add(stage);
          this.folded = folded;
          this.saveUi();
        } }));
      if (!shut) body.push(...rows.map((x) => this.row(x.decision, t)));
    }
    const settled = this.groups.settled ?? [];
    body.push(this.groupHead(t, { id: "collie-group-settled", label: STAGE_WORD.settled, count: settled.length, shut: !this.settledOpen,
      onFold: () => { this.settledOpen = !this.settledOpen; this.saveUi(); } }));
    if (this.settledOpen) body.push(...settled.map((x) => this.row(x.decision, t)));
    return body;
  }

  queue(t) {
    const tabs = [["all", "All"], ["needs", "Needs you"], ["todo", "Todo"], ["working", "Working"], ["settled", "Settled"]];
    const body = this.listBody(t);
    return v().id("collie").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_click((_e, cx) => { cx.notify(); })
      .child(h().h(46).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .children(tabs.map(([id, label]) => filterAction(`inbox-${id}`, label, this.filter === id, (cx) => this.setFilter(id, cx), t))))
      .child(v().flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
        .children(body)
        .when(!body.length, (el) => el.child(div().p(18).text_center().text_size(12)
          .text_color(this.error ? t.ansi1 : t.dim)
          .child(this.error ?? (this.loading ? "Reading decisions…" : this.filter === "needs" ? "Nothing needs you." : "Nothing here.")))))
      .when(this.error, (el) => el.child(div().px(12).py(6).text_color(t.ansi1).child(this.error)));
  }

  barRow(t, target) {
    return h().id("collie-thread-bar").h(24).flex_none().pl(EDGE - 6).pr(EDGE).gap(4).items_center()
      .child(h().id("collie-thread-back").h(24).pl(2).pr(8).gap(2).flex_none().items_center().rounded(RADIUS.control).cursor_pointer()
        .text_size(TEXT.label).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((e, cx) => { cx.stop_propagation(); backToInbox(); cx.notify(); })
        .child(svg("mods/collie-chrome/chevron-left.svg").size(14).flex_none())
        .child("Inbox"))
      .child(div().flex_1())
      .when(Boolean(target?.base_set && target?.base), (el) => el.child(div().id("collie-thread-base").flex_none().max_w(160).truncate().pr(4)
        .text_size(TEXT.label).text_color(t.muted).child(`→ ${target.base}`)));
  }

  // What the worker says it is doing (collie-task status), with the minutes it said are left, as
  // shepherdr's task header: the words give way first, so the time never gets cut off. A waiting
  // ticket has no running report, so the Decision's reason stands in the same line.
  reportLine(t, stage, target, decision) {
    const p = target?.progress;
    const own = ownProgress([target?.terminal]);
    const paused = stage !== "working";
    let text = p?.text ?? (stage === "working" ? own?.msg : null);
    if (!text) {
      text = stage === "needs" ? decision.why
        : stage === "todo" ? todoReason(target, decision)
        : stage === "settled" ? decision.why
        : null;
    }
    if (!text) return null;
    const pct = paused ? pctOf(target) : null;
    const left = paused ? null : shortLeft(minutesLeft(p));
    const end = paused ? (pct != null ? `${pct}%` : null) : (left ? `~${left}` : null);
    return h().id("collie-thread-report").w_full().min_w(0).gap(4).items_center().text_size(TEXT.label)
      .text_color(paused ? t.dim : t.muted)
      .child(div().min_w(0).truncate().child(text))
      .when(Boolean(end), (el) => el.child(div().flex_none().text_color(t.dim).child(`· ${end}`)));
  }

  // The ticket as shepherdr draws a task: its dot (the list's) beside the id and title; under them
  // what its worker is doing. No extra chips or metadata: the dot already says the stage.
  taskBlock(t, { decision, target, receipt }) {
    const title = receipt?.summary ?? decision.card?.question ?? target?.title ?? decision.why;
    const stage = stageOf(decision, target);
    const need = stage === "needs" ? ticketNeed(decision, target) : null;
    const pct = pctOf(target);
    const report = this.reportLine(t, stage, target, decision);
    return h().id("collie-thread-task").flex_none().px(EDGE).gap(8).items_start().text_color(t.foreground)
      .child(h().w(16).h(22).flex_none().items_center().justify_center()
        .child(taskDot(stage === "needs" ? need : stage, { pct, halo: stage === "needs" && need === "needs" })))
      .child(v().flex_1().min_w(0).gap(2)
        .child(h().h(22).min_w(0).gap(8).items_center()
          .child(div().flex_none().font_family(ID_FONT).text_size(TEXT.label).text_color(t.dim).child(ticketRef(decision, target)))
          .child(div().id("collie-thread-title").flex_1().min_w(0).truncate().text_size(TEXT.title).font_medium().cursor_pointer()
            .on_click((e, cx) => { cx.stop_propagation(); copyTaskTitle(title, cx); cx.notify(); }).child(title)))
        .child(h().h(16).min_w(0).items_center()
          .child(div().flex_1().min_w(0).when(Boolean(report), (el) => el.child(report)))));
  }

  // Discover task-local roles for the detail tabs; never create or focus a global Herdr tab.
  syncAgents(cx) {
    const target = ticket()?.target;
    if (!target?.ref || this.agentTermsBusy) return;
    this.agentTermsBusy = true;
    cx.spawn(async (cx) => {
      try {
        const label = target.key ? `${target.key.slug}#${target.key.id}` : null;
        if (!label) {
          this.agentTerms = terminals();
          this.agentTermsBusy = false;
          return;
        }
        const result = await exec("hc", ["ls", "--all", "--label", `herdr.task=${label}`, "--json"]);
        const out = JSON.parse(result.stdout || "{}");
        const listed = Array.isArray(out.terminals) ? out.terminals : [];
        this.agentTerms = await Promise.all(listed.map(async (term) => {
          const detail = await exec("hc", ["get", term.address, "--json"]);
          const full = JSON.parse(detail.stdout || "{}");
          return { ...term, status: term.status ?? full.status ?? null, labels: full.labels ?? null };
        }));
      } catch { this.agentTerms = terminals(); }
      this.agentTermsBusy = false;
      cx.notify();
    });
  }

  receiptTime(receipt) {
    const at = Date.parse(receipt?.received_at ?? receipt?.task?.ready_at ?? "");
    return Number.isFinite(at) ? new Date(at).toLocaleString() : "";
  }

  openProof(receipt) {
    const proof = receipt?.proof;
    if (!proof?.id) return;
    openViewer({ id: proof.id, title: proof.title ?? proof.id, machine: ticket()?.target?.machine ?? null });
  }

  receiptRow(t, receipt, index) {
    const refs = receiptProofRefs(receipt);
    return h().id(`ticket-receipt-${receipt.id}`).w_full().min_w(0).px(12).py(10).gap(10).items_start()
      .rounded(RADIUS.control).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((e, cx) => { cx.stop_propagation(); setShared("tasks.thread.receipt", receipt); cx.notify(); })
      .child(v().flex_1().min_w(0).gap(4)
        .child(div().min_w(0).text_size(14).font_medium().text_color(t.foreground).child(receiptTitle(receipt)))
        .when(Boolean(receipt.details), (el) => el.child(div().min_w(0).text_size(TEXT.label).text_color(t.muted).child(receipt.details)))
        .child(h().min_w(0).gap(8).items_center().text_size(TEXT.label)
          .child(div().flex_none().text_color(t.dim).child(this.receiptTime(receipt)))
          .when(Boolean(refs.length), (el) => el.child(div().flex_none().text_color(t.accent).child("Proof")))))
      .child(div().flex_none().font_family(ID_FONT).text_size(TEXT.label).text_color(t.dim).child(`#${index + 1}`));
  }

  runDecision(cx) {
    if (this.actionBusy) return;
    const { decision, target } = actionTicket();
    if (!decision?.id) return;
    this.actionBusy = true;
    cx.spawn(async (cx) => {
      try {
        const result = decision.synthetic && target?.ref && target.folder
          ? await exec(CLI(), ["start", target.ref, "--folder", target.folder, "--space", decision.space, "--json"])
          : await exec(COLLIE_CLI(), ["decision", "run", "--decision", decision.id]);
        if (result.code !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || "Decision run failed");
        backToInbox();
        toast({ title: "Running now", body: "The current Task was started.", level: "success" });
      } catch (error) {
        toast({ title: "Run now failed", body: plainError(error), level: "error" });
      } finally {
        this.actionBusy = false;
        closeActionOverlay();
        cx.notify();
      }
    });
  }

  answerReady(option, cx) {
    if (this.actionBusy) return;
    const current = actionTicket();
    const decision = current?.decision, target = current?.target;
    this.actionBusy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        let result;
        if (decision?.id && decision.state === "waiting") {
          result = await exec(ANSWER_CLI(), ["--decision", decision.id, "--option", option]);
        } else if (option === "archive" && decision?.id && decision.state === "open" && !decision.synthetic) {
          result = await exec(COLLIE_CLI(), ["decision", "archive", "--decision", decision.id]);
        } else if (target?.ref && target.folder) {
          result = await exec(CLI(), [option === "accept" ? "accept" : "done", target.ref, "--folder", target.folder, "--json", "--done-by", "human"]);
        } else {
          throw new Error("This ready Ticket has no Decision or Task target.");
        }
        if (result.code !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || `Task ${option} failed`);
        backToInbox();
        toast({ title: option === "accept" ? "Accepted" : "Archived", body: "Receipt and proof remain available.", level: "success" });
      } catch (error) {
        toast({ title: option === "accept" ? "Accept failed" : "Archive failed", body: plainError(error), level: "error" });
      } finally {
        this.actionBusy = false;
        cx.notify();
        if (this.view === "action-menu") closeActionOverlay();
        if (this.view === "accept-confirm") closeAcceptOverlay();
      }
    });
  }

  openAccept(decision, target, receipt) {
    setShared("collie.action", { decision, target, receipt });
    closeActionOverlay();
    const id = openOverlay({ mod: "collie-inbox", kind: "dialog", frame: "none", width: 680, height: 520, props: { view: "accept-confirm", decisionId: decision.id } });
    setShared("collie.acceptOverlay", id);
  }

  acceptConfirmView(t, cx) {
    const { decision, target, receipt } = actionTicket();
    const refs = receiptProofRefs(receipt);
    return v().id("accept-confirm").size_full().bg(t.popover).p(20).gap(14).text_color(t.foreground)
      .child(v().flex_none().gap(4)
        .child(div().text_size(TEXT.title).font_semibold().child("Review the latest Receipt"))
        .child(div().text_size(TEXT.label).text_color(t.dim).child(decision?.id ?? "")))
      .child(v().flex_1().min_h(0).overflow_y_scrollbar().gap(12)
        .child(v().flex_none().gap(5)
          .child(div().text_size(TEXT.label).font_semibold().text_color(t.muted).child("Summary"))
          .child(div().text_size(14).child(receipt?.summary ?? target?.summary ?? "No summary")))
        .child(v().flex_none().gap(5)
          .child(div().text_size(TEXT.label).font_semibold().text_color(t.muted).child("Details"))
          .child(div().text_size(13).child(receipt?.details ?? target?.details ?? "No details")))
        .child(v().flex_none().gap(6)
          .child(h().items_center().gap(8)
            .child(div().text_size(TEXT.label).font_semibold().text_color(t.muted).child("Proof"))
            .when(Boolean(receipt?.proof?.id), (el) => el.child(action("accept-open-proof", "Open proof", true, () => this.openProof(receipt), t))))
          .when(Boolean(receipt?.proof?.title), (el) => el.child(div().text_size(13).child(receipt.proof.title)))
          .children(refs.map((ref, index) => div().id(`accept-proof-ref-${index}`).text_size(TEXT.label).text_color(t.muted).child(ref)))
          .when(!refs.length, (el) => el.child(div().text_size(TEXT.label).text_color(t.dim).child("No proof refs.")))))
      .child(h().flex_none().gap(8).justify_end()
        .child(action("accept-confirm-cancel", "Cancel", !this.actionBusy, () => closeAcceptOverlay(), t))
        .child(action("accept-confirm-yes", "Accept", !this.actionBusy, (cx) => this.answerReady("accept", cx), t)));
  }

  receiptDetail(t, receipt) {
    const refs = receiptProofRefs(receipt);
    const target = ticket()?.target;
    return v().id("ticket-receipt-detail").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(h().h(42).flex_none().px(12).items_center().border_b(1).border_color(t.border)
        .child(action("ticket-receipt-back", "← Detail", true, (cx) => { setShared("tasks.thread.receipt", null); cx.notify(); }, t)))
      .child(v().flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(16)
        .child(v().flex_none().gap(6)
          .child(div().text_size(18).font_semibold().child(selectableText("ticket-receipt-title", receiptTitle(receipt))))
          .child(div().text_size(TEXT.label).text_color(t.dim).child(this.receiptTime(receipt))))
        .child(v().flex_none().gap(6)
          .child(div().text_size(TEXT.label).font_semibold().text_color(t.muted).child("Details"))
          .child(div().text_size(13).child(selectableText("ticket-receipt-details", receipt.details ?? ""))))
        .child(v().flex_none().gap(8)
          .child(h().items_center().gap(8)
            .child(div().text_size(TEXT.label).font_semibold().text_color(t.muted).child("Proof"))
            .when(Boolean(receipt.proof?.id), (el) => el.child(action("ticket-open-proof", "Open proof", true, () => this.openProof(receipt), t))))
          .when(Boolean(receipt.proof?.title), (el) => el.child(div().text_size(13).child(receipt.proof.title)))
          .children(refs.map((ref, index) => {
            const artifact = ref.startsWith("artifact:") ? ref.slice("artifact:".length) : null;
            return h().id(`ticket-proof-ref-${index}`).min_w(0).px(9).py(6).rounded(6).bg(t.chrome)
              .text_size(TEXT.label).text_color(artifact ? t.accent : t.muted)
              .when(Boolean(artifact), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
                .on_click((e, cx) => { cx.stop_propagation(); openViewer({ id: artifact, title: receipt.proof?.title ?? artifact, machine: target?.machine ?? null }); }))
              .child(div().min_w(0).truncate().child(ref));
          })))
        .when(!refs.length && !receipt.proof?.id, (el) => el.child(div().text_size(TEXT.label).text_color(t.dim).child("No proof refs."))));
  }

  detailRow(t, id, label, value) {
    if (value === null || value === undefined || value === "") return null;
    return h().id(`ticket-detail-${id}`).w_full().min_w(0).gap(12).items_start()
      .child(div().w(88).flex_none().text_size(TEXT.label).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).text_size(13).text_color(t.foreground)
        .child(selectableText(`ticket-detail-text-${id}`, value)));
  }

  detailView(t) {
    const currentTicket = ticket();
    const decision = currentTicket?.decision ?? {};
    const target = currentTicket?.target ?? null;
    const stage = stageOf(decision, target);
    const rows = [
      ["task", "Task", ticketRef(decision, target)],
      ["status", "Status", STAGE_WORD[stage] ?? stage],
      ["description", "Description", target?.title ?? decision.why],
      ["waiting", "Waiting", stage === "todo" ? todoReason(target, decision) : null],
      ["dependencies", "Depends on", target?.depends_on?.length ? target.depends_on.join(", ") : null],
      ["project", "Project", decision.project ?? target?.project],
      ["space", "Space", decision.space],
      ["playbook", "Playbook", target?.playbook ?? decision.playbook?.id],
      ["branch", "Branch", target?.branch],
      ["base", "Base", target?.base],
      ["worktree", "Worktree", target?.worktree],
      ["decided", "Decided", decision.decided_at],
    ];
    return v().id("ticket-detail").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(v().flex_1().min_h(0).overflow_y_scrollbar().p(16)
        .child(v().flex_none().gap(10).children(rows.map((row) => this.detailRow(t, ...row)).filter(Boolean))));
  }

  receiptsView(t) {
    const current = shared("tasks.thread.receipts");
    const list = Array.isArray(current?.list) ? current.list : [];
    const selected = shared("tasks.thread.receipt");
    const receipt = selected ? (list.find((r) => r.id === selected.id) ?? selected) : null;
    if (receipt) return this.receiptDetail(t, receipt);
    return v().id("ticket-receipts").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(v().flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .children(list.map((r, i) => this.receiptRow(t, r, i)))
        .when(!list.length, (el) => el.child(v().flex_1().items_center().justify_center().p(24).gap(6)
          .child(div().text_size(TEXT.title).text_color(t.muted).child("No delivery yet"))
          .child(div().text_size(TEXT.label).text_color(t.dim).child("A Receipt appears when this Task is ready.")))));
  }

  head(t, cx) {
    const cur = ticket();
    const root = v().id("collie-thread-head").size_full().min_h(0).bg(t.background).text_color(t.foreground);
    const decision = cur?.decision ?? null;
    if (!decision) {
      return root.items_center().justify_center().px(18).text_size(TEXT.label).text_color(t.dim)
        .child("Pick a ticket from Inbox.");
    }
    const target = cur?.target ?? null, receipt = cur?.receipt ?? null;
    // A ticket just opened: load its Receipts now, even if its Task record is gone.
    const receiptRef = target?.ref ?? decision.run?.task_ref;
    if (receiptRef && this.receiptsKey !== receiptsKeyOf({ ...target, ref: receiptRef })) {
      cx.timer.after(0, (cx) => { this.pollReceipts(cx); cx.notify(); });
    }
    const live = isLive(target?.terminal);
    const helpers = taskAgents(target, this.agentTerms?.length ? this.agentTerms : terminals());
    const selected = shared("collie.ticket.agent") ?? null;
    const selectedAgent = selected ? helpers.find((agent) => agent.address === selected) : null;
    const active = find(layout(), BODY)?.active ?? DETAIL;
    const selectedEnded = selected && (!selectedAgent || (selectedAgent.state !== "finished" && !isLive(selected)));
    if (active === TERM && (selectedEnded || (!selected && !live))) cx.timer.after(0, () => showDetail());
    const shown = active === RECEIPTS ? "receipts" : active === DETAIL ? "detail" : selected ? `agent:${selected}` : "terminal";
    const segs = [
      ["detail", "Detail", {}],
      ["receipts", this.receiptsLabel(), {}],
      ["terminal", "Terminal", { disabled: !live }],
      ...helpers.map((agent) => [`agent:${agent.address}`, roleTabName(agent, helpers), {}]),
    ];
    return root.child(v().id("collie-thread-head-rows").size_full().pt(8).pb(12).gap(12).border_b(1).border_color(t.border)
      .child(v().flex_none().gap(8)
        .child(this.barRow(t, target))
        .child(this.taskBlock(t, { decision, target, receipt })))
      .child(h().id("collie-thread-views").flex_none().px(EDGE).overflow_x_scroll()
        .child(segmented("collie-thread-mode", segs, shown, (pick, _e, cx) => {
          if (pick === "detail") showDetail();
          else if (pick === "receipts") {
            setShared("collie.ticket.agent", null);
            selectPage(RECEIPTS);
          } else if (pick === "terminal") cx.spawn(async (cx) => { await showTerminal(cx); cx.notify(); });
          else {
            const agent = helpers.find((item) => `agent:${item.address}` === pick);
            if (agent) cx.spawn(async (cx) => { await showTerminal(cx, agent, roleTabName(agent, helpers)); cx.notify(); });
          }
        }))));
  }

  render(cx) {
    const t = theme();
    if (this.view === "head") return this.head(t, cx);
    if (this.view === "receipts-panel") return this.receiptsPanelView(t);
    if (this.view === "detail") return this.detailView(t);
    if (this.view === "receipts") return this.receiptsView(t, cx);
    if (this.view === "action-menu") return this.actionMenuView(t);
    if (this.view === "accept-confirm") return this.acceptConfirmView(t, cx);
    return this.queue(t);
  }
}
