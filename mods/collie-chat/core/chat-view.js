// The coordinator chat's rows as mods/collie-chat draws them: their words, a message's time, a launch brief's label,
// whose words they are, and a task's news line. Ported from shepherdr's core/chat-view.js, keeping only what the
// coordinator chat shows (task news: Slice 2; artifacts, subagents and the rows over the box: #22). Plain JS:
// no herdr, node or DOM.

// Task news Herdr sends an Assistant (herdr-task's news): each <herdr-news task="…" event="…"> line is its own slim
// row in the coordinator chat. The log turns them into items ({ kind: "news", ref, event, text }); this is their
// words: the task's ref, what happened, then the news' own words (never the title in brackets twice).
const EVENT_MARK = { started: "started", "working-again": "started", "needs-you": "needs", failed: "needs", ready: "ready", done: "done" };
const one = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
export function newsWords(e, x = null) {
  const mark = EVENT_MARK[e.event] ?? "other";
  const title = x?.title ?? "";
  if (e.made) return { mark, what: e.event, text: e.event === "ready" ? one(x?.summary) || title : title };
  let s = one(e.text);
  if (s.startsWith(`${e.ref} `)) s = s.slice(e.ref.length + 1);
  // Every line but ready's ends with the title in brackets.
  let named = title;
  if (e.event !== "ready") {
    const m = title && s.endsWith(` (${one(title)})`) ? [null, one(title)] : / \(([^()]*)\)$/.exec(s);
    if (m) { named = m[1]; s = s.slice(0, s.length - m[1].length - 3); }
  }
  const i = s.indexOf(": ");
  const what = (i < 0 ? s : s.slice(0, i)).replace(/^is /, "") || e.event;
  let text = i < 0 ? "" : s.slice(i + 2);
  if (e.event === "ready") {
    text = text.replace(/ · For AGENTS\.md: .*$/, "");
    if (title && text.startsWith(one(title))) text = text.slice(one(title).length).replace(/^ · /, "") || one(title);
  }
  if (e.event === "done") text = named;
  return { mark, what, text };
}
// The one line the chat shows for it: "HAT-4 needs you · waiting on your answer".
export function newsLine(e, x = null) {
  const n = newsWords(e, x);
  return `${e.ref} ${n.what}${n.text ? ` · ${n.text}` : ""}`;
}

