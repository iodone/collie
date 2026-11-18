// One Inbox workbench: waiting decisions, working dispatches and settled history.
// All rows come from the Ledger projection; collie-task is read only for navigation and diffs.
// A ticket opens in its own page: collie's task view with only Terminal and Artifacts.
import { View, div, svg } from "gpui-kit";
import {
  appHome, exec, focused, home, layout, panes, props, readTextFile, run,
  setShared, shared, spaces, terminals, theme, writeTextFile,
} from "herdr";
import {
  parseQueue, queuePath, receiptPath, STAGE_WORD, taskTarget,
  ticketGroup, ticketNeed, ticketStage, todoReason, waitingQueue, workKind, workingCount,
} from "./lib/inbox-queue.js";
import { ownProgress, taskDot } from "./lib/ticket-dot.js";
import { artifactCli, openViewer } from "./lib/artview.js";
import { SLOT, chatPane } from "./core/spaces.js";
import { GREP, publishedIds, taskArtifacts } from "./core/task-artifacts.js";
import { RADIUS, TEXT, plainError, segmented, toast } from "./lib/ui.js";

const v = () => div().flex().flex_col();
const h = () => div().flex().flex_row();
const CLI = () => (globalThis.process?.env?.COLLIE_TASK_CLI) ?? `${appHome()}/bin/collie-task`;
const selected = () => shared("inbox.selected") ?? null;
const ticket = () => shared("collie.ticket") ?? null;

// The ticket page: collie's task view nodes (the same ids in layouts/collie.json).
const STACK = "collie", LIST = "collie-list", TICKET = "collie-ticket";
const HEAD = "collie-ticket-head", BODY = "collie-ticket-body";
const TERM = "collie-ticket-term", ARTIFACTS = "collie-ticket-artifacts";
const EDGE = 12;
const ID_FONT = "JetBrains Mono";
const ARTS_EVERY = 15000;

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) { const hit = find(child, id); if (hit) return hit; }
  return null;
}

const isLive = (address) => Boolean(address) && terminals().some((k) => k.address === address && k.state === "live");
const artsKeyOf = (target) => `${target?.machine ?? ""}|${target?.folder ?? ""}|${target?.ref ?? ""}`;

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

// Who is at work on the ticket: the task's live agents, by herdr.role. A build's reviewer is a
// helper agent (never in the task's agents), so its terminal's label is the authority.
function liveRoles(target) {
  const key = target?.key;
  const label = key ? `${key.slug}#${key.id}` : null;
  const record = Array.isArray(target?.live) ? target.live : [];
  const terms = label ? terminals().filter((k) => k.state === "live" && k.labels?.["herdr.task"] === label) : [];
  const has = (role) => record.some((a) => a.role === role && a.status !== "done")
    || terms.some((k) => k.labels?.["herdr.role"] === role && k.status !== "done");
  const blocked = record.some((a) => a.status === "blocked") || terms.some((k) => k.status === "blocked");
  return { worker: has("worker"), reviewer: has("reviewer"), blocked };
}

const stageOf = (decision, target) => ticketStage(decision, target, liveRoles(target));
const kindOf = (decision, target) => workKind(decision, target, liveRoles(target));

