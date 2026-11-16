// One Inbox workbench: waiting decisions, working dispatches and settled history.
// All rows come from the Ledger projection; herdr-task is read only for navigation and diffs.
import { View, div } from "gpui-kit";
import { InputState, Input } from "gpui-base";
import {
  appHome, closeOverlay, exec, home, openOverlay, props, readTextFile, run,
  setShared, shared, theme,
} from "herdr";
import {
  diffTarget, parseQueue, queuePath, receiptPath, settledDecisions, taskTarget,
  waitingQueue, workingCount, workingDecisions,
} from "./lib/inbox-queue.js";

const v = () => div().flex().flex_col();
const h = () => div().flex().flex_row();
const CLI = () => `${appHome()}/mods/tasks/bin/herdr-task`;
const ANSWER = () => `${appHome()}/bin/collie-answer`;
const REQUEST = () => `${appHome()}/bin/collie-request`;
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const selected = () => shared("inbox.selected") ?? null;

function openDiff(target) {
  if (!diffTarget(target)) return;
  openOverlay({ mod: "collie", kind: "dialog", modal: true, width: 900, height: 700, props: { view: "diff", target } });
}

function openDetails(decision, target, receipt) {
  setShared("inbox.selected", { decision, target, receipt });
  run("layout.select", { stack: "panel-body", child: "collie-detail" });
  run("layout.show", { id: "panel" });
}

