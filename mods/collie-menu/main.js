// Collie's tab context menu, so closing a coordinator goes through closeTab's stop/keep guard
// instead of Herdr's direct tab.close. Opened by collie-tabs/main.js.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, openOverlay, props, run, setShared, theme } from "herdr";

export default class TabMenu extends View {
  row(id, label, icon, action, t) {
    return h_flex().id(id).h(31).px(8).gap(9).rounded(7).items_center().cursor_pointer()
      .text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(icon).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().child(label));
  }

  render(cx) {
    const t = theme(), p = props(), target = p.target ?? {};
    return v_flex().id("collie-tab-menu").w_full().p(5).bg(t.popover).text_size(12.8)
      .child(this.row("rename", "Rename", "mods/collie-chrome/square-pen.svg", (cx) => {
        closeOverlay(p.overlay);
        openOverlay({ mod: "prompt", kind: "dialog", width: 400, props: { title: "Rename tab", value: target.named ? target.name : "", hint: `Now: ${target.name ?? "Tab"}`, command: { name: "tab.rename", args: { id: target.id } } } });
        cx.notify();
      }, t))
      .child(this.row("new", "New tab", "mods/collie-chrome/plus.svg", (cx) => {
        closeOverlay(p.overlay);
        run("tab.new", { space: target.space });
        cx.notify();
      }, t))
      .child(div().mx(7).my(4).h(1).bg(t.border))
      .child(this.row("close", "Close", "mods/collie-tabs/win-close.svg", (cx) => {
        setShared("collie.closeTabReq", { id: target.id, at: Date.now() });
        closeOverlay(p.overlay);
        cx.notify();
      }, t));
  }
}
