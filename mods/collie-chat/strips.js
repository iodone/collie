// A card in the conversation: a permission, a question, a plan, or a CLI's start screen. Ported from shepherdr's
// strips.js for the coordinator chat (#7 Slice 2), where cards are ordinary rows of the message list (not a virtual
// list): every control carries its own click handler, so there is no hit testing or out-of-sight measuring.
// A card is a run of strips, one row each, that look like one card (the first has its top edge, the last its bottom).
// A strip: { key, kind, gap (px above it), ... }:
//   head: { who, dot, tone (who's color), links: [ctl] }   who asks, quiet links at the right
//   title / text: { text, tone ("dim" | "muted" | "red" | "fg") }
//   detail: { lines, clip (px it folds to, or null) }      what is asked for, in a box
//   controls: { align ("start" | "end"), lead (words before), ctls: [ctl] }
//   option: { on, multi, num, label, tag, desc, fn }       a whole-width choice
//   review: { label, answer, missing, fn }                 an answer to check, opens its question
//   input: { state, indent, placeholder }                  a box to type in
// A ctl: { id, label, look ("primary" | "secondary" | "plain" | "pill" | "link"), on, done,
// disabled, fn }. fn(cx) runs on a press.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { button, red, RADIUS, TEXT } from "./lib/ui.js";

const PAD = 12, LINK_GAP = 12;
const GAPS = { controls: 6, pill: 4 };

// A control as drawn: the shared button (ui.js), a pill, or a quiet link.
export function ctlEl(t, c) {
  const live = !c.disabled && Boolean(c.fn);
  if (c.look === "link") return div().id(c.id).flex_none().whitespace_nowrap().text_size(TEXT.label).text_color(t.muted)
    .when(live, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click((e, cx) => { cx.stop_propagation(); c.fn(cx); cx.notify(); }))
    .child(c.label);
  if (c.look === "pill") return h_flex().id(c.id).h(24).px(9).gap(5).flex_none().items_center().rounded(12).whitespace_nowrap().text_size(TEXT.label)
    .when(Boolean(c.on), (el) => el.bg(t.selected).text_color(t.foreground).font_medium())
    .when(!c.on, (el) => el.text_color(t.muted).when(live, (el) => el.hover((s) => s.bg(t.hover))))
    .when(live, (el) => el.cursor_pointer().on_click((e, cx) => { cx.stop_propagation(); c.fn(cx); cx.notify(); }))
    .when(Boolean(c.done), (el) => el.child(svg("mods/collie-chat/check.svg").size(11).flex_none().text_color(t.dim)))
    .child(c.label);
  return button(c.id, c.label, { kind: c.look ?? "secondary", disabled: Boolean(c.disabled), onClick: live ? (e, cx) => c.fn(cx) : null });
}

const tone = (t, k) => ({ dim: t.dim, muted: t.muted, red: red(), fg: t.foreground })[k] ?? t.muted;

// One strip, in the card's frame. first / last: whether it draws the card's top / bottom edge.
export function strip(t, s, first, last) {
  const frame = v_flex().w_full().bg(t.surface).border_1().border_color(t.border).px(PAD)
    .pt(first ? 10 : s.gap ?? 8).pb(last ? 10 : 0)
    .when(!first, (el) => el.border_t(0)).when(!last, (el) => el.border_b(0))
    .when(first, (el) => el.rounded_t(RADIUS.card)).when(last, (el) => el.rounded_b(RADIUS.card));
  return frame.child(body(t, s));
}

