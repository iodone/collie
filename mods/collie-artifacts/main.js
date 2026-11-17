// A ticket's Artifacts (SHEP-60): what its agent and its helpers made or updated, its proof first (marked Proof), then
// newest first; each with its title (without the ticket's id in front), how many versions and when. A click opens it in
// the artifact viewer (its versions, Mark up) over the ticket, or the whole window. A child of the ticket view beside
// Terminal; the header finds them (mods/collie/main.js pollArts, core/task-artifacts.js) into shared
// "tasks.thread.artifacts" and counts them on its switch. None: a quiet line.
// The same mod is the viewer's toolbar when props().artifact is set (lib/artview.js mounts it): bar.js draws it.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, shared, props, spaces } from "herdr";
import { openViewer, artifactCli } from "./lib/artview.js";
import { titleInTask } from "./core/task-artifacts.js";
import { TEXT, RADIUS } from "./lib/ui.js";
import { initArtifactBar, artifactBar, closeArtifactBar } from "./bar.js";

const ICON = "mods/collie-artifacts/artifacts.svg";

// "just now", "5m ago", "2h ago", "3d ago", as the web and the header say it
function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
}

// The shown ticket's, once the header has found them (null: not yet).
function mine() {
  const a = shared("tasks.thread.artifacts"), w = shared("tasks.thread");
  return a && w && a.terminal === (w.terminal ?? null) && (w.terminal || a.ref === w.task) ? a : null;
}

export default class CollieArtifacts extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    // The viewer's toolbar (bar.js): its versions, Mark up.
    if (props()?.artifact) return initArtifactBar(this, cx);
    this.opening = null;
    if (props()?.view === "panel") {
      this.panel = { key: null, list: [], loading: true, error: null };
      this.loadPanel(cx);
      cx.timer.every(15000, (cx) => { this.panel.key = null; this.loadPanel(cx); cx.notify(); });
      return;
    }
    // "2h ago" moves on
    cx.timer.every(60000, (cx) => cx.notify());
  }

  panelLocation() {
    const space = spaces().find((s) => s.active);
    return { folder: space?.folder ?? null, machine: space?.machine ?? null, id: space?.id ?? null };
  }

  loadPanel(cx) {
    const at = this.panelLocation();
    if (!at.folder) {
      this.panel = { ...this.panel, key: "none", list: [], loading: false, error: "No folder open." };
      return;
    }
    const key = `${at.machine ?? ""}|${at.folder}`;
    if (this.panel.key === key && !this.panel.error) return;
    this.panel = { ...this.panel, key, loading: true, error: null };
    cx.spawn(async (cx) => {
      try {
        const out = await artifactCli(at.machine, ["list", "--folder", at.folder]);
        this.panel = { key, folder: at.folder, machine: at.machine, list: out?.artifacts ?? [], loading: false, error: null };
      } catch (e) {
        this.panel = { key, folder: at.folder, machine: at.machine, list: [], loading: false, error: String(e?.message ?? e) };
      }
      cx.notify();
    });
  }

  // The viewer going away ends its Mark up.
  close() { if (props()?.artifact) closeArtifactBar(props().artifact); }

  open(a, machine, cx) {
    if (this.opening) return;
    this.opening = a.id;
    cx.notify();
    cx.spawn(async (cx) => {
      await openViewer({ id: a.id, title: a.title, version: a.v, latest: a.v, machine });
      this.opening = null;
      cx.notify();
    });
  }

  note(t, title, text) {
    return v_flex().flex_1().items_center().justify_center().px(24).gap(6)
      .child(svg(ICON).size(18).flex_none().text_color(t.dim))
      .child(div().pt(2).text_size(13).font_medium().text_color(t.muted).child(title))
      .when(Boolean(text), (el) => el.child(div().max_w(260).text_center().text_size(TEXT.label).text_color(t.dim).child(text)));
  }

  row(t, a, ref, machine, i) {
    const busy = this.opening === a.id;
    return h_flex().id(`ticket-art-${i}`).w_full().min_w(0).px(10).py(8).gap(10).items_start().rounded(RADIUS.control).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); this.open(a, machine, cx); })
      .child(div().pt(1).flex_none().child(svg(ICON).size(14).text_color(a.proof ? t.accent : t.dim)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().min_w(0).gap(8).items_center()
          .child(div().min_w(0).truncate().text_size(13).text_color(t.foreground).child(titleInTask(a.title, ref, a.proof)))
          .when(Boolean(a.proof), (el) => el.child(div().flex_none().h(18).px(7).flex().items_center().rounded(9).bg(t.selected)
            .text_size(11).font_medium().text_color(t.muted).child("Proof"))))
        .child(div().min_w(0).truncate().text_size(TEXT.label).text_color(t.dim)
          .child(busy ? "Opening…" : [`${a.v} ${a.v === 1 ? "version" : "versions"}`, a.at ? ago(a.at) : null].filter(Boolean).join(" · "))));
  }

  panelRow(t, a, machine, i) {
    const busy = this.opening === a.id;
    return h_flex().id(`panel-art-${i}`).w_full().min_w(0).px(10).py(8).gap(10).items_start().rounded(RADIUS.control).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); this.open(a, machine, cx); })
      .child(div().pt(1).flex_none().child(svg(ICON).size(14).text_color(a.proof ? t.accent : t.dim)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().min_w(0).gap(8).items_center()
          .child(div().min_w(0).truncate().text_size(13).text_color(t.foreground).child(a.title || a.id))
          .when(Boolean(a.proof), (el) => el.child(div().flex_none().h(18).px(7).flex().items_center().rounded(9).bg(t.selected)
            .text_size(11).font_medium().text_color(t.muted).child("Proof"))))
        .child(div().min_w(0).truncate().text_size(TEXT.label).text_color(t.dim)
          .child(busy ? "Opening…" : [`${a.v ?? a.version ?? 1} ${(a.v ?? a.version ?? 1) === 1 ? "version" : "versions"}`, a.at ? ago(a.at) : null].filter(Boolean).join(" · "))));
  }

  panelView(cx, t) {
    const root = v_flex().id("artifacts-panel").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13);
    const p = this.panel;
    if (p.loading) return root.child(this.note(t, "Looking for artifacts…"));
    if (p.error) return root.child(this.note(t, "Couldn't read artifacts", p.error));
    if (!p.list.length) return root.child(this.note(t, "No artifacts yet", "Reports and proofs published in this folder show here."));
    return root.child(v_flex().id("artifacts-panel-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
      .children(p.list.map((x, i) => this.panelRow(t, x, p.machine, i))));
  }

  render(cx) {
    const t = theme();
    if (props()?.artifact) return artifactBar(this, props().artifact, this.handle);
    if (props()?.view === "panel") {
      this.loadPanel(cx);
      return this.panelView(cx, t);
    }
    const root = v_flex().id("ticket-artifacts").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13);
    const w = shared("tasks.thread");
    if (!w) return root.child(this.note(t, "No ticket open."));
    const a = mine();
    if (!a) return root.child(this.note(t, "Looking for its artifacts…"));
    if (!a.list.length) return root.child(this.note(t, "No artifacts yet", "Reports and proofs this ticket's agent makes show here."));
    return root.child(v_flex().id("ticket-artifacts-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
      .children(a.list.map((x, i) => this.row(t, x, a.ref, a.machine, i))));
  }
}