// What the artifacts view and the header read (shared "tasks.thread" / "tasks.thread.artifacts").
function threadOf(target, decision) {
  return {
    terminal: target?.terminal ?? null,
    task: target?.ref ?? decision?.id ?? null,
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

// The terminal block shows the agent: an edit of that one block in the layout's file, as
// collie does (a mod can't draw a terminal, and a layout block shows any core terminal
// without giving it a pane). Only if the file is unchanged since it was read; else read again.
async function pointTerm(address, cx) {
  const path = `${appHome()}/layouts/${shared("layout")}.json`;
  for (let i = 0; ; i++) {
    const text = await readTextFile(path);
    const tree = JSON.parse(text ?? "null"), body = find(tree, BODY);
    if (!body) throw new Error("This layout has no ticket terminal.");
    const node = { id: TERM, type: "block", content: { terminal: address } };
    const at = body.children.findIndex((child) => child.id === TERM);
    if (at < 0) body.children.push(node); else body.children[at] = node;
    try { await writeTextFile(path, JSON.stringify(tree, null, 2), text); break; }
    catch (e) { if (i >= 2) throw e; }
  }
  for (let i = 0; i < 30 && find(layout(), TERM)?.content?.terminal !== address; i++) {
    await new Promise((done) => cx.timer.after(100, () => done()));
  }
  if (find(layout(), TERM)?.content?.terminal !== address) throw new Error("Herdr didn't load the layout with this terminal.");
}

async function showTerminal(cx) {
  const address = ticket()?.target?.terminal ?? null;
  if (!address || !isLive(address)) return;
  try {
    if (find(layout(), TERM)?.content?.terminal !== address) await pointTerm(address, cx);
    selectPage(TERM);
    run("pane.focus", { terminal: address });
  } catch (e) {
    toast({ title: "Terminal didn't open", body: plainError(e), level: "error" });
  }
}

const showArtifacts = () => selectPage(ARTIFACTS);

// A click on a ticket: its page, on its live terminal when one runs, else its artifacts.
function openTicket(decision, target, receipt, cx) {
  if (!target?.ref && receipt?.proof?.id) {
    openViewer({ id: receipt.proof.id, title: receipt.proof.title, machine: target?.machine, modal: true });
    return;
  }
  setShared("collie.ticket", { decision, target, receipt, at: Date.now() });
  setShared("tasks.thread", threadOf(target, decision));
  if (!target?.ref) setShared("tasks.thread.artifacts", { terminal: null, ref: decision.id, machine: null, list: [] });
  const live = isLive(target?.terminal);
  const ready = live && find(layout(), TERM)?.content?.terminal === target.terminal;
  selectPage(ready ? TERM : ARTIFACTS);
  if (live && !ready) cx.spawn(async (cx) => { await showTerminal(cx); cx.notify(); });
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
        const shown = await exec(CLI(), ["show", target.ref, "--folder", target.folder, "--json", "--evidence"]);
        if (shown.code === 0) {
          const detail = JSON.parse(shown.stdout);
          target = taskTarget(decision, receipt, groups, detail);
          if (target) {
            target.state = detail.state;
            target.evidence = detail.evidence;
          }
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

function ticketRef(decision, target = null) {
  if (target?.ref) return String(target.ref).toUpperCase();
  const taskRef = decision.run?.task_ref;
  if (taskRef && /-\d+$/.test(taskRef)) return taskRef.toUpperCase();
  const numeric = Number(String(decision.id).replace(/\D/g, "")) || 0;
  return `COLLIE-${numeric}`;
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
  const gerund = kind === "build" ? "building" : kind === "review" ? "reviewing" : kind === "merge" ? "merging" : null;
  const suffix = stage === "working" ? gerund : stage === "settled" ? outcome : null;
  const label = suffix ? `${STAGE_WORD[stage] ?? stage} · ${suffix}` : STAGE_WORD[stage] ?? stage;
  return h().flex_none().h(16).px(5).items_center().rounded(4).bg(color + "1f")
    .text_size(11).font_medium().text_color(color).child(label);
}

// The person's one action in the Inbox: hand this ticket to the coordinator chat as context,
// focus it, and let the LLM explain the evidence and suggest options. The person decides there.
function coordinatorChat() {
  const here = focused();
  const chat = panes().find((p) => p.mod === "collie-chat" && p.tab === here?.tab) ?? panes().find((p) => p.mod === "collie-chat");
  if (!chat) return null;
  return chat;
}

// The agent a coordinator chat holds: the one parked behind its pane (herdr.chat), else the one its slot started
// (herdr.chat.slot; shared "coordinator.slots" says which pane a slot is). A chat pane is no terminal of its own,
// so the old reply, sent to the pane's terminal, was always dropped.
function coordinatorAgent(chat) {
  if (!chat) return null;
  const parked = terminals().find((k) => k.state === "live" && chatPane(k) === chat.pane);
  if (parked) return parked.address;
  const slot = Object.entries(shared("coordinator.slots") ?? {}).find(([, s]) => s?.pane === chat.pane)?.[0] ?? null;
  if (!slot) return null;
  return terminals().find((k) => k.state === "live" && k.labels?.[SLOT] === slot)?.address ?? null;
}

function replyContext(decision, target, receipt) {
  const lines = [
    `我想处理这张 Ticket：${ticketRef(decision)} · ${decision.card?.question ?? target?.title ?? decision.why}`,
    `Decision ${decision.id} · ${decision.why}`,
  ];
  if (decision.card?.question) lines.push(`问题：${decision.card.question}`);
  if (receipt?.summary) lines.push(`回执摘要：${receipt.summary}`);
  lines.push("请先只解读依据并给出建议，不要执行任何动作；等我在 chat 里确认。");
  return lines.join("\n");
}

async function replyToCoordinator(decision, target, receipt) {
  const chat = coordinatorChat();
  if (!chat) return;
  const addr = coordinatorAgent(chat);
  if (addr) {
    try { await exec("hc", ["send", addr, replyContext(decision, target, receipt)]); } catch {}
  }
  run("pane.focus", { pane: chat.pane });
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
    this.filter = saved === "waiting" || saved === "review" ? "needs" : kept.includes(saved) ? saved : "all";
    this.rows = [];
    this.staged = [];
    this.groups = { top: [], spaces: [], settled: [] };
    this.decisions = [];
    this.targets = new Map();
    this.receipts = new Map();
    this.error = null;
    this.loading = false;
    if (this.view === "queue") {
      try {
        this.settledOpen = localStorage.getItem("collie.settledOpen") === "1"
          || localStorage.getItem("collie.doneOpen") === "1";
      } catch { this.settledOpen = false; }
      try { this.folded = new Set(JSON.parse(localStorage.getItem("collie.folded") ?? "[]")); } catch { this.folded = new Set(); }
      this.refresh(cx);
      cx.timer.every(3000, (cx) => this.refresh(cx));
    } else if (this.view === "head") {
      // The header keeps the live terminal and the shown ticket's artifacts current.
      this.artsBusy = false;
      this.artsKey = null;
      this.artsAt = 0;
      this.pollArts(cx);
      cx.timer.every(3000, (cx) => { this.pollArts(cx); cx.notify(); });
    }
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        this.decisions = parseQueue(await readTextFile(queuePath(home())));
        const groups = await loadTasks();
        const links = await navigation(this.decisions, groups);
        this.targets = new Map([...links].map(([id, value]) => [id, value.target]));
        this.receipts = new Map([...links].map(([id, value]) => [id, value.receipt]));
        this.staged = this.decisions.map((decision) => ({
          decision, stage: stageOf(decision, this.targets.get(decision.id)),
        }));
        this.rows = this.rowsFor();
        this.groups = ticketGroup(this.staged, [...spaces().map((s) => s.id), ...spaces().map((s) => s.name)]);
        this.error = null;
        setShared("inbox.queue", { waiting: waitingQueue(this.decisions).length, working: workingCount(this.decisions), at: Date.now() });
        const current = selected();
        if (current?.decision) {
          const decision = this.decisions.find((d) => d.id === current.decision.id);
          if (decision) setShared("inbox.selected", {
            decision, target: this.targets.get(decision.id), receipt: this.receipts.get(decision.id),
          });
        }
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

  // The shown ticket's artifacts, as Collie finds them (mods/collie-inbox/main.js loadArts): its
  // folder's list (collie-artifact) and what its agents' logs say they published.
  pollArts(cx) {
    if (this.view !== "head") return;
    const target = ticket()?.target;
    if (!target?.ref || typeof target.folder !== "string" || !target.folder) return;
    const key = artsKeyOf(target);
    if (this.artsBusy || (this.artsKey === key && Date.now() - this.artsAt < ARTS_EVERY)) return;
    this.artsBusy = true;
    cx.spawn(async (cx) => {
      try {
        const on = target.machine ?? null;
        const out = await artifactCli(on, ["list", "--folder", target.folder]).catch(() => null);
        const arts = Array.isArray(out?.artifacts) ? out.artifacts : [];
        const logs = (Array.isArray(target.agents) ? target.agents : [])
          .map((agent) => agent?.log).filter((path) => typeof path === "string");
        const said = logs.length ? await exec("grep", ["-ohE", GREP, ...logs], on ? { on } : {}).catch(() => null) : null;
        const ids = taskArtifacts(arts, {
          ref: target.ref, folder: target.folder, machine: null, agents: target.agents, proof: target.proof ?? null,
        }, publishedIds(said?.stdout));
        const list = ids.map((id) => arts.find((art) => art.id === id)).filter(Boolean)
          .map((art) => ({ id: art.id, title: art.title, v: art.version, at: art.at, proof: art.id === target.proof }));
        const value = { terminal: target.terminal ?? null, ref: target.ref, machine: on, list };
        if (ticket()?.target?.ref === target.ref && JSON.stringify(value) !== JSON.stringify(shared("tasks.thread.artifacts") ?? null)) {
          setShared("tasks.thread.artifacts", value);
        }
      } finally {
        // Even a failed look waits its turn (a tight loop would ask collie-artifact again and again).
        this.artsKey = key;
        this.artsAt = Date.now();
        this.artsBusy = false;
        cx.notify();
      }
    });
  }

  // "Artifacts", with how many once the shown ticket has some ("Artifacts 3").
  artsLabel() {
    const a = shared("tasks.thread.artifacts"), w = shared("tasks.thread");
    const n = a && w && a.terminal === (w.terminal ?? null) && (w.terminal || a.ref === w.task) ? a.list.length : 0;
    return n ? `Artifacts ${n}` : "Artifacts";
  }

  back(_cx) {
    backToInbox();
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

  // bare: under a space's heading, which already says where it is.
  row(decision, t, bare = false) {
    const target = this.targets.get(decision.id);
    const receipt = this.receipts.get(decision.id);
    const title = decision.card?.question ?? target?.title ?? decision.why;
    const stage = stageOf(decision, target);
    const need = stage === "needs" ? ticketNeed(decision) : null;
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
        .child(h().h(16).min_w(0).gap(6).items_center().text_size(12)
          .child(div().flex_none().font_family(ID_FONT).text_size(11).text_color(t.dim).child(ticketRef(decision, target)))
          .child(stateChip(t, stage, need, kind, decision.settled?.outcome))
          .child(div().flex_shrink_1().min_w(0).truncate().text_color(t.muted).child(reason ?? ""))
          .when(!bare, (el) => el.child(div().flex_shrink(1000).min_w(0).truncate().text_color(t.dim).child(`· ${decision.space}`)))))
      .child(action(`collie-reply-${decision.id}`, "回复", true, () => replyToCoordinator(decision, target, receipt), t));
  }

  saveUi() {
    try {
      localStorage.setItem("collie.settledOpen", this.settledOpen ? "1" : "0");
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

  // A space's heading (the Inbox's SpaceHeading): its emoji (else #) where the rows' dots are, its
  // name, its count; a click opens the space.
  spaceHead(t, key, count) {
    const space = spaces().find((s) => s.id === key || s.name === key);
    const icon = space ? shared("collie.spaceIcons")?.[space.id] ?? null : null;
    return h().id(`collie-group-space-${key}`).h(28).flex_none().px(8).gap(12).items_center().rounded(RADIUS.card).text_size(TEXT.label)
      .when(Boolean(space), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((e, cx) => { cx.stop_propagation(); run("space.select", { id: space.id }); cx.notify(); }))
      .child(h().w(14).h(14).flex_none().items_center().justify_center()
        .child(div().text_size(icon ? 12 : TEXT.label).text_color(t.dim).child(icon ?? "#")))
      .child(h().flex_1().min_w(0).gap(6).items_center()
        .child(div().min_w(0).truncate().font_medium().text_color(t.muted).child(space?.name ?? (key || "No space")))
        .child(div().flex_none().text_color(t.dim).child(String(count))));
  }

  // Settled, shut: one quiet line, "Settled 12"; a click shows the terminal records.
  settledLine(t) {
    return h().id("collie-settled-line").flex_none().mt(6).h(28).px(8).gap(12).items_center().rounded(RADIUS.card).cursor_pointer()
      .text_size(TEXT.label).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.muted))
      .on_click((e, cx) => { cx.stop_propagation(); this.settledOpen = true; this.saveUi(); cx.notify(); })
      .child(h().w(14).h(14).flex_none().items_center().justify_center()
        .child(svg("mods/collie-chrome/chevron-right.svg").size(12).flex_none()))
      .child(`${STAGE_WORD.settled} ${this.groups.settled.length}`);
  }

  // All: Needs you on top, each space's Todo → Working under its name, Settled last.
  // A state chip is that state flat.
  listBody(t) {
    if (this.filter !== "all") return this.rows.map((decision) => this.row(decision, t));
    const body = [];
    const { top, spaces: places, settled } = this.groups;
    const shut = this.folded.has("needs");
    if (top.length) {
      body.push(this.groupHead(t, { id: "collie-group-needs", label: STAGE_WORD.needs, count: top.length, top: true, shut,
        onFold: (cx) => {
          const folded = new Set(this.folded);
          if (folded.has("needs")) folded.delete("needs"); else folded.add("needs");
          this.folded = folded;
          this.saveUi();
        } }));
      if (!shut) body.push(...top.map((x) => this.row(x.decision, t)));
    }
    for (const group of places) {
      body.push(this.spaceHead(t, group.key, group.rows.length));
      body.push(...group.rows.map((x) => this.row(x.decision, t, true)));
    }
    if (settled.length) {
      if (this.settledOpen) {
        body.push(this.groupHead(t, { id: "collie-group-settled", label: STAGE_WORD.settled, count: settled.length,
          onFold: () => { this.settledOpen = false; this.saveUi(); } }));
        body.push(...settled.map((x) => this.row(x.decision, t)));
      } else body.push(this.settledLine(t));
    }
    return body;
  }

  queue(t) {
    const tabs = [["all", "All"], ["needs", "Needs you"], ["todo", "Todo"], ["working", "Working"], ["settled", "Settled"]];
    const body = this.listBody(t);
    return v().id("collie").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
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

  // Its status dot beside the id (the list's monospace) and title; under them the Decision's why.
  taskBlock(t, { decision, target, receipt }) {
    const title = receipt?.summary ?? decision.card?.question ?? target?.title ?? decision.why;
    const stage = stageOf(decision, target);
    const need = stage === "needs" ? ticketNeed(decision) : null;
    const kind = stage === "working" ? kindOf(decision, target) : null;
    const pct = stage === "working" ? pctOf(target) : null;
    const own = ownProgress([target?.terminal]);
    const said = stage === "working" ? (target?.progress?.text ?? own?.msg ?? null) : null;
    const left = stage === "working" ? shortLeft(minutesLeft(target?.progress)) : null;
    const reason = stage === "needs" ? decision.why
      : stage === "todo" ? todoReason(target, decision)
      : stage === "settled" ? decision.why
      : said ?? decision.why;
    const report = [
      stage === "working" && pct != null ? `${pct}%` : null,
      reason,
      left ? `~${left}` : null,
    ].filter(Boolean).join(" · ");
    return h().id("collie-thread-task").flex_none().px(EDGE).gap(8).items_start().text_color(t.foreground)
      .child(h().w(16).h(22).flex_none().items_center().justify_center()
        .child(taskDot(stage === "needs" ? need : stage, { pct, halo: stage === "needs" && need === "needs" })))
      .child(v().flex_1().min_w(0).gap(2)
        .child(h().h(22).min_w(0).gap(8).items_center()
          .child(div().flex_none().font_family(ID_FONT).text_size(TEXT.label).text_color(t.dim).child(ticketRef(decision)))
          .child(div().id("collie-thread-title").flex_1().min_w(0).truncate().text_size(TEXT.title).font_medium().child(title)))
        .child(h().h(16).min_w(0).gap(6).items_center()
          .child(stateChip(t, stage, need, kind, decision.settled?.outcome))
          .child(div().flex_1().min_w(0).truncate().text_size(TEXT.label).text_color(t.muted).child(report))));
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
    // A ticket just opened: look for its artifacts now, not at the next tick.
    if (target?.ref && this.artsKey !== artsKeyOf(target)) cx.timer.after(0, (cx) => { this.pollArts(cx); cx.notify(); });
    const live = isLive(target?.terminal);
    const active = find(layout(), BODY)?.active ?? ARTIFACTS;
    // The worker ended while its terminal was up: back to its artifacts.
    if (active === TERM && !live) cx.timer.after(0, () => showArtifacts());
    const shown = active === TERM && live ? "terminal" : "artifacts";
    const segs = [
      ["terminal", "Terminal", { disabled: !live }],
      ["artifacts", this.artsLabel(), {}],
    ];
    return root.child(v().id("collie-thread-head-rows").size_full().pt(8).pb(12).gap(12).border_b(1).border_color(t.border)
      .child(v().flex_none().gap(8)
        .child(this.barRow(t, target))
        .child(this.taskBlock(t, { decision, target, receipt })))
      .child(h().id("collie-thread-views").flex_none().px(EDGE).overflow_x_scroll()
        .child(segmented("collie-thread-mode", segs, shown, (pick, _e, cx) => {
          if (pick === "terminal") cx.spawn(async (cx) => { await showTerminal(cx); cx.notify(); });
          else showArtifacts();
        }))));
  }

  render(cx) {
    const t = theme();
    if (this.view === "head") return this.head(t, cx);
    return this.queue(t);
  }
}