function body(t, s) {
  switch (s.kind) {
    case "head":
      return h_flex().w_full().min_h(18).gap(LINK_GAP).items_center()
        .child(h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().size(8).flex_none().rounded(4).bg(s.dot ?? red()))
          .child(div().min_w(0).truncate().text_size(TEXT.label).font_medium().text_color(s.dot ? t.muted : red()).child(s.who)))
        .when((s.links ?? []).length > 0, (el) => el.child(h_flex().flex_none().gap(LINK_GAP).items_center().children(s.links.map((c) => ctlEl(t, c)))));
    case "title":
      return div().min_w(0).text_size(TEXT.body).font_medium().text_color(t.foreground).child(s.text);
    case "text":
      return div().min_w(0).text_size(TEXT.label).line_height("18px").text_color(tone(t, s.tone)).child(s.text);
    case "detail":
      return div().w_full().px(8).py(6).rounded(RADIUS.control).bg(t.background).overflow_hidden()
        .when(s.clip != null, (el) => el.max_h(s.clip))
        .text_size(TEXT.label).text_color(t.muted).children(s.lines.map((l) => div().min_w(0).child(l || " ")));
    case "controls":
      return h_flex().w_full().gap(s.ctls.every((c) => c.look === "pill") ? GAPS.pill : GAPS.controls).items_center()
        .when(s.align === "end", (el) => el.justify_end())
        .when(Boolean(s.lead), (el) => el.child(div().flex_none().pr(2).text_size(TEXT.label).text_color(t.dim).child(s.lead)))
        .children(s.ctls.map((c) => ctlEl(t, c)));
    case "option": {
      const mark = s.num != null
        ? h_flex().w(18).h(19).flex_none().items_center().justify_center().rounded(5).bg(t.raised).text_size(TEXT.id).font_medium().text_color(t.muted).child(String(s.num))
        : div().size(14).flex_none().flex().items_center().justify_center().border_1().rounded(s.multi ? 3 : 7)
          .border_color(s.on ? t.accent : t.input).when(Boolean(s.on), (el) => el.bg(t.accent))
          .when(Boolean(s.on) && Boolean(s.multi), (el) => el.child(svg("mods/collie-chat/check.svg").size(10).text_color(t.background)))
          .when(Boolean(s.on) && !s.multi, (el) => el.child(div().size(6).rounded(3).bg(t.background)));
      return h_flex().w_full().px(8).py(6).gap(10).items_start().rounded(RADIUS.card)
        .when(Boolean(s.id), (el) => el.id(s.id))
        .when(Boolean(s.disabled), (el) => el.opacity(0.6))
        .when(!s.disabled && Boolean(s.fn), (el) => el.cursor_pointer().hover((st) => st.bg(s.on ? t.selected : t.hover))
          .on_click((e, cx) => { cx.stop_propagation(); s.fn(cx); cx.notify(); }))
        .when(Boolean(s.on), (el) => el.bg(t.selected))
        .child(div().pt(s.num != null ? 0 : 2).child(mark))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().gap(6).items_center().child(div().min_w(0).text_color(t.foreground).child(s.label))
            .when(Boolean(s.tag), (el) => el.child(div().px(6).h(16).flex_none().flex().items_center().rounded(4).bg(t.raised).text_size(TEXT.id).text_color(t.muted).child(s.tag))))
          .when(Boolean(s.desc), (el) => el.child(div().text_size(TEXT.label).text_color(t.dim).child(s.desc))));
    }
    case "review":
      return h_flex().w_full().px(8).py(6).gap(10).rounded(RADIUS.card).cursor_pointer().hover((st) => st.bg(t.hover))
        .when(Boolean(s.fn), (el) => el.on_click((e, cx) => { cx.stop_propagation(); s.fn(cx); cx.notify(); }))
        .child(div().w(150).flex_none().truncate().text_size(TEXT.label).text_color(t.dim).child(s.label))
        .child(div().flex_1().min_w(0).text_color(s.missing ? red() : t.foreground).child(s.answer));
    case "input":
      return div().w_full().pl(s.indent ?? 0).child(div().h(32).px(8).flex().items_center().rounded(RADIUS.control)
        .border_1().border_color(t.input).bg(t.background)
        .child(s.state ? Input.new(s.state).w_full().text_size(TEXT.body).text_color(t.foreground)
          : div().text_size(TEXT.body).text_color(t.dim).child(s.placeholder ?? "")));
    default:
      return div();
  }
}
