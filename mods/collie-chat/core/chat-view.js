// The coordinator chat's rows as mods/collie-chat draws them: their words, a message's time, a launch brief's label,
// whose words they are. Ported from shepherdr's core/chat-view.js, keeping only what the coordinator chat shows (no
// task news, artifacts, images, subagents or reactions: #7 Slice 1). Plain JS: no herdr, node or DOM.

// Every fixed word the chat shows, once.
export const WORDS = {
  emptyTitle: "What should the Coordinator do?",
  emptyBody: "It turns what you ask for into tickets and keeps you posted.",
  readOnly: "This agent's conversation.",
  ended: "This agent has ended.",
  // typed while it works: in its CLI's queue, taken at its next step (Claude Code's own queue)
  inQueue: "Queued · it reads it at its next step",
  working: "Working",
  stopped: "Stopping…",
  sessionGone: "Earlier session was gone, starting a new one…",
};

// ---- a session that is gone ------------------------------------------------------------------
// Claude Code: "No conversation found with session ID: …". Codex: "ERROR: No saved session found with ID …".
export const LOST = /\bno (?:saved )?(?:conversation|session|rollout)\b.*\bfound\b|\b(?:conversation|session)\b.*\bnot found\b/i;
// What a new agent hears when its earlier session is gone; the chat shows it as one quiet row.
export const FRESH = "Your earlier session is gone, so this is a new one that remembers none of it. Check what is already here and preserve existing work.";
// The new agent's first message: the handover, and a Coordinator's role again (its template's words, after the front
// matter).
export function lostMessage({ template = null } = {}) {
  let msg = `<restart>${FRESH}</restart>`;
  const body = String(template ?? "").split(/^---[ \t]*$/m).slice(2).join("---").trim();
  if (body) msg = `${msg}\n\n${body}`;
  return msg;
}
// A word for a shell line, quoted when it needs it.
export const shellWord = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'"'"'`)}'`);
export const sessionStarted = "Earlier session was gone, started a new one.";
export const sessionFailed = (why) => `Earlier session was gone, and a new one didn't start: ${why}`;

// A message that didn't go: why, and that a press sends it again.
export const notSent = (why) => `Not sent: ${String(why ?? "").replace(/\.$/, "")}. Click to try again.`;
// m:ss, for the working line.
export const elapsed = (secs) => `${Math.floor(Math.max(0, secs) / 60)}:${String(Math.floor(Math.max(0, secs)) % 60).padStart(2, "0")}`;

// ---- times -----------------------------------------------------------------------------------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// The calendar day a time falls on, to tell where a new one starts.
export const dayOf = (at) => dayStart(new Date(at));

// A day's line between messages: Today, Yesterday, a weekday this week, else its date (and year, if not this one).
export function dayLabel(at, now = new Date()) {
  const d = new Date(at);
  const days = Math.round((dayStart(now) - dayStart(d)) / 864e5);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return DAYS[d.getDay()];
  return `${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ""}`;
}
// A message's time under it: 14:05 today, else 3 Nov 14:05.
export function clock(at, now = new Date()) {
  if (!at) return "";
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
}

// ---- whose words -----------------------------------------------------------------------------
// A message another agent sent with hc often names its sender in its first words ("From HERD-76 (t12u?): …", "From
// the person's Coordinator on m3 (t10v): …"). The
// quiet row already says who, so its preview starts after them; the name stands in when the sender's address is
// unknown.
const SIGNED = /^\s*(?:\*\*)?(?:[Mm]essage\s+)?[Ff]rom\s+(?:the person's\s+|your\s+)?([A-Z][\w.-]*(?:\s+[\w.-]+){0,2}?)\s*(?:\([^)\n]{0,40}\))?\s*:(?:\*\*)?\s*/;
export const signedBy = (text) => SIGNED.exec(String(text ?? ""))?.[1]?.trim() || null;
export const unsigned = (text) => String(text ?? "").replace(SIGNED, "");

// A sender outside any terminal: from="<machine>/ppid:123" (a script, a service, or a window that named its process).
export const outsideTerminal = (from) => /(^|\/)ppid:\d+$/.test(String(from ?? "").trim().split(/\s+/)[0]);

// The person's own words that came wrapped as a message from outside any terminal: each one the person sent from this
// chat moments before with the same words (matches(u, p): the chat's own test that the log's message u is its pending
// send p). A message from a terminal (an agent) never counts, nor one nobody here just sent. users: the log's user
// messages; -> their ids.
export function ownWords(users, pending, matches) {
  const ids = [];
  for (const p of pending ?? []) {
    const u = (users ?? []).find((u) => !ids.includes(u.id) && matches(u, p));
    if (u?.from && outsideTerminal(u.from)) ids.push(u.id);
  }
  return ids;
}

// A name's initial for its avatar: a task ref's letters ("SHEP-4" → "S"), else its first letter.
export const initialOf = (name) => (String(name ?? "").trim().match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();

// The session's first message: the first user item, not items[0] (lines read out of it, like notes, come before it).
// -1: none.
export const firstUser = (items) => (items ?? []).findIndex((x) => x?.kind === "user");

// The names a Coordinator's first words (what the person asked when its chat started it) are kept under in
// data/chat-first/<name>.txt: the chat writes its slot's (else its origin's). A chat opened again by the agent's
// address (after a reload) finds them by its labels.
export function firstKeys({ slot = null, labels = {}, origin = null, addr = null } = {}) {
  return [...new Set([slot, labels?.["herdr.chat.slot"], labels?.["herdr.chat.origin"], origin, addr].filter(Boolean).map(String))];
}

// What the person typed, as plain words: a "<" or an "&" they wrote is a character, not markup. Code, fenced or
// inline, is left as it is.
export function literal(text) {
  return String(text ?? "").split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, "\\<").replace(/&(?=#?\w+;)/g, "\\&"))).join("");
}

// A user message the person didn't type, in words for its quiet row, else null: the session's first message when the
// Coordinator was started from its template. i: its place in the conversation; start: the first byte read (0: the
// log's start). first: where the session's first message is in the conversation (firstUser()).
export function briefLabel(x, i, { start = null, template = null, first = 0 } = {}) {
  if (x.from) return `Message from ${signedBy(x.text) ?? "another agent"}`;
  if (i !== first || start !== 0) return null;
  if (/^<restart>/.test(x.text ?? "")) return "New session";
  if (template) return "New session";
  return null;
}
