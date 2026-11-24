// What needs the person, from every space and machine: Collie Inbox's "Needs you"
// (mods/collie-inbox). Items are derived each time and never stored:
//   ask      a Claude agent asks through the chat's PermissionRequest hook
//   blocked  a live agent is waiting for the person
//   provider a coordinator's model provider kept cutting it off
// Ready Tasks stay in shared "inbox.tasks" for the green counts. Blocked agents come
// from live terminal state; Task todo, running, and done states produce no tab alert.
//
// Each item says why in at most 40 characters. The engine shares "inbox.asks" and
// "inbox.tasks"; live agents are read where the items are made.
//
// The hook asks the chat every time, whoever reads it. Claude shows its own prompt in
// its terminal meanwhile; Codex waits on the hook and is released when its terminal
// comes on screen.
//
// This engine lives in the always-loaded tab bar; the Inbox UI is mods/collie-inbox.
// Pure helpers are shared through core/needs.js and core/spaces.js.

import { REASONS, reqReason, reportReason } from "./core/needs.js";
import { notifies } from "./notify.js";
import { toast, toastWho as whoOf } from "./lib/ui.js";
import { exec, appHome, home, focused, shared, setShared, watchFolder, readTextFile, writeTextFile, playSound, settings, run, layout } from "herdr";
import { terminals, panes, spaces } from "./live.js";
import { chatPane } from "./core/spaces.js";

