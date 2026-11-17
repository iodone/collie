import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { closeOverlay, home, props, readTextFile, theme, writeTextFile } from "herdr";
import { coordinatorPath, mergeCoordinator } from "./lib/inbox-settings.js";
import { TEXT, RADIUS, H, button, segmented } from "./lib/ui.js";

const sectionIcon = "mods/shepherdr-settings/bot.svg";

export default class InboxSettings extends View {
  init(_props, cx) {
    this.section = "coordinator";
    this.cfg = {};
    this.raw = null;
    this.savedAt = 0;
    this.model = InputState.new({ placeholder: "default" });
    this.model.on("blur", (_e, cx) => this.save({ model: this.model.content().text.trim() }, cx));
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      await this.load();
      cx.notify();
    });
  }

  async load() {
    this.raw = await readTextFile(coordinatorPath(home())).catch(() => null);
    try { this.cfg = JSON.parse(this.raw ?? "{}"); } catch { this.cfg = {}; }
    this.model.set_value(this.cfg.everywhere?.coordinator?.model ?? "default");
  }

  save(patch, cx) {
    cx.spawn(async (cx) => {
      try {
        const next = mergeCoordinator(this.cfg, {
          cli: this.cfg.everywhere?.coordinator?.cli ?? "codex",
          model: this.model.content().text.trim(),
          effort: this.cfg.everywhere?.coordinator?.effort ?? "high",
          ...patch,
        });
        await writeTextFile(coordinatorPath(home()), JSON.stringify(next, null, 2) + "\n", this.raw);
        this.cfg = next;
        this.raw = JSON.stringify(next, null, 2) + "\n";
        this.savedAt = Date.now();
      } catch (error) { this.error = String(error?.message ?? error); }
      cx.notify();
      cx.timer.after(2200, (cx) => { this.savedAt = 0; cx.notify(); });
    });
  }

  close() { closeOverlay(props().overlay); }

  row(t, title, about, control, under = null) {
    return v_flex().w_full().gap(10).py(12).border_b(1).border_color(t.border)
      .child(h_flex().w_full().gap(16).items_center()
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(TEXT.body).font_medium().text_color(t.foreground).child(title))
          .child(div().text_size(TEXT.label).line_height("17px").text_color(t.dim).child(about))
          .when(Boolean(under), (el) => el.child(under)))
        .child(div().flex_none().child(control)));
  }

  levelBar(t) {
    const own = Object.keys(this.cfg.spaces ?? {}).length;
    return v_flex().pb(18).gap(6)
      .child(h_flex().gap(10).items_center()
        .child(div().text_size(TEXT.label).text_color(t.dim).child("Applies to"))
        .child(div().h(H.sm).px(10).flex().items_center().rounded(RADIUS.control).bg(t.raised)
          .text_size(TEXT.label).text_color(t.foreground).child("Everywhere")))
      .child(div().text_size(TEXT.label).text_color(t.dim)
        .child(own ? `Inherited unless one of ${own} space(s) sets its own.` : "Every space, unless it sets its own."));
  }

  coordinator(t) {
    const current = this.cfg.everywhere?.coordinator ?? {};
    const saved = this.savedAt ? div().text_size(TEXT.label).text_color(t.dim).child("Saved") : null;
    return v_flex()
      .child(div().pb(6).text_size(TEXT.title).font_semibold().text_color(t.foreground).child("Coordinator"))
      .child(this.row(t, "Agent CLI", "The headless agent that turns a Case into a Decision.",
        segmented("coordinator-cli", [["codex", "Codex"], ["claude", "Claude"]], current.cli ?? "codex",
          (cli, _e, cx) => this.save({ cli }, cx))))
      .child(this.row(t, "Model", "Use the CLI default or name a model for this coordinator.",
        div().w(220).child(Input.new(this.model)), saved))
      .child(this.row(t, "Effort", "How much reasoning the coordinator spends on each decision.",
        segmented("coordinator-effort", [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "XHigh"], ["max", "Max"]],
          current.effort ?? "high", (effort, _e, cx) => this.save({ effort }, cx), { size: "lg" })))
      .child(this.row(t, "Session", "New / Build creates a session. Card Review resumes it from the Ledger.",
        div().text_size(TEXT.label).text_color(t.dim).child("Per space")));
  }

  render(_cx) {
    const t = theme();
    const nav = v_flex().flex_none().w(190).h_full().p(10).gap(2).border_r(1).border_color(t.border)
      .child(div().px(10).pt(6).pb(12).text_size(TEXT.title).font_semibold().text_color(t.foreground).child("Inbox"))
      .child(h_flex().id("collie-settings-coordinator").h(30).gap(10).px(10).flex_none().items_center().rounded(RADIUS.card).bg(t.raised)
        .child(svg(sectionIcon).size(15).text_color(t.accent))
        .child(div().flex_1().text_size(TEXT.body).text_color(t.foreground).child("Coordinator")));
    const card = h_flex().id("collie-settings").track_focus(this.handle).w_full().h_full().max_h(900).min_h(0).items_start()
      .rounded(12).border_1().border_color(t.border).bg(t.popover).shadow_lg().overflow_hidden()
      .on_click((_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx) => { if (e.key === "escape") this.close(); })
      .child(nav)
      .child(div().relative().flex_1().min_w(0).h_full()
        .child(div().id("collie-settings-body").size_full().overflow_y_scroll()
          .child(div().px(28).py(22)
            .child(this.levelBar(t))
            .child(this.coordinator(t))
            .when(this.error, (el) => el.child(div().pt(16).text_size(TEXT.label).text_color(t.ansi1).child(this.error)))))
        .child(Scrollbar.vertical("collie-settings-body").absolute().inset_0()));
    return div().id("collie-settings-root").size_full().flex().items_center().justify_center()
      .on_click(() => this.close()).child(card);
  }
}
