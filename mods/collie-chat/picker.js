// The Coordinator chat's model menu (#21): a small popover above the chat's pick button, where the person chooses the
// agent, model, reasoning effort, Fast and permission mode — before the first message (what it will start on) or to
// restart the running agent. Ported from shepherdr's mods/chat-models, with collie-chat's own UI and settings:
// no search over every agent, no pinned/recent models, no typed model ids (see core/agents.js).
//
// It is the chat mod itself, opened by main.js with props { picker }: { mode: "fresh" | "restart", pane, machine,
// current }. Every change in "fresh" mode goes back at once as shared "collie-chat.pick" = { pane, at, pick } (the chat
// keeps it and starts on it); Restart goes back as shared "collie-chat.restartreq" = { pane, at, pick }.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, exec, knownAgents, props, setShared, theme } from "herdr";
import { DEFAULTS, NAMES, PERMS, chooseModel, choicesFrom, effortShort, fitPick, levelName, parseDefaults, pickChanges, pickLevel } from "./core/agents.js";
import { TEXT, RADIUS, button, segmented, toggleSwitch } from "./lib/ui.js";

// The popover's sizes: as wide as its longest line, as tall as it can get (the agent tabs, 6 model rows, Reasoning,
// Fast, Permissions and the footer). The chat opens it that tall, so it never grows after the press.
export const PICK = { width: 324, height: 516, row: 30, list: 6 * 30, head: 24, seg: 30, foot: 40, pad: 6 };

const LOADING = "Loading agents…";
const NOTE = "Used when your first message starts it.";
// A pick's identity for telling the chat it changed (the words can look the same for two different flags).
const sig = (s) => JSON.stringify([s?.agent ?? null, s?.model ?? null, s?.effort ?? null, Boolean(s?.fast), s?.perm ?? null]);

// What the agents on this machine (or `machine`) offer: { menus, permDefault, defaults }. `currentModels` keeps a
// running chat's model in its list; `keep` keeps its agent (the one running) even when the app doesn't list it.
export async function loadChoices(machine = null, currentModels = {}, keep = []) {
  const on = machine ? { on: machine } : {};
  const [claude, codex, known] = await Promise.all([
    defaultsFor("claude", on), defaultsFor("codex", on), knownAgents(on).catch(() => []),
  ]);
  const prog = (key) => known.find((a) => a.key === key || (a.run ?? [])[0] === key);
  const installed = Object.fromEntries(["claude", "codex"].map((k) => [k,
    keep.includes(k) || (prog(k) ? prog(k).installed !== false : true)]));
  return { ...choicesFrom({ claude, codex }, installed, currentModels), dflts: { claude, codex } };
}

async function defaultsFor(kind, on) {
  const r = await exec("sh", ["-c", DEFAULTS, "defaults", kind], on).catch(() => null);
  return parseDefaults(kind, r?.stdout ?? "");
}