const CLI = () => (globalThis.process?.env?.COLLIE_TASK_CLI) ?? `${appHome()}/bin/collie-task`;
const taskStore = () => (globalThis.process?.env?.COLLIE_TASK_STORE) ?? `${home()}/.local/share/collie/tasks`;
export const ASKS = () => `${appHome()}/data/chat-asks`;
const pre = (machine, id) => (machine && id && !String(id).includes("/") ? `${machine}/${id}` : id ?? null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const put = (key, value) => { if (!same(shared(key), value)) setShared(key, value); };

// Claude Code here, live: the agents whose asks the hook can bring.
const claudeHere = (k) => k.state === "live" && !String(k.address).includes("/")
  && (k.program?.key === "claude" || k.agent === "claude-code" || k.report?.app === "claude-code");

// The chat pane showing a terminal, if one is open.
export function chatOf(address) {
  const c = chatPane(terminals().find((k) => k.address === address));
  return c && panes().some((p) => p.pane === c && p.mod === "collie-chat") ? c : null;
}

// On screen as a terminal: its pane is in the shown tab, with no chat showing it.
function onScreen(address) {
  const tab = focused()?.tab;
  return Boolean(tab) && panes().some((p) => p.terminal === address && p.tab === tab) && !chatOf(address);
}

// ---- the engine (the tab bar runs it) --------------------------------------------------------

let started = false;
const alerted = new Set(), seenAt = new Map();

export function startInbox(cx) {
  if (started) return;
  started = true;
  cx.spawn(async (cx) => {
    await exec("sh", ["-c", 'mkdir -p "$1/open" "$1/req" "$1/ans"', "x", ASKS()]).catch(() => {});
    let watch = null;
    for (;;) {
      await flags().catch(() => {});
      await readAsks().catch(() => {});
      watch ??= watchFolder(`${ASKS()}/req`).catch(() => null).finally(() => { watch = null; });
      await Promise.race([watch, cx.sleep(4000)]);
    }
  });
  cx.spawn(async () => { await readTasks().catch(() => {}); });
  // Agents' alerts (collie-task alert): labels, so no program to run; a look each second.
  cx.timer.every(1000, () => agentAlerts());
  cx.timer.every(20000, (cx) => cx.spawn(async () => { await readTasks().catch(() => {}); }));
  // A thread asked for (shared "collie-chat.threadreq") that no coordinator chat took within 1.5 s
  // (none open in that space, or it shows its terminal): go to the worker itself instead.
  let fellBack = null;
  cx.timer.every(500, () => {
    const q = shared("collie-chat.threadreq");
    if (!q?.terminal || q.at === fellBack || shared("collie-chat.threadack") === q.at) return;
    const age = Date.now() - q.at;
    if (age < 1500 || age > 6000) return;
    fellBack = q.at;
    toAgent(q.terminal);
  });
}

// Touches the hook's flag for every Claude agent here that isn't on screen as a terminal.
async function flags() {
  const off = terminals().filter(claudeHere).map((k) => k.address).filter((a) => /^[\w.-]+$/.test(a) && !onScreen(a));
  if (off.length) await exec("sh", ["-c", 'cd "$1/open" && shift && touch -- "$@"', "x", ASKS(), ...off]);
}

// The waiting requests (<terminal>.<time>.<hook pid>.json): one whose hook is gone is dropped.
async function readAsks() {
  const r = await exec("sh", ["-c", 'cd "$1/req" 2>/dev/null || exit 0; for f in *.json; do [ -f "$f" ] || continue; p=${f%.json}; p=${p##*.}; if kill -0 "$p" 2>/dev/null; then echo "$f"; else rm -f "$f"; fi; done; true', "x", ASKS()]);
  const ids = r.stdout.split("\n").filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  const asks = ids.map((id) => ({ id, terminal: id.split(".")[0] }));
  // Codex's (it waits on the hook) that came on screen as a terminal goes back to it; Claude's
  // terminal shows its prompt anyway, and releasing it would close its card on the web too.
  const shown = asks.filter((a) => onScreen(a.terminal));
  if (shown.length) {
    const r = await exec("sh", ["-c", 'cd "$1/req" && shift && for i; do grep -q \'"turn_id"\' "$i.json" 2>/dev/null && echo "$i"; done; true', "x", ASKS(), ...shown.map((a) => a.id)]).catch(() => null);
    for (const id of (r?.stdout ?? "").split("\n").filter(Boolean)) await release(id);
  }
  const left = asks.filter((a) => !onScreen(a.terminal));
  // A few seconds in, an ask Herdr shows no agent waiting for gets its own alert.
  const now = Date.now();
  for (const a of left) {
    if (!seenAt.has(a.id)) seenAt.set(a.id, now);
    else if (now - seenAt.get(a.id) >= 3000 && !alerted.has(a.id)) { alerted.add(a.id); alert(a).catch(() => {}); }
  }
  for (const id of seenAt.keys()) if (!left.some((a) => a.id === id)) { seenAt.delete(id); alerted.delete(id); }
  put("inbox.asks", left);
}

// No decision: Claude asks in its terminal.
const release = (id) => writeTextFile(`${ASKS()}/ans/${id}.json`, "", null).catch(() => {});

// A new ask nobody's chat shows: the sound and toast an agent needing you gets, unless Herdr
// already gave them (the agent shows as blocked). An open chat alerts by itself. It says why, as
// the Tasks row does.
async function alert(a) {
  if (chatOf(a.terminal) || terminals().find((k) => k.address === a.terminal)?.status === "blocked") return;
  // An Assistant whose space's Notify is Off stays quiet.
  if (!notifies(terminals().find((k) => k.address === a.terminal), "need")) return;
  let req = null;
  try { req = JSON.parse(await readTextFile(`${ASKS()}/req/${a.id}.json`) ?? ""); } catch {}
  if (settings()?.sounds?.enabled !== false) playSound("blocked");
  const k = terminals().find((x) => x.address === a.terminal);
  toast({ title: `${whoOf(k)} · Needs you`, body: req ? reqReason(req) : REASONS.question, level: "alert",
    action: { name: "collie", args: {} } });
}

// ---- agents' alerts --------------------------------------------------------------------------

// `collie-task alert "<title>" --body "<why>"` (as Shepherdr's `collie alert`): the agent's own
// terminal gets the core label herdr.alert = { id, at, title, body, task?, about? }, which every
// Herdr client sees at once. Each new one: the blocked sound and a toast, a click on it goes to
// the agent (its chat, or its terminal when it has no pane). A task's agent, or an alert about a task
// (--task), always reaches the person; an Assistant's follows its space's Notify (notify.js).
// After a restart, only those from the last 15 seconds still show.
const ALERT = "herdr.alert";
const shownAlert = new Map(); // terminal -> the id of its alert last seen
let alertsFrom = 0;
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

function agentAlerts() {
  alertsFrom ||= Date.now() - 15000;
  for (const k of terminals()) {
    const raw = k.labels?.[ALERT];
    if (!raw) continue;
    let a = null;
    try { a = JSON.parse(raw); } catch {}
    if (!a?.id || shownAlert.get(k.address) === a.id) continue;
    shownAlert.set(k.address, a.id);
    if (!(Number(a.at) >= alertsFrom) || !(a.about || notifies(k, "need"))) continue;
    if (settings()?.sounds?.enabled !== false) playSound("blocked");
    toast({ title: clip(`${whoOf(k, a.task)} · ${String(a.title ?? "")}`, 60), body: clip(String(a.body ?? ""), 300), level: "alert",
      action: { name: `alert-${k.address.replace(/\//g, "~")}` } });
  }
}

// A click on an alert's toast (the tab bar's "alert-<terminal>" command; a mod command carries
// no args): go to the agent's chat, or peek at its terminal when it has no pane.
export function toAlert(args) {
  const terminal = args?.terminal;
  if (!terminal) return;
  toAgent(terminal);
}

// ---- reasons ------------------------------------------------------------------------------

// The reasons and their line (core/needs.js, shared with the web app), here as before.
export { LINE_MAX, REASONS, fit, reqReason, reportReason } from "./core/needs.js";

// Why an item needs the person, in at most LINE_MAX characters. req: an ask's request, when read.
export function reasonOf(item, req = null) {
  if (item.why) return item.why;
  if (item.kind === "ask") return req ? reqReason(req) : REASONS.question;
  if (item.kind === "blocked") {
    const report = terminals().find((k) => k.address === item.terminal)?.report;
    const kind = report?.kind;
    return kind === "auth" ? REASONS.signedOut : kind === "permission" ? reportReason(report?.msg) ?? REASONS.permission : REASONS.question;
  }
  return null;
}

// Tasks here and on each machine that has them. One read at a time: a slow
// machine mustn't stack reads every 20 s.
let reading = null;
function readTasks() {
  return reading ??= readTasksNow().finally(() => { reading = null; });
}

async function readTasksNow() {
  const r = await exec("sh", ["-c", 'ls "$1/.remote" 2>/dev/null; true', "x", taskStore()]).catch(() => null);
  const where = [null, ...(r?.stdout ?? "").split("\n").filter(Boolean)];
  const tasks = [];
  for (const machine of where) {
    const on = machine ? ["--on", machine] : [];
    const list = await json(CLI(), [...on, "list", "--all", "--json"]);
    for (const g of Array.isArray(list) ? list : []) for (const x of g.tasks ?? []) {
      // Ready alone contributes a green count. Blocked agents come from live terminals;
      // todo, running, and done Tasks are not independent tab alerts.
      if (x.state !== "ready") continue;
      const last = x.agents?.at(-1);
      tasks.push({ kind: x.state, machine, folder: g.folder, name: g.name, ref: x.ref ?? `#${x.id}`,
        title: x.title, space: pre(machine, x.space), tab: pre(machine, x.tab),
        live: (x.live ?? []).map((a) => pre(machine, a.address)),
        at: x.ready_at ?? last?.ended ?? last?.at ?? x.started_at ?? x.created_at ?? 0 });
    }
  }
  put("inbox.tasks", tasks);
  await readRetries();
}

// Assistants (coordinators) here that their provider kept cutting off (collie-task tick's
// .retries.json): an item each, and once a toast.
const told = new Set();
async function readRetries() {
  let rows = {};
  try { rows = JSON.parse(await readTextFile(`${taskStore()}/.retries.json`) ?? "{}") ?? {}; } catch {}
  const over = Object.values(rows).filter((r) => r?.role === "coordinator" && r.over && r.reason && !r.stale
    && terminals().some((k) => k.address === r.address && k.state === "live"))
    .map((r) => ({ terminal: r.address, why: r.reason, cut: r.cut, at: r.at ?? 0 }));
  for (const r of over) if (!told.has(`${r.terminal}:${r.cut}`)) {
    told.add(`${r.terminal}:${r.cut}`);
    if (settings()?.sounds?.enabled !== false) playSound("blocked");
    toast({ title: `${whoOf(terminals().find((k) => k.address === r.terminal))} · ${r.why}`, body: "Write to it to carry on, or restart it.", level: "alert",
      action: { name: "collie", args: {} } });
  }
  put("inbox.provider", over);
}

// Output the same as last time isn't parsed again (one entry per machine).
const parsed = new Map();
async function json(cmd, args) {
  const r = await exec(cmd, args).catch(() => null);
  if (!r || r.code !== 0) return null;
  const key = [cmd, ...args].join("\0"), last = parsed.get(key);
  if (last?.out === r.stdout) return last.value;
  let value = null;
  try { value = JSON.parse(r.stdout); } catch {}
  parsed.set(key, { out: r.stdout, value });
  return value;
}

// ---- the items ----------------------------------------------------------------------------

// Every item now: asks and blocked live agents, then provider failures. Ready Tasks
// contribute only to ready(), never to the red count.
export function items() {
  const asks = shared("inbox.asks") ?? [];
  const asking = new Set(asks.map((a) => a.terminal));
  const out = asks.map((a) => ({ key: `ask:${a.id}`, kind: "ask", id: a.id, terminal: a.terminal, at: Number(a.id.split(".")[1]) * 1000 || 0 }));
  const all = terminals();
  forgetUnblocked(all);
  for (const k of all)
    if (k.state === "live" && k.status === "blocked" && !asking.has(k.address))
      out.push({ key: `blocked:${k.address}`, kind: "blocked", terminal: k.address, at: blockedSince(k.address) });
  for (const p of shared("inbox.provider") ?? []) if (!asking.has(p.terminal)) out.push({ key: `provider:${p.terminal}`, kind: "provider", ...p });
  return out;
}

export const count = () => items().length;

// The tab an item is in, for the red counts on tabs and spaces: its agent's (where its chat
// shows it, else its pane), or its task's. Task agents have no tab (collie-task runs them with no
// pane, as hc children of the space's coordinator): theirs is their parent's, else their space's
// coordinator's (labels herdr.task.space, or a task's space).
export function tabOf(item, depth = 0) {
  const up = (address) => (address && depth < 3 ? tabOf({ terminal: address }, depth + 1) : null);
  if (!item.terminal) return item.tab ?? up(coordinatorOf(item.space)?.address);
  const pane = chatOf(item.terminal) ?? panes().find((p) => p.terminal === item.terminal)?.pane;
  const k = terminals().find((x) => x.address === item.terminal);
  const m = String(item.terminal).includes("/") ? item.terminal.split("/")[0] : null;
  const space = k?.labels?.["herdr.task.space"];
  return (pane && panes().find((p) => p.pane === pane)?.tab) || k?.labels?.["herdr.tab"]
    || up(k?.parent) || up(space && coordinatorOf(m ? `${m}/${space}` : space)?.address) || null;
}

// A space's live coordinator ("vm/sp3": on that machine), or null.
function coordinatorOf(space) {
  if (!space) return null;
  const s = String(space), m = s.includes("/") ? s.split("/")[0] : null, id = m ? s.slice(m.length + 1) : s;
  return terminals().find((k) => k.state === "live" && (k.labels?.["herdr.role"] === "coordinator" || k.template === "assistant" || k.template === "coordinator")
    && (k.address.includes("/") ? k.address.split("/")[0] : null) === m
    && [k.labels?.["herdr.space"], k.labels?.["herdr.coordinator.space"]].includes(id)) ?? null;
}

// tab id -> how many items are in it.
export function countsByTab() {
  const m = new Map();
  for (const it of items()) { const tab = tabOf(it); if (tab) m.set(tab, (m.get(tab) ?? 0) + 1); }
  return m;
}

// The tasks in the Inbox's Ready, for the green counts (beside the red ones), and per tab.
// A blocked live agent is a red item instead, never a simultaneous green count.
export function ready() {
  const blocked = new Set(terminals().filter((k) => k.status === "blocked").map((k) => k.address));
  return (shared("inbox.tasks") ?? []).filter((x) => x.kind === "ready" && !x.live?.some((a) => blocked.has(a)));
}
export const readyCount = () => ready().length;
export function readyByTab() {
  const m = new Map();
  for (const it of ready()) { const tab = tabOf(it); if (tab) m.set(tab, (m.get(tab) ?? 0) + 1); }
  return m;
}

// When an agent started waiting: the first time this window saw it so (its tab's last change
// when that is later is no better, so the first sight it is).
const since = new Map();
function blockedSince(address) {
  if (!since.has(address)) since.set(address, Date.now());
  return since.get(address);
}

// Those no longer waiting start over. One pass over one list: a terminals() per waiting agent,
// per waiting agent, took the status bar past Herdr's render time (SHEP-15).
function forgetUnblocked(all) {
  const blocked = new Set(all.filter((k) => k.status === "blocked").map((k) => k.address));
  for (const a of since.keys()) if (!blocked.has(a)) since.delete(a);
}

// ---- going there --------------------------------------------------------------------------

// Shows what needs the person: Collie's Inbox, on its list.
export function showInbox() {
  run("layout.select", { stack: "panel-body", child: "collie" });
  run("layout.select", { stack: "collie", child: "collie-list" });
  run("layout.show", { id: "panel" });
}

// To an agent: its chat if one shows it, else its pane, else Herdr finds it.
export function toAgent(address) {
  const chat = chatOf(address);
  if (chat) { selectTabOf(chat); run("pane.focus", { pane: chat }); return; }
  const p = panes().find((x) => x.terminal === address);
  if (p) { selectTab(p.tab); run("pane.focus", { pane: p.pane }); return; }
  // No pane (a task worker runs without one): peek at its terminal over the tab.
  peekTerminal(address);
}

// A terminal with no pane (a task worker or reviewer, which has no tab by design): Herdr's
// own peek. Collie's ticket page is not a terminal host, so there is no task-view branch.
export function peekTerminal(terminal) {
  run("terminal.peek", { terminal });
}

function selectTab(tab) {
  const s = spaces().find((x) => x.tabs.some((t) => t.id === tab));
  if (s && !s.active) run("space.select", { id: s.id });
  run("tab.select", { id: tab });
}
const selectTabOf = (pane) => { const p = panes().find((x) => x.pane === pane); if (p) selectTab(p.tab); };

// The agents an item is about, for its name and status.
