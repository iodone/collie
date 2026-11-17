// New space: the folder and machine a new space is made in, asked here. Opened by coordinator.js
// newSpace (the + menu, the Spaces sidebar, Ctrl+Shift+N, through the tab bar), which finds that
// machine's recent folders and home first (props { recent, machine, home }).
// It draws its own panel (frame "none"), centered, at the sizes coordinator.js NEWSPACE names.
// On another machine, folders are looked up there. Create asks the tab bar to make the space and
// land in it (shared "collie.spacereq"), so the work isn't cut short by this dialog closing.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popup } from "gpui-base";
import { props, theme, home, exec, pickFolder, closeOverlay, setShared, focused, machines, spaces } from "herdr";

// The panel's parts, in px (coordinator.js NEWSPACE, the height the overlay gets).
const K = { pad: 18, title: 20, label: 16, gap: 4, field: 32, row: 31, buttons: 32, section: 16, note: 24 };
const SHOWN = 5;
const REQ = "collie.spacereq";

export default class NewSpace extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.machine = p.machine ?? null; // null: this computer
    this.HOME = p.home ?? home();
    this.recent = p.recent ?? [];
    this.maxRows = Math.min(SHOWN, this.recent.length) + 1;
    this.machineOpen = false;
    this.switching = false;
    this.error = "";
    this.text = tilde(this.defaultFolder(), this.HOME);
    this.input = InputState.new({ placeholder: "~/work/project", value: this.text });
    this.input.on("change", () => { this.text = this.input.value(); this.error = ""; cx.notify(); });
    this.input.on("submit", () => this.create(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
  }

  // The machines a space can be made on, this computer first; the choice shows for two or more.
  reachable() {
    return [{ key: null, name: "This computer" }, ...machines().filter((m) => m.name).map((m) => ({ key: m.name, name: m.name, ready: m.layout === "ready" }))];
  }
  choosing() {
    return machines().some((m) => m.name && m.layout === "ready");
  }

  // Where the person works now: the shown space's folder here, when this is its machine; else home.
  defaultFolder() {
    const here = spaces().find((s) => s.active);
    if ((here?.machine ?? null) !== this.machine) return this.HOME;
    const at = focused()?.cwd;
    return at && !at.startsWith(this.HOME + "/.cache/") ? this.recent.find((r) => at === r || at.startsWith(r + "/")) ?? at : this.HOME;
  }

  // Another machine picked: its home first, then the folder starts over there (its recent folders
  // aren't looked for: the field takes any path).
  switchTo(m, cx) {
    this.machineOpen = false;
    if (m === this.machine || this.switching) return cx.notify();
    this.switching = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const at = await this.homeOf(m);
      this.switching = false;
      if (!at) { this.error = `Couldn't reach ${m}.`; return cx.notify(); }
      this.machine = m;
      this.HOME = at;
      this.recent = [];
      this.text = tilde(at, this.HOME);
      this.input.set_value(this.text);
      this.input.focus();
      cx.notify();
    });
  }

  async homeOf(machine) {
    if (!machine) return home();
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine }).catch(() => null);
    return r && r.code === 0 && r.stdout.startsWith("/") ? r.stdout : null;
  }

  on() {
    return this.machine ? { on: this.machine } : {};
  }

  set(path, cx) {
    this.text = tilde(path, this.HOME);
    this.input.set_value(this.text);
    this.error = "";
    this.input.focus();
    cx.notify();
  }

  // The rows under the field: the recent folders typed for, then Choose folder… (always the last).
  rows() {
    const typed = this.text.trim().toLowerCase();
    const match = this.recent.filter((p) => !typed || p.toLowerCase().includes(typed.replace(/^~/, this.HOME).toLowerCase()));
    return match.slice(0, SHOWN).map((path) => ({ path }));
  }

  folder() {
    return pathOf(this.text.trim(), this.HOME);
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  // Choose folder…: the desktop's own picker here; on another machine, its home is put in the field
  // and can be edited.
  choose(cx) {
    if (this.machine) return this.set(this.HOME, cx);
    cx.spawn(async (cx) => {
      const f = await pickFolder({ prompt: "Choose" });
      if (f) this.set(f, cx);
      this.input.focus();
      cx.notify();
    });
  }

  // Makes the folder when it isn't there, then asks the tab bar for the space (coordinator.js
  // createSpace: its Coordinator tab, on the machine's Collie settings) and closes.
  create(cx) {
    const folder = this.folder();
    if (!folder) { this.error = "Choose a folder."; return cx.notify(); }
    this.error = "";
    cx.spawn(async (cx) => {
      const there = await exec("test", ["-d", folder], this.on()).catch(() => null);
      if (!there || there.code !== 0) {
        const r = await exec("mkdir", ["-p", "--", folder], this.on()).catch(() => null);
        if (!r || r.code !== 0) {
          this.error = r?.stderr?.trim().split("\n").pop() || `Couldn't make ${tilde(folder, this.HOME)}`;
          return cx.notify();
        }
      }
      setShared(REQ, { folder, machine: this.machine, at: Date.now() });
      this.dismiss();
    });
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.machineOpen) { this.machineOpen = false; cx.stop_propagation(); return cx.notify(); }
      this.dismiss();
      cx.stop_propagation();
    }
  }

  button(t, id, label, primary, onClick) {
    return h_flex().id(id).h(K.buttons).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover(s => s.opacity(0.88)).on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); cx.notify(); })
      .child(label);
  }

  // The Machine choice: a field-like button showing the machine, its list under it.
  machineChoice(t, cx) {
    const keys = this.reachable();
    const field = h_flex().id("machine").w_full().h(K.field).px(10).gap(8).items_center().rounded(6).border(1)
      .border_color(this.machineOpen ? t.accent : t.input).bg(t.background).text_color(t.foreground).cursor_pointer()
      .hover(s => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.machineOpen = !this.machineOpen; cx.notify(); })
      .child(svg(`mods/collie-chrome/${this.machine ? "server" : "monitor"}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(this.switching ? `${this.machine ?? "This computer"}…` : keys.find((k) => k.key === this.machine)?.name ?? "This computer"))
      .child(svg("mods/collie-chrome/chevron-down.svg").size(12).flex_none().text_color(t.muted));
    return Popup.new("machine-list", field).w_full().anchor("top_left")
      .when(this.machineOpen, el => el.content(v_flex().id("machine-rows").w(424).mt(4).p(4).rounded(8).border(1).border_color(t.border).bg(t.popover).shadow_lg().text_size(13)
        .children(keys.map((m, i) => h_flex().id(`machine-${i}`).h(K.row).flex_none().px(9).gap(10).rounded(6).items_center().cursor_pointer()
          .when(!m.ready && m.key, r => r.opacity(0.5))
          .hover(s => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); if (m.ready || !m.key) this.switchTo(m.key, cx); })
          .child(svg(`mods/collie-chrome/${m.key ? "server" : "monitor"}.svg`).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(m.name))
          .child(div().size(14).flex_none().when(m.key === this.machine, r => r.child(svg("mods/collie-chrome/check.svg").size(14).text_color(t.foreground))))))));
  }

  render(cx) {
    const t = theme();
    const choosing = this.choosing();
    const rows = this.rows();
    const folder = this.folder();
    const input = Input.new(this.input).w_full().h(K.field).px(10).items_center().rounded(6).border(1)
      .border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground);
    const note = folder && !rows.some((r) => r.path === folder) ? "Made on Create if it isn't there" : "";
    const panel = v_flex().id("collie-space").w_full().flex_none().p(K.pad).rounded(10).border(1).border_color(t.border)
      .bg(t.popover).shadow_lg().text_size(13)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", (_e, cx) => { if (this.machineOpen) { this.machineOpen = false; cx.notify(); } })
      .child(h_flex().h(K.title).flex_none().gap(6).items_baseline().text_size(15).font_semibold().text_color(t.foreground).child("New space")
        .when(this.machine && !choosing, el => el.child(div().min_w(0).truncate().font_normal().text_color(t.dim).child(`on ${this.machine}`))))
      .child(div().h(K.section).flex_none())
      .when(choosing, el => el.child(div().h(K.label).flex_none().text_size(12).text_color(t.dim).child("Machine"))
        .child(div().h(K.gap).flex_none())
        .child(this.machineChoice(t, cx))
        .child(div().h(K.section).flex_none()))
      .child(div().h(K.label).flex_none().text_size(12).text_color(t.dim).child("Folder"))
      .child(div().h(K.gap).flex_none())
      .child(input)
      .child(div().h(K.gap).flex_none())
      .child(v_flex().flex_none().children(rows.slice(0, this.maxRows - 1).map((r) => h_flex().id(`folder-${r.path}`).h(K.row).flex_none().px(9).gap(10).rounded(6).items_center().cursor_pointer()
        .hover(s => s.bg(t.hover))
        .on_click((e, cx) => { cx.stop_propagation(); this.set(r.path, cx); })
        .child(svg("mods/collie-chrome/folder.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_none().max_w(200).truncate().text_color(t.foreground).child(base(r.path)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(tilde(r.path, this.HOME))))))
      .child(h_flex().id("choose").h(K.row).flex_none().px(9).gap(10).rounded(6).items_center().cursor_pointer()
        .hover(s => s.bg(t.hover)).on_click((e, cx) => { cx.stop_propagation(); this.choose(cx); })
        .child(svg("mods/collie-chrome/folder.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(this.machine ? `${this.machine}'s home…` : "Choose folder…")))
      .child(div().h(K.note).flex_none().pt(4).text_size(12).text_color(t.dim).child(this.error || note))
      .child(div().h(K.section).flex_none())
      .child(h_flex().h(K.buttons).flex_none().gap(8).justify_end()
        .child(this.button(t, "cancel", "Cancel", false, () => this.dismiss()))
        .child(this.button(t, "create", "Create space", true, () => this.create(cx))));
    // The overlay is the panel at its tallest; the panel sits in its middle.
    return v_flex().size_full().justify_center().child(panel);
  }
}

const base = (p) => p.replace(/\/+$/, "").split("/").pop() ?? p;
const tilde = (p, at) => (!p ? "" : p === at ? "~" : p.startsWith(at + "/") ? "~" + p.slice(at.length) : p);
const pathOf = (text, at) => (text === "~" ? at : text.startsWith("~/") ? at + text.slice(1) : text);
