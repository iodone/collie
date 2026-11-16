// Human-owned routing table viewer. Editing stays in the JSON file; the service never writes it.
import { View, div } from "gpui-kit";
import { home, readTextFile, theme } from "herdr";

const path = () => `${home()}/.local/state/collie/ruleset.json`;

export default class InboxRules extends View {
  init(_props, cx) {
    this.text = "Reading ruleset…";
    cx.spawn(async (cx) => {
      try { this.text = await readTextFile(path()); }
      catch (error) { this.text = `${path()}\n\n${String(error?.message ?? error)}`; }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    return div().flex().flex_col().size_full().p(16).gap(12).text_size(12).text_color(t.foreground)
      .child(div().font_semibold().text_size(14).child("Inbox rules · human owned"))
      .child(div().text_color(t.dim).child(path()))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().font_family("JetBrains Mono").child(this.text));
  }
}
