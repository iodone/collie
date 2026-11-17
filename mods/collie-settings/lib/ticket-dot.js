// A ticket's status mark: shepherdr's task dots (mods/tasks/dot.js, its own copies in
// mods/tasks/pie/), every one in a 14px box so nothing moves when a status changes.
//   needs    a 10px red dot (halo: a faint ring around it, as the Work header)
//   todo     the grey ring
//   working  the ring in amber, a pie inside filling with the % done (5% steps, min 5%;
//            half full while it reports none)
//   ready    green, a white tick (an accept Card)
//   settled  the same in grey
import { div, svg } from "gpui-kit";
import { terminals, theme } from "herdr";
import { amber, green, red } from "./ui.js";

const box = () => div().relative().size(14).flex_none();
const ring = (color, file = "circle") => svg(`mods/tasks/${file}.svg`).size(14).flex_none().text_color(color);

// The pie: the ring with a solid wedge inside, from twelve o'clock clockwise (one picture per 5%).
const pie = (pct) => `mods/tasks/pie/${Math.min(100, Math.max(5, Math.round(pct / 5) * 5))}.svg`;

// s: needs, todo, working, ready, settled. pct: the % done (working).
export function taskDot(s, { pct = null, halo = false } = {}) {
  const t = theme();
  switch (s) {
    case "working": return svg(pie(Number.isFinite(pct) ? pct : 50)).size(14).flex_none().text_color(amber());
    case "todo": return ring(t.dim);
    case "needs": return box().items_center().justify_center().flex()
      .child(div().size(10).flex_none().rounded(5).bg(red()))
      .when(halo, (el) => el.child(div().absolute().top(-1).left(-1).size(16).rounded(8).border(1.5).border_color(red() + "4d")));
    case "ready":
    case "settled": return box().rounded(7).bg(s === "ready" ? green() : t.dim)
      .child(svg("mods/tasks/tick.svg").size(14).flex_none().text_color("#ffffff"));
  }
  return ring(t.dim);
}

// The % done an agent reports itself (OSC 7501 progress: its terminal's `report`), the first of
// these terminals that does, else null; with its message.
export function ownProgress(addresses) {
  for (const address of addresses) {
    const report = terminals().find((k) => k.address === address)?.report;
    if (typeof report?.progress === "number" && report.progress >= 0) return { pct: report.progress, msg: report.msg || null };
  }
  return null;
}
