// Find in the chat (Ctrl+F / Cmd+F): which of the loaded rows hold what was typed, the match the bar is on, and the
// words it bolds. Ported from shepherdr's mods/chat/main.js (findMatches / findRow / findStep / findMark), keeping
// only what the coordinator chat draws: a row is searched by the words it shows, never a day label, a card's strips or
// an artifact's pending card (they carry no words of their own). Plain JS: no herdr, node or DOM.

// Every match in the loaded rows: [{ index (row), id, n (its matches) }], case-blind, in row order.
export function matches(rows, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [];
  const out = [];
  (rows ?? []).forEach((r, index) => {
    const text = String(r?.text ?? "");
    if (!text || r?.kind === "day" || r?.kind === "card") return;
    const low = text.toLowerCase();
    let n = 0, at = 0;
    while ((at = low.indexOf(q, at)) >= 0) { n++; at += q.length; }
    if (n) out.push({ index, id: r.id, n });
  });
  return out;
}

// How many words matched, over every row.
export const totalOf = (found) => (found ?? []).reduce((n, m) => n + m.n, 0);

// The match the bar is on (counted over all words, not rows): its row. The last match once past the end.
export function rowAt(found, idx) {
  let k = Math.max(0, Number(idx) || 0);
  for (const m of found ?? []) { if (k < m.n) return m; k -= m.n; }
  return found?.[found.length - 1] ?? null;
}

// The next match's place, wrapping both ways: down from the last goes to the first.
export const step = (idx, total, d) => (total ? (Math.max(0, idx) + d + total) % total : 0);

// "3 of 12", or how many there are to look at first.
export const countWord = (idx, total) => `${Math.min(Math.max(0, idx), total - 1) + 1} of ${total}`;

// A row's words with each match in bold (its markdown rows: a message's own words). Code, fenced or inline, is left
// alone. A query that holds markdown's own marks would break the words it bolds, so it is left unmarked.
const MARKDOWN = /[*_`\[\]\\]/;
export function mark(text, query) {
  const q = String(query ?? "").trim();
  if (!q || MARKDOWN.test(q)) return text;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return String(text).split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(re, (m) => `**${m}**`))).join("");
}
