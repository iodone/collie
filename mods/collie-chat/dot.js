// A task's status mark: Shepherdr's task dots (src/ui.tsx Dot, src/styles.css .dot.*), every one
// in a 14px box so nothing moves when a status changes.
// Shared: the source is lib/dot.js; bin/sync-shared copies it into each mod in lib/COPIES.
// Edit lib/dot.js, never a mod's copy, then run bin/sync-shared.
//   working  the ring in amber, a pie inside filling with the % done (5% steps,
//            min 5%; half full while it reports none)
//   needs    a 10px red dot (halo: a faint ring around it, as Shepherdr's chat header)
//   ready    green, a white tick        done     the same in grey
//   todo     the grey ring
import { div, svg } from "gpui-kit";
import { theme } from "herdr";
import { terminals } from "./live.js";
import { red, green, amber } from "./ui.js";

// Shepherdr's own red, green and amber, light and dark: one source for the app, in ui.js. The
// greys are the theme's.
const needColor = red;
const readyColor = green;

// The pie: the ring with a solid wedge inside, from twelve o'clock clockwise, radius 3.5 of 14
// (Shepherdr's inset 3.5px), one picture per 5% in mods/collie-inbox/task/pie/. Pictures, not paint_path: its
// arcs drew only the wedge's outline at this size, which read as a clock's hands.
const pie = (pct) => `mods/collie-inbox/task/pie/${Math.min(100, Math.max(5, Math.round(pct / 5) * 5))}.svg`;

const box = () => div().relative().size(14).flex_none();
const ring = (color) => svg("mods/collie-inbox/task/circle.svg").size(14).flex_none().text_color(color);

// s: needs, working, ready, todo, done. pct: the % done (working).
export function taskDot(s, { pct = null, halo = false } = {}) {
  const t = theme();
  switch (s) {
    case "working": return svg(pie(Number.isFinite(pct) ? pct : 50)).size(14).flex_none().text_color(amber());
    case "needs": return box().items_center().justify_center().flex()
      .child(div().size(10).flex_none().rounded(5).bg(needColor()))
      .when(halo, (el) => el.child(div().absolute().top(-1).left(-1).size(16).rounded(8).border(1.5).border_color(needColor() + "4d")));
    case "ready":
    case "done": return box().rounded(7).bg(s === "ready" ? readyColor() : t.dim)
      .child(svg("mods/collie-inbox/task/tick.svg").size(14).flex_none().text_color("#ffffff"));
  }
  return ring(t.dim);
}

// The % done an agent reports itself (OSC 7501 progress: its terminal's `report`), the first of
// these terminals that does, else null; with its message.
export function ownProgress(addresses) {
  for (const a of addresses) {
    const r = terminals().find((k) => k.address === a)?.report;
    if (typeof r?.progress === "number" && r.progress >= 0) return { pct: r.progress, msg: r.msg || null };
  }
  return null;
}