async function navigation(decisions) {
  const linked = decisions.filter((d) => d.receipt_ref || d.run?.task_ref);
  if (!linked.length) return new Map();
  const receipts = await Promise.all(linked.map(async (decision) => {
    const path = receiptPath(home(), decision.receipt_ref);
    if (path) {
      try { return JSON.parse(await readTextFile(path) ?? "null"); } catch { return null; }
    }
    return { decision_ref: decision.id, task: { id: decision.run.task_ref } };
  }));
  let groups = [];
  try {
    const result = await exec(CLI(), ["list", "--all", "--json"]);
    if (result.code === 0) groups = JSON.parse(result.stdout || "[]");
  } catch { groups = []; }
  const entries = await Promise.all(linked.map(async (decision, i) => {
    const receipt = receipts[i];
    let target = taskTarget(decision, receipt, groups);
    if (target && (!target.start || !target.worktree)) {
      try {
        const shown = await exec(CLI(), ["show", target.ref, "--folder", target.folder, "--json", "--evidence"]);
        if (shown.code === 0) target = taskTarget(decision, receipt, groups, JSON.parse(shown.stdout));
      } catch { /* keep the list-only target */ }
    }
    return [decision.id, { target, receipt }];
  }));
  return new Map(entries);
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
    this.filter = shared("inbox.filter") ?? "waiting";
    this.rows = [];
    this.decisions = [];
    this.targets = new Map();
    this.receipts = new Map();
    this.error = null;
    this.loading = false;
    if (["queue", "detail"].includes(this.view)) {
      this.note = InputState.new({ placeholder: "Rework: what must change, and why?" });
      this.goal = InputState.new({ placeholder: "What should coordinator build or investigate?" });
      this.building = false;
      this.refresh(cx);
      cx.timer.every(3000, (cx) => this.refresh(cx));
    } else if (this.view === "diff") {
      this.target = _props?.target ?? props()?.target;
      this.diff = null;
      this.handle = cx.focus_handle();
      this.handle.focus();
      this.loadDiff(cx);
    }
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        this.decisions = parseQueue(await readTextFile(queuePath(home())));
        const links = await navigation(this.decisions);
        this.targets = new Map([...links].map(([id, value]) => [id, value.target]));
        this.receipts = new Map([...links].map(([id, value]) => [id, value.receipt]));
        const rows = this.filter === "working" ? workingDecisions(this.decisions)
          : this.filter === "settled" ? settledDecisions(this.decisions)
          : waitingQueue(this.decisions);
        this.rows = rows;
        this.error = null;
        setShared("inbox.queue", { waiting: waitingQueue(this.decisions).length, working: workingCount(this.decisions), at: Date.now() });
      } catch (e) {
        this.rows = [];
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  async newBuild(cx) {
    const goal = this.goal.content().text.trim();
    if (!goal || this.building) return;
    this.building = true;
    this.error = null;
    cx.notify();
    try {
      const result = await exec(REQUEST(), ["--goal", goal]);
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || "request failed");
      this.goal.set_value("");
      this.refresh(cx);
    } catch (e) { this.error = String(e?.message ?? e); }
    finally { this.building = false; cx.notify(); }
  }

  back(_cx) {
    run("layout.select", { stack: "panel-body", child: "collie" });
  }

  setFilter(filter, cx) {
    this.filter = filter;
    setShared("inbox.filter", filter);
    this.rows = filter === "working" ? workingDecisions(this.decisions)
      : filter === "settled" ? settledDecisions(this.decisions) : waitingQueue(this.decisions);
    cx.notify();
  }

  row(decision, t) {
    const target = this.targets.get(decision.id);
    const receipt = this.receipts.get(decision.id);
    const title = decision.card?.question ?? target?.title ?? decision.why;
    return v().id(`inbox-${decision.id}`).flex_none().p(10).gap(7).rounded(8).border_1().border_color(t.border)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => openDetails(decision, target, receipt))
      .child(h().w_full().gap(8).items_start()
        .child(div().flex_1().min_w(0).font_medium().text_color(t.foreground).child(title))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(decision.state)))
      .child(div().w_full().text_size(12).text_color(t.muted).child(decision.why))
      .child(h().w_full().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(decision.space))
        .child(div().text_size(11).text_color(t.dim).child(target?.ref ?? decision.run?.task_ref ?? "Decision")));
  }

  queue(t) {
    const tabs = [["waiting", "Needs you"], ["working", "Working"], ["settled", "Settled"]];
    return v().id("collie").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h().h(46).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Inbox"))
        .children(tabs.map(([id, label]) => action(`inbox-${id}`, label, true, (cx) => this.setFilter(id, cx), t)))
        .child(div().px(6).text_size(11).text_color(t.dim).child("New / Build")))
      .child(h().flex_none().px(10).py(8).gap(8).border_b(1).border_color(t.border)
        .child(Input.new(this.goal))
        .child(action("collie-build-go", this.building ? "Working…" : "Send", !this.building, (cx) => this.newBuild(cx), t)))
      .when(this.error, (el) => el.child(div().px(12).py(6).text_color(t.ansi1).child(this.error)))
      .child(v().flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(6)
        .children(this.rows.map((row) => this.row(row, t)))
        .when(!this.rows.length, (el) => el.child(div().p(18).text_center().text_size(12)
          .text_color(this.error ? t.ansi1 : t.dim)
          .child(this.error ?? (this.loading ? "Reading decisions…" : this.filter === "waiting" ? "Nothing needs you." : "Nothing here.")))));
  }

  async answer(option, cx) {
    const decision = selected()?.decision;
    if (!decision || this.answering) return;
    this.answering = true;
    this.error = null;
    const args = [ "--decision", decision.id, "--option", option ];
    if (option === "rework") {
      const note = this.note.content().text.trim();
      if (!note) {
        this.error = "Rework needs a concrete annotation.";
        this.answering = false;
        cx.notify();
        return;
      }
      args.push("--note", note, "--file", "review");
    }
    try {
      const result = await exec(ANSWER(), args);
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || "answer failed");
      this.back(cx);
      this.note.set_value("");
    } catch (e) {
      this.error = String(e?.message ?? e);
    } finally {
      this.answering = false;
      cx.notify();
    }
  }

  detail(t) {
    const current = selected();
    const decision = current?.decision;
    const target = current?.target;
    const receipt = current?.receipt;
    if (!decision) return v().p(16).child("Pick a decision from Inbox.");
    const waiting = decision.state === "waiting";
    return v().id("collie-detail").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h().h(46).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(action("collie-back", "‹ Inbox", true, (cx) => this.back(cx), t))
        .child(div().flex_1())
        .child(action("collie-detail-diff", "Diff", Boolean(diffTarget(target)), () => openDiff(target), t)))
      .child(v().flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(14)
        .child(div().text_size(17).font_semibold().child(decision.card?.question ?? target?.title ?? decision.why))
        .child(div().text_color(t.muted).child(decision.why))
        .child(h().gap(8).text_size(11).text_color(t.dim)
          .child(decision.id).child(decision.state).child(target?.ref ?? decision.run?.task_ref ?? ""))
        .when(receipt, (el) => el.child(v().gap(8).rounded(8).p(12).bg(t.raised)
          .child(div().font_semibold().child(receipt.summary ?? "Receipt"))
          .child(div().child(receipt.details ?? ""))
          .child(div().font_family("JetBrains Mono").text_size(11).text_color(t.dim)
            .child((receipt.proof?.refs ?? []).join("\n")))))
        .when(waiting, (el) => el.child(v().gap(10)
          .child(Input.new(this.note))
          .child(h().gap(8)
            .child(action("answer-accept", "Accept", decision.card?.options?.includes("accept"), (cx) => this.answer("accept", cx), t))
            .child(action("answer-rework", "Rework", decision.card?.options?.includes("rework"), (cx) => this.answer("rework", cx), t))
            .child(action("answer-later", "Later", decision.card?.options?.includes("later"), (cx) => this.answer("later", cx), t))
            .child(action("answer-drop", "Drop", decision.card?.options?.includes("drop"), (cx) => this.answer("drop", cx), t)))))
        .when(this.answering, (el) => el.child(div().text_color(t.dim).child("Sending the choice to coordinator…")))
        .when(this.error, (el) => el.child(div().text_color(t.ansi1).child(this.error))));
  }

  async loadDiff(cx) {
    const target = diffTarget(this.target);
    if (!target) { this.error = "This task has no readable base revision."; return; }
    cx.spawn(async (cx) => {
      try {
        const result = await exec("git", [...READ, "diff", "--no-color", target.range, "--"], {
          cwd: target.cwd, ...(target.on ? { on: target.on } : {}),
        });
        if (result.code !== 0) throw new Error(result.stderr || result.stdout || "git diff failed");
        this.diff = result.stdout || "No diff.";
        this.error = null;
      } catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  diffView(t) {
    const lines = this.diff?.replace(/\n$/, "").split("\n") ?? [];
    return v().id("collie-diff").size_full().min_h(0).p(16).gap(12).bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (props()?.overlay) closeOverlay(props().overlay);
        cx.stop_propagation();
      })
      .child(h().h(32).flex_none().gap(12).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(`Diff ${this.target?.ref ?? ""}`)))
      .child(v().flex_1().min_h(0).overflow_y_scrollbar().rounded(6).p(10)
        .bg(t.background).font_family("JetBrains Mono").text_size(11)
        .when(Boolean(this.error), (el) => el.text_color(t.ansi1).child(this.error))
        .when(!this.error && this.diff === null, (el) => el.text_color(t.dim).child("Reading diff…"))
        .children(lines.map((line, i) => div().id(`diff-line-${i}`).w_full().flex_none()
          .text_color(line.startsWith("+") ? t.ansi2 : line.startsWith("-") ? t.ansi1 : line.startsWith("@@") ? t.dim : t.foreground)
          .child(line || " "))));
  }

  render(_cx) {
    const t = theme();
    if (this.view === "detail") return this.detail(t);
    if (this.view === "diff") return this.diffView(t);
    return this.queue(t);
  }
}