export class ModelPicker {
  constructor(p, cx) {
    this.p = p ?? {};
    this.mode = this.p.mode === "restart" ? "restart" : "fresh";
    this.sel = { agent: null, model: null, effort: null, fast: false, perm: null, ...(this.p.current ?? {}) };
    this.was = { ...this.sel };
    this.data = null;
    this.error = null;
    // "fresh": a change goes back after the render that shows it (never on open: the chat already has this pick).
    this.told = null;
    this.handle = cx.focus_handle();
    cx.timer.after(0, () => this.handle.focus());
    cx.spawn(async (cx) => {
      try {
        const data = await loadChoices(this.p.machine ?? null, { [this.sel.agent]: this.sel.model },
          this.mode === "restart" ? [this.sel.agent] : []);
        this.data = data;
        this.sel = fitPick(data.menus, this.sel, data.permDefault);
        this.was = fitPick(data.menus, this.was, data.permDefault);
        this.told = sig(this.sel);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  // Every change in "fresh" mode, at once: the chat keeps it and its first message starts on it.
  tell(cx) {
    if (this.mode !== "fresh") return;
    const now = sig(this.sel);
    if (now === this.told) return;
    this.told = now;
    setShared("collie-chat.pick", { pane: this.p.pane, at: Date.now(), pick: { ...this.sel } });
    cx.notify();
  }

  restart(cx) {
    setShared("collie-chat.restartreq", { pane: this.p.pane, at: Date.now(), pick: { ...this.sel } });
    this.close();
    cx.notify();
  }

  head(t, text, right = null) {
    return h_flex().h(PICK.head).flex_none().w_full().items_center().justify_between().px(2)
      .text_size(TEXT.id).font_medium().text_color(t.dim)
      .child(div().child(text))
      .when(Boolean(right), (el) => el.child(div().text_size(TEXT.id).text_color(t.dim).child(right)));
  }

  // The agent's tabs: one per installed agent (the running one always).
  tabs(t) {
    const agents = Object.keys(this.data?.menus ?? {});
    if (agents.length < 2) return null;
    return h_flex().h(32).flex_none().w_full().p(2).gap(2).rounded(RADIUS.control).bg(t.raised)
      .children(agents.map((a) => h_flex().id(`pick-agent-${a}`).flex_1().min_w(0).h_full().justify_center().items_center().rounded(5)
        .text_size(TEXT.label)
        .when(this.sel.agent === a, (el) => el.bg(t.background).text_color(t.foreground).font_medium())
        .when(this.sel.agent !== a, (el) => el.text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.sel = chooseModel(this.data.menus, this.data.permDefault, this.sel, a, this.data.menus[a].models[0]?.id ?? null);
            cx.notify();
          }))
        .child(div().truncate().child(NAMES[a] ?? a))));
  }

  // One model: the check on the one chosen, its name, and a quiet word for the agent's own default.
  modelRow(t, m, i) {
    const on = (m.id ?? null) === (this.sel.model ?? null);
    return h_flex().id(`pick-model-${i}`).h(PICK.row).flex_none().w_full().px(8).gap(8).rounded(6).items_center()
      .text_size(TEXT.label).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .when(on, (el) => el.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.sel = chooseModel(this.data.menus, this.data.permDefault, this.sel, this.sel.agent, m.id);
        cx.notify();
      })
      .child(div().size(14).flex_none().when(on, (el) => el.child(svg("mods/collie-chat/check.svg").size(14).text_color(t.foreground))))
      .child(div().flex_1().min_w(0).truncate().child(m.name ?? m.id ?? "Default"))
      .when(m.id === null, (el) => el.child(div().flex_none().text_size(TEXT.id).text_color(t.dim).child("its own")))
      .when(m.fast && m.id !== null, (el) => el.child(div().flex_none().text_size(TEXT.id).text_color(t.dim).child("Fast")));
  }

  body(t, cx) {
    const menu = this.data.menus[this.sel.agent];
    const models = menu?.models ?? [];
    const m = models.find((x) => (x.id ?? null) === (this.sel.model ?? null)) ?? models[0];
    const level = pickLevel(this.data.menus, this.sel);
    const changes = this.mode === "restart" ? pickChanges(this.data.menus, this.sel, this.was) : [];
    const switched = this.mode === "restart" && this.sel.agent !== this.was.agent;
    const perms = menu?.perms ?? PERMS[this.sel.agent] ?? [];
    const tabs = this.tabs(t);
    return v_flex().w_full().flex_1().min_h(0).px(PICK.pad).pb(PICK.pad).gap(4)
      .when(Boolean(tabs), (el) => el.child(tabs).child(div().h(6).flex_none()))
      .child(this.head(t, "Model", menu?.name ?? NAMES[this.sel.agent]))
      .child(div().h(Math.min(PICK.list, Math.max(PICK.row, models.length * PICK.row))).w_full().flex_none()
        .overflow_y_scrollbar().flex().flex_col().gap(1)
        .children(models.map((x, i) => this.modelRow(t, x, i)))
        .when(!models.length, (el) => el.child(h_flex().h(PICK.row).px(8).items_center().text_size(TEXT.label).text_color(t.dim)
          .child("This agent named no models: it starts on its own."))))
      .child(div().h(8).flex_none())
      .when(Boolean(m?.efforts?.length), (el) => el.child(this.head(t, "Reasoning", levelName(level)))
        .child(segmented(`pick-level-${this.sel.agent}`, m.efforts.map((e) => [e, effortShort(e)]), this.sel.effort,
          (e, _ev, cx) => { this.sel = { ...this.sel, effort: e }; cx.notify(); }, { fill: true })))
      .when(Boolean(m?.fast), (el) => el.child(h_flex().h(PICK.seg).flex_none().w_full().items_center().justify_between().px(2)
        .child(div().text_size(TEXT.label).text_color(t.muted).child("Fast"))
        .child(toggleSwitch("pick-fast", Boolean(this.sel.fast), (on, _e, cx) => { this.sel = { ...this.sel, fast: on }; cx.notify(); }))))
      .when(perms.length > 0, (el) => el.child(this.head(t, "Permissions", perms.find((x) => x.id === this.sel.perm)?.label ?? null))
        .child(segmented(`pick-perm-${this.sel.agent}`, perms.map((x) => [x.id, x.short ?? x.label]), this.sel.perm,
          (id, _ev, cx) => { this.sel = { ...this.sel, perm: id }; cx.notify(); }, { fill: true })))
      .child(div().flex_1())
      .child(this.foot(t, cx, { changes, switched }));
  }

  foot(t, cx, { changes, switched }) {
    const note = this.mode !== "restart" ? NOTE
      : switched ? `${NAMES[this.sel.agent] ?? this.sel.agent} starts a new conversation; this one stays in ${NAMES[this.was.agent] ?? this.was.agent}'s history.`
      : changes.length ? `Restart with ${changes.join(" · ")}` : "Same as now.";
    return v_flex().w_full().flex_none().gap(6).pt(6).border_t(1).border_color(t.border)
      .child(div().min_h(2 * 15).flex_none().text_size(TEXT.id).line_height("15px").text_color(t.dim).child(note))
      .child(h_flex().w_full().flex_none().gap(8).items_center().justify_end()
        .when(this.mode === "restart", (el) => el
          .child(button("pick-cancel", "Cancel", { kind: "plain", onClick: (_e, cx) => { this.close(); cx.notify(); } }))
          .child(button("pick-restart", "Restart", { kind: "primary", disabled: !changes.length,
            onClick: (_e, cx) => this.restart(cx) })))
        .when(this.mode !== "restart", (el) => el
          .child(button("pick-done", "Done", { kind: "primary", onClick: (_e, cx) => { this.tell(cx); this.close(); cx.notify(); } }))));
  }

  render(cx) {
    const t = theme();
    // A change chosen here goes back once the render that shows it is done.
    if (this.mode === "fresh" && this.data && sig(this.sel) !== this.told) cx.timer.after(0, (cx) => this.tell(cx));
    return v_flex().id("collie-chat-pick").w(PICK.width).h(PICK.height).p(PICK.pad).rounded(RADIUS.card)
      .bg(t.popover).border_1().border_color(t.border).shadow_lg().text_size(TEXT.body).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        cx.stop_propagation();
        this.tell(cx);
        this.close();
        cx.notify();
      })
      .when(!this.data, (el) => el.child(h_flex().flex_1().items_center().justify_center().px(8)
        .text_size(TEXT.label).text_color(this.error ? t.ansi1 : t.dim).child(this.error ?? LOADING)))
      .when(Boolean(this.data), (el) => el.child(this.body(t, cx)));
  }
}
