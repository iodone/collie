// Close a coordinator tab: stop its workers first, or leave them running. Opened by
// collie-tabs/coordinator.js closeTab with { tab, workers }; no shep mod.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, exec, props, run, theme } from "herdr";

export default class CloseCoordinator extends View {
  close(cx) { closeOverlay(props().overlay); cx.notify(); }

  finish(stop, cx) {
    const p = props();
    if (p.coord) exec("bash", [`${appHome()}/mods/collie-tabs/bin/close.sh`, p.tab, p.coord, stop ? "stop" : "keep"]).catch(() => {});
    else run("tab.close", { id: p.tab, confirmed: true });
    closeOverlay(p.overlay);
    cx.notify();
  }

  button(id, label, detail, action, t, primary = false) {
    return div().id(id).w_full().p(10).rounded(6).border(1)
      .border_color(primary ? t.accent : t.border).bg(primary ? t.selected : t.background)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(v_flex().gap(2)
        .child(div().font_medium().text_color(t.foreground).child(label))
        .child(div().text_size(12).text_color(t.muted).child(detail)));
  }

  render(cx) {
    const t = theme();
    const n = (props().workers ?? []).length;
    return v_flex().id("close-coordinator").size_full().p(18).gap(12).bg(t.popover).text_size(13)
      .child(div().text_size(16).font_semibold().text_color(t.foreground).child("Close the Coordinator?"))
      .child(div().text_color(t.muted).child(n
        ? `Closing ends the Coordinator session. It has ${n} worker${n > 1 ? "s" : ""} running; their branches and worktrees stay either way.`
        : "Closing ends the Coordinator session. It has no workers running."))
      .when(n > 0, (el) => el
        .child(this.button("stop", "Stop its workers", "Ends the agents it started and closes their tabs.", (cx) => this.finish(true, cx), t))
        .child(this.button("keep", "Let them finish", "Workers keep running in their own tabs, on their own.", (cx) => this.finish(false, cx), t, true)))
      .child(div().flex_1())
      .child(h_flex().justify_end().gap(8)
        .child(this.button("cancel", "Cancel", "Leave the coordinator open.", (cx) => this.close(cx), t))
        .child(this.button("confirm", "Close Coordinator", "Ends the session.", (cx) => this.finish(false, cx), t, true)));
  }
}
