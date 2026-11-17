// The reaction picker's pure parts (#22): how often and how lately the person used each emoji (Slack's frecency), and
// skin tones. Ported from shepherdr's chat mod (mods/chat main.js frequent(), mods/chat-react withTone()); the picker
// itself is mods/collie-chat/reactions.js, its emoji and icons local. Plain JS: no herdr, node or DOM.

// How often and how lately, each of the last ten uses weighed by how long ago it was: the emoji the person reaches for
// first. uses: { emoji: { n, t: [at, …] } } (data/chat-emoji-uses.json).
export function frequent(uses, n = 18, now = Date.now()) {
  const H = 3600000;
  const weight = (age) => [[4 * H, 100], [24 * H, 80], [72 * H, 60], [168 * H, 40], [720 * H, 20], [2160 * H, 10]].find(([upTo]) => age <= upTo)?.[1] ?? 0;
  const score = (u) => (u?.t?.length ? ((u.n ?? 0) * u.t.reduce((s, t) => s + weight(now - t), 0)) / u.t.length : 0);
  return Object.entries(uses ?? {}).map(([e, u]) => [e, score(u)]).filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([e]) => e);
}

// The same list after one more use: its count up, its last ten times kept.
export function used(uses, emoji, at = Date.now()) {
  const u = uses?.[emoji] ?? { n: 0, t: [] };
  return { ...(uses ?? {}), [emoji]: { n: (u.n ?? 0) + 1, t: [at, ...(u.t ?? [])].slice(0, 10) } };
}

// Skin tones: 0 the yellow default, 1-5 after a person's or a hand's emoji.
const TONE = (tone) => String.fromCodePoint(0x1f3fa + tone);
// A tone-capable emoji without its variation selector (so the tone sits right after it).
const bare = (s) => String(s).replace(/(\p{Emoji_Presentation})️/gu, "$1");
export const withTone = (s, tone = 0) => (tone ? bare(s).replace(/(\p{Emoji_Modifier_Base})️?/gu, `$1${TONE(tone)}`) : s);

// The picker's search: ":thumbsup:", "thumbs up", "THUMB_UP" all find it. Best first: the name itself, a name that
// starts with it, a word of the name, any word. groups: [[name, icon, list]] with each list entry
// { e, tone, name, words } (emoji-data.js).
export function found(groups, q) {
  const t = String(q ?? "").toLowerCase().replaceAll(":", "").replaceAll("_", " ").trim().replace(/\s+/g, " ");
  if (!t) return [];
  const terms = t.split(" ");
  const tiers = [[], [], [], []];
  for (const g of groups) for (const x of g.list) {
    if (!terms.every((w) => x.words.includes(w))) continue;
    const name = x.name.toLowerCase();
    tiers[name === t ? 0 : name.startsWith(t) ? 1 : terms.every((w) => ` ${name}`.includes(` ${w}`)) ? 2 : 3].push(x);
  }
  return tiers.flat();
}
