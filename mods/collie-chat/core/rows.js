// The chat's rows as the list places them: the port of shepherdr's mods/chat/main.js row, band and fold code
// (barLayout, hitBar, spaced, foldOf, guess, shownLines), pure and without GPUI so it can be tested.
//
// One row under each message, its band (a list row of its own), on the message's side (left for the agent, right for
// the person), the reaction pills flush under the bubble's outer edge and the smiley to add one beside them, each side
// the other's mirror: on the person's the time (dim), reply, copy, rewind, the smiley and then the pills (furthest
// right); on the agent's the pills (furthest left), the smiley, fork, copy, reply and then the time. The pills always
// show; the rest only while the pointer is on the message, in room that is always kept, so nothing moves.
// barLayout() places every part; hitPart() reads the same places.
//
// One even rhythm on a 4 px scale (spaced()): under every message its band, always kept: BAND_IN of air under the
// bubble, then the actions' row (ACT tall, pills or not). Then every block (a message with its band, a run of quiet
// lines, a card) is GAP from the next, so the row never touches what follows and the room above a bubble is the room
// after a row.

import { clock } from "./chat-view.js";

export const ACT = 22, ACT_GAP = 2, BAND_IN = 4, ACT_ROW = BAND_IN + ACT, GAP = 16;
// Quiet lines (tools, briefs, a closed ask) sit tight: each is its line with QUIET_PY above and below; QUIET_IN is how
// far their words' ink sits inside the row's top and bottom edges.
export const QUIET_PY = 1, QUIET_IN = { top: 5, bottom: 6 };
// A long reply folds (Show more) when it would run past FOLD_TALL lines (estimated from its words), to its first FOLD
// lines; LINE_H is a reply's line in px.
export const FOLD = 20, FOLD_TALL = 28, LINE_H = 21, CODE_H = 19, CODE_HEAD = 34;
// Reaction pills: this wide and tall (inside the ACT row, so they sit on the icons' center line without towering over
// them), this far apart; and the gap between them and the smiley.
export const PILL = 46, PILL_H = 20, PILL_GAP = 4, PILL_EDGE = 6;
// The band's icons, each a file in mods/collie-chat/.
export const ICONS = { copy: "copy", reply: "reply", rewind: "rewind", fork: "git-fork", react: "smile-plus" };

// About how many lines words take at a width (px), for a row's height before it's measured.
export const wrapLines = (text, width) => String(text ?? "").split("\n").reduce((n, l) => n + Math.max(1, Math.ceil((l.length * 7) / Math.max(120, width))), 0);

// A folded reply's words that show: the lines (as wrapLines counts them at `width`) filling `h` px, and a few more
// under the fade (the estimate can run short); a long paragraph is cut where its last one ends. Only those are laid
// out: a folded reply drawn whole under its clip was far taller than its row, and scrolling up into one blanked the
// list (#590).
export function shownLines(text, h, width) {
  const per = Math.floor(Math.max(120, width) / 7);
  const out = [];
  let room = Math.ceil(h / LINE_H) + 3;
  for (const l of String(text ?? "").split("\n")) {
    if (room <= 0) break;
    const n = wrapLines(l, width);
    out.push(n > room ? l.slice(0, room * per) : l);
    room -= n;
  }
  return out.join("\n");
}

// The column's left and right edges in the pane, for the action buttons under messages.
export function edges(width, column) {
  const outer = Math.min(width, column + 36);
  const left = (width - outer) / 2 + 18;
  return { left, right: left + outer - 36 };
}

// A bubble's widest: four fifths of the column, never narrower than 240 px.
export const most = (width, column) => Math.max(240, Math.floor(Math.min(width, column) * 0.8));

