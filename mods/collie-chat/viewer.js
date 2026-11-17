// The Coordinator chat's image viewer: a backdrop in the theme's colors over the chat pane, the image large in the
// middle, a small toolbar on top (name and size, "2 / 3" when there are several, close), previous / next at the sides,
// Left / Right to step, Esc or a click beside the image to close. A pasted text file opens in it too, to read.
// A minimal port of shepherdr's chat-image viewer (no zoom, pan, copy, reveal or artifact toolbar): what the Coordinator
// chat needs to show the pictures it sends and the files it takes. Like picker.js it is this mod, opened by main.js with
// props { viewer }: { images?: [{ rel, w, h, name, path }], index?, textPath?, title? } (rel in the app's folder:
// attach.js viewable()).

import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, props, readTextFile, theme } from "herdr";
import { RADIUS, TEXT } from "./lib/ui.js";

const BAR = 44;          // the toolbar's height
const MARGIN = 24;       // room around a fitted image
const SIDE = 56;         // room for the previous / next buttons
// The popup's own size: a popup's root needs its size spelled out.
export const VIEW = { width: 880, height: 620, textWidth: 720, textHeight: 520 };
const backdrop = (t) => `${t.background}f2`;

export class ImageViewer extends View {
  constructor(p, cx) {
    this.p = p ?? {};
    this.images = this.p.images ?? [];
    this.i = Math.min(Math.max(0, this.p.index ?? 0), Math.max(0, this.images.length - 1));
    this.size = { width: VIEW.width, height: VIEW.height };
    this.text = null;
    this.handle = cx.focus_handle();
    cx.timer.after(0, () => this.handle.focus());
    if (this.p.textPath) cx.spawn(async (cx) => { this.text = (await readTextFile(this.p.textPath).catch(() => null)) ?? "(can't read it)"; cx.notify(); });
  }

  close() { closeOverlay(props()?.overlay); }

  img() { return this.images[this.i]; }
  many() { return this.images.length > 1; }
  step(d) {
    if (!this.many()) return;
    this.i = (this.i + d + this.images.length) % this.images.length;
  }

  // The stage: everything under the toolbar. The image fitted inside, never above its own size.
  stage() { return { w: Math.max(100, this.size.width), h: Math.max(100, this.size.height - BAR) }; }
  fit() {
    const img = this.img(), s = this.stage();
    if (!img) return null;
    const roomW = Math.max(40, s.w - 2 * (this.many() ? SIDE : MARGIN));
    const roomH = Math.max(40, s.h - 2 * MARGIN - (this.many() ? 28 : 0));
    const k = Math.min(1, roomW / img.w, roomH / img.h);
    const w = Math.round(img.w * k), h = Math.round(img.h * k);
    return { w, h, left: Math.round((s.w - w) / 2), top: Math.round((s.h - h) / 2) };
  }

  textView(t) {
    return v_flex().id("collie-chat-viewer").w(this.size.width).h(this.size.height).items_center().justify_center()
      .bg(backdrop(t)).track_focus(this.handle)
      .on_click(() => this.close())
      .child(v_flex().id("viewer-text").w(Math.min(VIEW.textWidth, this.size.width - 48)).h(Math.min(VIEW.textHeight, this.size.height - 48))
        .rounded(RADIUS.card).bg(t.popover).border_1().border_color(t.border).overflow_hidden()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => cx.stop_propagation())
        .child(h_flex().h(36).flex_none().px(14).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(TEXT.body).font_medium().text_color(t.foreground).child(this.p.title ?? "Pasted text")))
        .child(div().id("viewer-text-body").flex_1().min_h(0).p(14).overflow_y_scrollbar()
          .text_size(TEXT.label).text_color(t.foreground)
          .children(String(this.text ?? "").split("\n").slice(0, 5000).map((l) => div().min_h(18).child(l || " ")))));
  }

  arrow(id, icon, d, side, t) {
    const s = this.stage();
    return div().id(id).absolute().top(s.h / 2 - 20).when(side === "left", (el) => el.left(14)).when(side === "right", (el) => el.right(14))
      .size(40).flex().items_center().justify_center().rounded(20).cursor_pointer()
      .bg(t.raised).border_1().border_color(t.border).text_color(t.foreground).hover((st) => st.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.step(d); cx.notify(); })
      .child(svg(`mods/collie-chat/${icon}.svg`).size(18));
  }

  toolbar(img, t) {
    return h_flex().id("viewer-bar").w_full().h(BAR).flex_none().pl(16).pr(8).gap(8).items_center()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().flex_1().min_w(0).gap(10).items_baseline().text_size(TEXT.body)
        .child(div().min_w(0).truncate().font_medium().text_color(t.foreground).child(img?.name ?? this.p.title ?? "Image"))
        .when(Boolean(img), (el) => el.child(div().flex_none().text_size(TEXT.label).text_color(t.muted).child(`${img.w} × ${img.h}`))))
      .when(this.many(), (el) => el.child(div().flex_none().text_size(TEXT.label).text_color(t.muted).child(`${this.i + 1} / ${this.images.length}`)))
      .child(div().id("viewer-close").size(32).flex_none().flex().items_center().justify_center().rounded(RADIUS.control)
        .cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.close(); })
        .child(svg("mods/collie-chat/x.svg").size(16)));
  }

  render() {
    const t = theme();
    if (this.p.textPath) return this.textView(t);
    const img = this.img();
    const s = this.stage();
    const r = img ? this.fit() : null;
    return v_flex().id("collie-chat-viewer").w(this.size.width).h(this.size.height).bg(backdrop(t))
      .track_focus(this.handle)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "left") this.step(-1);
        else if (e.key === "right") this.step(1);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(this.toolbar(img, t))
      .child(div().id("viewer-stage").relative().w_full().flex_1().min_h(0).overflow_hidden()
        // A click beside the image closes.
        .on_mouse_down("left", (e, cx) => {
          const at = e.local_position;
          const on = at && r && at.x >= r.left && at.x <= r.left + r.w && at.y >= r.top && at.y <= r.top + r.h;
          if (!on) { cx.stop_propagation(); this.close(); }
        })
        .when(Boolean(img), (el) => el.child(div().absolute().left(r.left).top(r.top).w(r.w).h(r.h).rounded(4).overflow_hidden()
          .child(image(img.rel).size_full())))
        .when(!img, (el) => el.child(div().size_full().flex().items_center().justify_center().text_size(TEXT.body).text_color(t.muted)
          .child("Can't show this image.")))
        .when(this.many(), (el) => el
          .child(this.arrow("viewer-prev", "chevron-left", -1, "left", t))
          .child(this.arrow("viewer-next", "chevron-right", 1, "right", t))
          .child(div().absolute().bottom(14).left(s.w / 2 - 32).w(64).h(24).flex().items_center().justify_center().rounded(12)
            .bg(t.raised).text_size(TEXT.label).text_color(t.foreground).child(`${this.i + 1} / ${this.images.length}`))));
  }
}
