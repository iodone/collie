import { View, div } from "gpui-kit";
import { run, shared, theme } from "herdr";

export default class InboxRail extends View {
  render(_cx) {
    const t = theme();
    const count = shared("inbox.queue")?.waiting ?? 0;
    return div().id("collie-rail").size_full().px(10).flex().flex_row().gap(8).items_center()
      .bg(t.chrome).text_size(12).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => {
        run("layout.select", { stack: "panel-body", child: "collie" });
        run("layout.select", { stack: "collie", child: "collie-list" });
        run("layout.show", { id: "panel" });
      })
      .child(div().flex_1().child("Inbox"))
      .child(div().min_w(18).h(18).px(4).flex().items_center().justify_center().rounded(9)
        .bg(count ? t.ansi1 : t.raised).text_color(count ? t.background : t.dim)
        .text_size(11).child(String(count)));
  }
}