// The actions a message offers, from left to right after the time: the person's words can be replied to and copied;
// a prompt (not a /command, not another agent's message) can be rewound to. The agent's reply is copied, forked
// (when there is a session to fork) and replied to.
export function bandActs(side, text, { from = null, fork = true } = {}) {
  if (side === "user") return ["reply", "copy", ...(/^\//.test(String(text ?? "")) || from ? [] : ["rewind"])];
  return ["reply", "copy", ...(fork ? ["fork"] : [])];
}

// The whole band, in order from left to right (DECISIONS, Chat > Message actions): the reaction pills flush under the
// bubble's outer edge with the smiley beside them, each side the other's mirror. Yours: the time, its actions, the
// smiley, then the pills furthest right; the agent's: the pills furthest left, the smiley, its actions reversed and
// the time at the inner end. `time` false leaves the time out, `react` false the smiley.
export function bandOrder(side, acts, { time = true, react = true } = {}) {
  const lead = [...(time ? ["time"] : []), ...acts];
  const smiley = react ? ["react"] : [];
  return side === "user" ? [...lead, ...smiley, "pills"] : ["pills", ...smiley, ...lead.reverse()];
}

// A message's band, every part in order with its left edge in the pane: { what, x, w, hover (shown only on hover),
// pill? }. The time takes a fixed width, so the places never depend on how its digits draw.
export function barLayout(bar, { width = 600, column = 760, react = true } = {}) {
  const { left, right } = edges(width, column);
  const time = clock(bar.at);
  const acts = bar.acts ?? [];
  const pills = bar.pills ?? [];
  const parts = [];
  let at = 0;
  const add = (what, w, gap, more = {}) => { at += parts.length ? gap : 0; parts.push({ what, x: at, w, ...more }); at += w; };
  // Many pills in a narrow pane: the time goes first, so the row stays inside the column.
  const room = right - left, timeW = time ? (time.length > 5 ? 82 : 38) + ACT_GAP : 0;
  const need = acts.length * (ACT + ACT_GAP) + ACT + pills.length * (PILL + PILL_EDGE);
  const order = bandOrder(bar.side, acts, { time: Boolean(time) && need + timeW <= room, react });
  for (const what of order) {
    if (what === "time") add("time", timeW - ACT_GAP, ACT_GAP, { hover: true, text: time });
    // The pills PILL_GAP apart, PILL_EDGE from what comes before or after them.
    else if (what === "pills") pills.forEach((p, i) => add(`pill:${p.emoji}`, PILL, i ? PILL_GAP : PILL_EDGE, { pill: p }));
    else add(what, ACT, what === "react" && bar.side !== "user" ? PILL_EDGE : ACT_GAP, { hover: true });
  }
  const x0 = bar.side === "user" ? right - at : left;
  for (const p of parts) p.x += x0;
  return { x: x0, w: at, parts };
}

// Which part of a band a press at `x` (in the pane) was on: the time isn't a button. The band is a row of its own, so
// the list names it exactly; across, barLayout()'s places.
export function hitPart(parts, x) {
  if (x === undefined || x === null) return null;
  return (parts ?? []).find((p) => p.what !== "time" && x >= p.x && x <= p.x + p.w) ?? null;
}

// An agent message in parts: markdown, and fenced code blocks (drawn with their own Copy bar).
export function parts(text) {
  const out = [];
  const re = /^```([^\n`]*)\n([\s\S]*?)\n```[ \t]*$/gm;
  let at = 0, m;
  while ((m = re.exec(text))) {
    const before = text.slice(at, m.index).trim();
    if (before) out.push({ type: "md", text: before });
    out.push({ type: "code", lang: m[1].trim(), code: m[2] });
    at = m.index + m[0].length;
  }
  const rest = text.slice(at).trim();
  if (rest) out.push({ type: "md", text: rest });
  return out;
}

// How a long reply folds, or null when it's short (or holds what Find looks for): { open, clips: part -> px its words
// show, last: the last part shown }. Its parts' heights are estimated from their words.
export function foldOf({ text = "", ps, width = 600, column = 760, unfolded = false }) {
  const w = most(width, column) - 24;
  const est = (ps ?? []).map((p) => (p.type === "md" ? wrapLines(p.text, w) * LINE_H : CODE_HEAD + 16 + p.code.split("\n").length * CODE_H));
  if (est.reduce((a, b) => a + b, 0) <= FOLD_TALL * LINE_H) return null;
  if (unfolded) return { open: true, clips: new Map(), last: (ps ?? []).length - 1 };
  const clips = new Map();
  let left = FOLD * LINE_H, last = (ps ?? []).length - 1;
  for (let n = 0; n < (ps ?? []).length; n++) {
    if (est[n] < left && n < ps.length - 1) { left -= est[n]; continue; }
    clips.set(n, Math.max(3 * LINE_H, ps[n].type === "md" ? left : left - CODE_HEAD));
    last = n;
    break;
  }
  return { open: false, clips, last };
}

// The rows sitting tight together: a run of quiet lines is one block, so no gap goes between them.
export const quietRow = (r) => r?.kind === "tools" || r?.kind === "brief" || r?.kind === "news"
  || r?.kind === "askend" || r?.kind === "secretend" || (r?.kind === "artifact" && (r.line || r.pending));

// One even rhythm (DECISIONS, Chat > Spacing). Rows of one block sit as they are; at a block's edges a row drops its
// outer room (top0 / bot0), and between blocks goes one gap row, so every block is GAP from the next: a message with
// its band, a run of quiet lines sitting tight together, a card. A band is always ACT_ROW: BAND_IN of air, then the
// actions' row at its foot, shown or not.
export function spaced(rows) {
  const of = (r) => r.blk ?? (quietRow(r) ? "quiet" : r.id);
  // How far a row's words sit inside its edge once its outer room is gone.
  const inset = (r, edge) => (quietRow(r) ? QUIET_IN[edge] : 0);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = rows[i - 1], next = rows[i + 1];
    const top0 = !prev || of(prev) !== of(r), last = !next || of(next) !== of(r);
    // A message's last row sits flush on its band.
    const bot0 = last || next?.kind === "band";
    if (r.kind === "band") {
      out.push({ ...r, bar: { ...r.bar, box: { top: BAND_IN, h: ACT } }, h: ACT_ROW });
    } else if (top0 || bot0) out.push({ ...r, top0, bot0 });
    else out.push(r);
    if (last && next) {
      const h = Math.max(0, GAP - (r.kind === "band" ? 0 : inset(r, "bottom")) - inset(next, "top"));
      out.push({ kind: "gap", id: `g:${r.id}`, h });
    }
  }
  return out;
}

// A card's strips as one row: how tall the card is before it is measured (strips.js draws each strip's kind).
function cardGuess(strips) {
  return (strips ?? []).reduce((n, s) => {
    const edge = (s.gap ?? 8);
    const h = s.kind === "head" ? 18 : s.kind === "title" || s.kind === "text" ? 18 * Math.max(1, wrapLines(s.text, 520))
      : s.kind === "detail" ? 12 + 18 * Math.min(s.clip ? 12 : Infinity, (s.lines ?? []).length || 1)
      : s.kind === "controls" ? 30 : s.kind === "option" ? 32 + (s.desc ? 16 : 0) : s.kind === "review" ? 31
      : s.kind === "input" ? 32 : 24;
    return n + edge + h;
  }, 16);
}

// A row's height before it is measured: bands and gaps are as tall as spaced() made them.
export function guess(x, { width = 600, column = 760, opened = null } = {}) {
  if (x.kind === "band" || x.kind === "gap") return x.h;
  return guessBare(x, { width, column, opened });
}

export function guessBare(x, { width = 600, column = 760, opened = null } = {}) {
  const w = Math.min(width, column) - 36;
  const open = opened?.has?.(x.id) ?? false;
  switch (x.kind) {
    case "end": return 10;
    case "day": return 20;
    case "note": case "failed": return 36;
    case "brief": return open ? 32 + wrapLines(x.text, w) * 19 : 20;
    case "queued": case "fold": return 26;
    case "user":
      return 30 + wrapLines(x.text, most(width, column) - 24) * 20 + (x.files?.length ? 17 : 0)
        + (x.paths?.length ? 64 : 0) + (x.error ? 17 : 0);
    case "agent": return 30 + (x.clip ?? wrapLines(x.text, most(width, column) - 24) * LINE_H);
    case "codehead": return CODE_HEAD;
    case "code": return 16 + (x.clip ?? String(x.code ?? "").split("\n").length * CODE_H);
    case "tools": return open ? 26 + (x.steps ?? 1) * 19 : 20;
    case "artifact": return x.pending || x.line ? 20 : 62;
    case "card": return cardGuess(x.strips);
    default: return 60;
  }
}

// Every size a real number of pixels: one NaN, zero or runaway height leaves the list blank.
export const sizesOf = (rows, heights, keys, guessOf) => rows.map((x, i) => {
  const h = heights.get(keys[i]) ?? guessOf(x);
  return Number.isFinite(h) && h > 0 ? Math.min(h, 40000) : 60;
});

// What a row's height depends on: measured once per key and width.
export function rowKey(x, { findQuery = "", opened = null } = {}) {
  const q = findQuery;
  const found = q && String(x.text ?? x.code ?? "").toLowerCase().includes(q.toLowerCase()) ? `|f:${q}` : "";
  const open = (x.kind === "tools" || x.kind === "brief") && (opened?.has?.(x.id) ?? false);
  return `${x.id}|${x.kind}|${open ? "o" : ""}|${x.text?.length ?? 0}|${x.code?.length ?? 0}|${x.from ? 1 : 0}${x.failed ? 1 : 0}${x.pending ? 1 : 0}${x.files?.length ?? 0}|${x.paths?.length ?? 0}${found}` +
    `|${(x.pills ?? []).map((p) => p.emoji + (p.you ? 1 : 0) + (p.agent ? 1 : 0)).join("")}|${x.bar ? "b" : ""}` +
    `${x.clip ? `c${x.clip}` : ""}${x.kind === "day" ? x.text : ""}${x.kind === "card" ? `|cs${(x.strips ?? []).length}` : ""}`;
}