// Every fixed word the chat shows, once.
export const WORDS = {
  emptyTitle: "What should the Assistant do?",
  emptyBody: "It plans the work, starts a task for each part and keeps you posted.",
  readOnly: "This agent's conversation.",
  ended: "This agent has ended.",
  // typed while it works: in its CLI's queue, taken at its next step (Claude Code's own queue)
  inQueue: "Queued · it reads it at its next step",
  working: "Working",
  stopped: "Stopping…",
  sessionGone: "Earlier session was gone, starting a new one…",
  // a published artifact's card and its earlier publishes (#22)
  publishing: "Publishing…",
  open: "Open",
  // the background jobs' rows over the box (#22)
  needsYou: "Needs you",
  subDone: "Done",
  subOpen: "Open its chat",
  stopping: "Stopping…",
  loading: "Loading…",
  noOutput: "(no output)",
  stop: "Stop",
  // find in the loaded rows (#23)
  find: "Find in the chat…",
  noMatches: "No matches",
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

// ---- artifacts (#22) ---------------------------------------------------------------------------
// The artifact a chat's publish made: herdr's records say which version, published by which terminal and when.
// Modelled on shepherdr's core/chat-view.js resolveArtifacts(), reading Collie's own store instead.
// An earlier publish of an artifact: its quiet line. The latest one is the card.
export const published = (title, v) => `Published ${title} v${v}`;
// The card's second line.
export const artifactLine = (v) => `Artifact · v${v}`;

// Which artifact each publish in the conversation made: the first version this agent published from a few seconds
// before the call to five minutes after, not already taken. Map item id -> { id, title, version (its latest), v
// (this publish's), latest }.
export function resolveArtifacts(items, arts, me) {
  const out = new Map();
  const calls = (items ?? []).filter((x) => x.kind === "artifact");
  if (!calls.length || !arts?.length) return out;
  const vs = arts.flatMap((a) => (a.versions ?? []).filter((v) => v.publisher === me).map((v) => ({ a, v }))).sort((p, q) => p.v.at - q.v.at);
  const used = new Set();
  for (const x of calls) {
    const at = x.at ?? 0;
    const hit = vs.find(({ a, v }) => !used.has(`${a.id}:${v.v}`) && v.at >= at - 5000 && v.at <= at + 300000);
    if (!hit) continue;
    used.add(`${hit.a.id}:${hit.v.v}`);
    out.set(x.id, { id: hit.a.id, title: hit.a.title, version: hit.a.version, v: hit.v.v });
  }
  const last = new Map();
  for (const [k, r] of out) last.set(r.id, k);
  for (const [k, r] of out) r.latest = last.get(r.id) === k;
  return out;
}

// ---- subagents: an agent's own helper agents, in herdr (#22) ------------------------------------
// What the Coordinator starts with `hc run` for itself: a reviewer, a second opinion. Each is an hc child of its
// terminal, labelled herdr.role reviewer or helper. Shown over its parent's chat as a subagent row: its role and CLI,
// working / needs / done, how long, opening to its own chat. One that ended stays a while.
export const HELPER_ROLES = ["reviewer", "helper"];
export const subagentWord = (status) => (status === "working" ? WORDS.working : status === "needs" ? WORDS.needsYou : WORDS.subDone);
export const SUBAGENT_KEEP_MS = 60 * 60000;

// ---- the rows over the box, grouped ------------------------------------------------------------
// Several subagents or background shells stacked over the box eat a cramped phone's screen: each kind takes at most
// one row. One of a kind shows as its own row; two or more as one group row ("3 background processes"), its newest's
// title, how long that one has run and their shared state, opening in place to the list of them.
const SUB_KINDS = ["agent", "headless", "child"];
// shared by a group of subagents: one asking makes it ask, else one at work makes it work, else all are done
const sharedStatus = (items) =>
  items.some((j) => j.status === "needs") ? "needs" : items.some((j) => !j.status || j.status === "working") ? "working" : "done";
export function bgGroups(items) {
  const sub = (items ?? []).filter((j) => SUB_KINDS.includes(j.kind));
  const proc = (items ?? []).filter((j) => !SUB_KINDS.includes(j.kind));
  const group = (kind, list) => {
    const newest = list.reduce((a, b) => ((b.at ?? 0) > (a.at ?? 0) ? b : a));
    const n = list.length;
    const words = n < 2 ? null : kind === "sub" ? `${n} subagents` : `${n} background processes`;
    return { kind, items: list, newest, status: kind === "sub" ? sharedStatus(list) : "working", words };
  };
  return [...(sub.length ? [group("sub", sub)] : []), ...(proc.length ? [group("proc", proc)] : [])];
}
const roleOf = (k) => k?.labels?.["herdr.role"] ?? null;
export const isHelper = (k) => HELPER_ROLES.includes(roleOf(k)) && !!k?.parent;

// k's parent, as an address comparable with `addr`: another machine's terminal names its parent on that machine ("t5"
// for "vm/t5").
function parentAddr(k) {
  const p = String(k?.parent ?? "");
  if (!p) return null;
  const m = String(k.address ?? "").includes("/") ? String(k.address).split("/")[0] : null;
  return m && !p.includes("/") ? `${m}/${p}` : p;
}

const AGENTS = { codex: "Codex", claude: "Claude Code", "claude-code": "Claude Code", pi: "Pi" };
// its CLI: its herdr.agent label, else what hc says runs in it, else its command's name
export function subagentCli(k) {
  const a = k?.labels?.["herdr.agent"] ?? k?.agent ?? null;
  if (a) return String(a).replace(/^claude-code$/, "claude");
  const argv = k?.foreground?.argv ?? k?.argv ?? [];
  const prog = argv.map((x) => String(x).split("/").pop()).find((x) => /^(claude|codex|pi)$/.test(x));
  return prog ?? null;
}

// "Reviewer · Codex"
export function subagentTitle(s) {
  const role = s.role === "reviewer" ? "Reviewer" : s.role && s.role !== "helper" ? s.role[0].toUpperCase() + s.role.slice(1) : "Helper";
  return [role, AGENTS[s.cli] ?? (s.cli ? s.cli[0].toUpperCase() + s.cli.slice(1) : null)].filter(Boolean).join(" · ");
}

// how it is: "working", "needs" (it asks in its terminal) or "done" (its turn over, or it ended)
export function subagentStatus(k) {
  if (k?.state && k.state !== "live") return "done";
  const st = typeof k?.status === "object" ? k.status?.state : k?.status;
  return st === "working" ? "working" : st === "blocked" ? "needs" : "done";
}

// The subagents of the terminal at `addr`, oldest first: [{ address, role, cli, title, status, at, ended?, name }].
// terms: every terminal hc knows (live and finished).
export function subagentsOf(terms, addr, now = Date.now()) {
  if (!addr) return [];
  const out = [];
  for (const k of terms) {
    if (!k || !isHelper(k) || parentAddr(k) !== addr) continue;
    const ended = k.state && k.state !== "live";
    if (ended && now - (k.finished_ms ?? 0) > SUBAGENT_KEEP_MS) continue;
    const s = { address: k.address, role: roleOf(k), cli: subagentCli(k), status: subagentStatus(k), at: k.created_ms ?? now, name: k.name ?? null, ...(ended ? { ended: k.finished_ms ?? now } : {}) };
    out.push({ ...s, title: subagentTitle(s) });
  }
  return out.sort((a, b) => a.at - b.at);
}

// "5s", "3m", "2h": how long ago (or long) a row's thing has been going.
export function ago(at, now = Date.now()) {
  if (!at) return "";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}
