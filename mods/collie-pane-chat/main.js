// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "collie-pane-chat" } } } }
// Shows the program's icon (the app's program table), the agent's name or the terminal's title, the folder, and the
// agent's status; buttons split, zoom and close this pane. Props from the app: { pane, terminal }. Click: focus the pane.
//
// Ported from Shepherdr's pane header mod. Agent panes (Claude Code, Codex) also get a Chat / Terminal switch. Chat puts
// mods/collie-chat in the agent pane's exact spot: it splits beside the agent's pane, then the agent's terminal is
// parked (it keeps running, without a pane), so the chat takes the whole slot and every other pane stays as it was.
// Terminal does the reverse: the terminal gets a pane beside the chat again and the chat closes. Parking turns core
// keep off; the chat turns it back on. Each swap's last step removes the pane this header is on, so it goes last.
// Which chat shows which agent is the agent's core label herdr.chat=<chat pane>: every screen sees it.
//
// Deliberately absent from this port: Autopilot, add-ons, the "End Claude Code?" dialog (its ✕ is a simple close),
// artifact titles and voice (Shepherdr's mods/artifacts and the call stack have no collie counterparts).

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  props, run, theme, home, exec, hc, notify, nextCommand, shared, setShared, readTextFile,
  panes as livePanes, terminals as liveTerminals, spaces as liveSpaces,
} from "herdr";

// The chat mod this header switches to.
const CHAT = "collie-chat";
// Where an agent remembers the chat pane it is parked behind (core/spaces.js CHAT).
const LABEL = "herdr.chat";
const COMPACT_BELOW = 480;
const TEXT = { id: 11, label: 12 };
const RADIUS = { control: 6 };
// When a toggle last swapped a pane (every copy of this build shares it).
let lastSwap = 0;

// ---- Herdr's live lists, one copy per render ---------------------------------------------------
// Ported from Shepherdr's live.js: a render gets about 50 ms, and each terminals()/panes()/spaces() copies the whole
// list again. A copy older than the next render can start is never used. In clicks, timers and tasks: the live list.
const STALE = 250;
let frame = null;
const current = () => (frame && Date.now() - frame.at < STALE ? frame : null);
const once = (name, read) => () => {
  const f = current();
  if (!f) return read();
  if (!(name in f.lists)) f.lists[name] = read();
  return f.lists[name];
};
const panes = once("panes", livePanes);
const terminals = once("terminals", liveTerminals);
const spaces = once("spaces", liveSpaces);

// Runs fn (a render) with one copy of each list; a render inside another uses the outer one's.
function inRender(fn) {
  const outer = current();
  frame = outer ?? { at: Date.now(), lists: {} };
  try { return fn(); } finally { frame = outer; }
}

const toast = (n) => notify({ ...n, level: n.level === "alert" ? "error" : n.level ?? "info" });
const plainError = (e) => String(e?.message ?? e ?? "").trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).size(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// A space's name (mods/collie-tabs/core/spaces.js spaceName): its own name, else its folder's last part.
function spaceName(s, h) {
  if (s?.name && s.name !== "~") return s.name;
  const at = s?.folder ?? null;
  if (!at) return "Home";
  return at === h ? "Home" : String(at).replace(/\/+$/, "").split("/").pop();
}

// Chat reads Claude Code's and Codex's own session logs; other agents have no chat.
const chatty = (p) => Boolean(p?.terminal) && (["claude-code", "codex"].includes(p.app) || ["claude", "codex"].includes(p.program?.key));

const chatPanes = () => new Set(panes().filter((p) => p.mod === CHAT).map((p) => p.pane));
// The chat pane showing a terminal, if one is open.
function chatOf(terminal) {
  const c = terminals().find((x) => x.address === terminal)?.labels?.[LABEL];
  return c && chatPanes().has(c) ? c : null;
}
// A Coordinator tab's chat with no agent yet (mods/collie-tabs records it in shared "coordinator.slots"): it has the
// switch too; Terminal starts its agent first (mods/collie-chat).
const lazySlot = (pane) => Object.values(shared("coordinator.slots") ?? {}).find((r) => r?.pane === pane) ?? null;

// The agent a chat pane shows.
const agentOf = (chat) => terminals().find((x) => x.labels?.[LABEL] === chat && x.state === "live")?.address ?? null;

// The Coordinator tab's three pages are Chat, Terminal and Helper. The service marks the Coordinator and its
// helper with their space, so either page can find the other without a shared tab label.
const spaceOf = (self) => {
  const address = self.mod === CHAT ? agentOf(self.pane) : self.terminal;
  const direct = terminals().find((x) => x.address === address)?.labels?.["herdr.space"] ?? null;
  if (direct) return direct;
  // A Coordinator slot's chat has no agent label yet; its tab says the space.
  const space = spaces().find((s) => s.tabs?.some((t) => t.id === self.tab));
  return space ? String(space.id).split("/").pop() : null;
};
const roleIn = (self, role) => {
  const space = spaceOf(self);
  if (!space) return null;
  const inSpace = (x) => x.labels?.["herdr.space"] === space
    || x.labels?.["herdr.coordinator.space"] === space
    || x.labels?.["herdr.job.space"] === space;
  return terminals().find((x) => x.state === "live" && x.labels?.["herdr.role"] === role && inSpace(x)) ?? null;
};
const coordinatorFor = (self) => roleIn(self, "coordinator");
const helperFor = (self) => roleIn(self, "helper");
const helperVisible = (cfg, space) => {
  const id = String(space ?? "");
  const local = cfg?.spaces?.[id]?.coordinator?.helper ?? cfg?.spaces?.[id]?.helper;
  const everywhere = cfg?.everywhere?.coordinator?.helper ?? cfg?.everywhere?.helper;
  return (local ?? everywhere) === "visible";
};
async function waitPane(pred, cx, ms = 1500) {
  for (const end = Date.now() + ms; Date.now() < end; await cx.sleep(50)) {
    const found = panes().find(pred);
    if (found) return found;
  }
  return null;
}

// One app command, waited for (the swap's steps must go in order).
async function app(name, args) {
  const r = await exec("herdr-app", ["do", name, ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, typeof v === "string" ? v : JSON.stringify(v)])]);
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch {}
  if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr.trim() || `${name} failed`);
  return out;
}

// A parked agent, shown in a chat pane: what the header shows for it.
function parked(terminal) {
  const k = terminals().find((x) => x.address === terminal);
  if (!k) return null;
  const st = ["working", "blocked", "done", "idle"].includes(k.status) ? k.status : null;
  return { program: k.program, status: st, cwd: k.foreground?.cwd ?? k.cwd ?? null, title: k.title ?? "" };
}

// The shared switch (collie's lib/ui.js segmented): values as wide as their words, the picked one raised.
function segmented(id, options, value, onPick) {
  const t = theme();
  return h_flex().h(24).flex_none().p(2).gap(2).rounded(RADIUS.control).bg(t.raised)
    .children(options.map(([v, label], i) => {
      const on = v === value;
      return h_flex().id(`${id}-${i}`).h_full().px(8).justify_center().items_center().rounded(RADIUS.control - 2)
        .whitespace_nowrap().text_size(TEXT.label).flex_none()
        .when(on, (el) => el.bg(t.background).text_color(t.foreground).font_medium())
        .when(!on, (el) => el.text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((e, cx) => { cx.stop_propagation(); onPick(v, e, cx); cx.notify(); }))
        .child(label);
    }));
}

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.busy = false;
    // The Helper page is opt-in: follow Coordinator settings' helper = visible (default hidden).
    this.helperCfg = null;
    this.helperCfgRaw = null;
    const loadHelper = async (cx) => {
      const raw = await readTextFile(`${home()}/.local/state/collie/coordinator.json`).catch(() => null);
      if (raw === this.helperCfgRaw) return;
      this.helperCfgRaw = raw;
      try { this.helperCfg = raw ? JSON.parse(raw) : null; } catch { this.helperCfg = null; }
      cx.notify();
    };
    cx.spawn(async (cx) => { await loadHelper(cx); });
    cx.timer.every(2000, (cx) => cx.spawn(async (cx) => { await loadHelper(cx); }));
    // A copy just started (the swap's new pane) may still be handed the toggle that made it: it would swap
    // straight back. Toggles go to copies at least 2 s old, one swap per 3 s.
    this.born = Date.now();
    // A Helper row in the chat asks this pane to show its Helper page (shared "collie-pane-chat.page").
    cx.timer.every(200, (cx) => {
      const req = shared("collie-pane-chat.page");
      if (!req || Date.now() - (req.at ?? 0) > 3000) return;
      const self = this.me();
      if (!self || (req.pane && self.pane !== req.pane) || (req.tab && self.tab !== req.tab)) return;
      setShared("collie-pane-chat.page", null);
      if (req.page === "helper") this.toHelper(self, cx);
    });
    // "collie-pane-chat.toggle" (a key, or `herdr-app do`): the focused pane switches. At most 5 s per wait (one
    // pending nextCommand), so a reload's old build ends at its next cx use instead of staying in memory.
    cx.spawn(async (cx) => {
      let cmd = null;
      for (;;) {
        cmd ??= nextCommand();
        const c = await Promise.race([cmd, cx.sleep(5000)]);
        if (c === undefined) continue;
        cmd = null;
        const self = this.me();
        if (c !== "toggle" || !self?.focused) continue;
        if (Date.now() - this.born < 2000 || Date.now() - lastSwap < 3000) continue;
        lastSwap = Date.now();
        if (self.mod === CHAT) { if (agentOf(self.pane)) this.toTerminal(self.pane, cx); }
        else if (chatty(self)) this.toChat(self, cx);
      }
    });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  // A 24 px icon button (split, zoom, close).
  button(t, id, icon, command, args, fn = null) {
    return h_flex()
      .id(id)
      .size(24)
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(RADIUS.control)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (fn) fn(cx); else run(command, args);
        cx.notify();
      })
      .child(svg(`mods/collie-pane-chat/${icon}.svg`).size(14));
  }

  // Terminal → Chat: the chat takes this agent pane's spot.
  toChat(p, cx) {
    const open = chatOf(p.terminal);
    if (open) { run("pane.focus", { pane: open }); return; }
    if (this.busy) return;
    this.busy = true;
    const terminal = p.terminal;
    cx.spawn(async (cx) => {
      try {
        const out = await app("pane.split", { direction: "right", pane: p.pane, mod: CHAT, props: { terminal } });
        if (!out.pane || !(await waitPane((x) => x.pane === out.pane, cx))) throw new Error("Herdr didn't open the chat");
        // The agent knows its chat: if that pane goes with its tab or space, the agents list ends the agent, as
        // closing its own pane would have.
        await hc(["label", terminal, `${LABEL}=${out.pane}`]);
        // Last: parking removes this pane, and this header with it. The chat turns core keep back on once the park
        // has gone through (mods/collie-chat).
        await app("terminal.park", { terminal });
      } catch (e) {
        toast({ title: "Chat didn't open", body: plainError(e), level: "error" });
      }
      this.busy = false;
      cx.notify();
    });
  }

  // Chat → Terminal: the agent's terminal gets a pane beside the chat, then the chat closes, so the terminal is back
  // in the same spot.
  toTerminal(chat, cx) {
    const terminal = agentOf(chat);
    const live = Boolean(terminal);
    // Not running, or still in a pane of its own (a chat opened beside it): just close the chat.
    const own = live && panes().find((x) => x.terminal === terminal);
    if (!live || own) {
      const zoomed = panes().find((x) => x.pane === chat)?.zoomed;
      run("pane.close", { pane: chat });
      if (terminal) hc(["label", terminal, `${LABEL}=`]);
      if (own) { if (zoomed && own.zoomed) run("pane.zoom", { pane: own.pane }); run("pane.focus", { pane: own.pane }); }
      return;
    }
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await app("pane.focus", { pane: chat });
        await app("terminal.keep", { terminal, place: "right" });
        if (!(await waitPane((x) => x.terminal === terminal, cx))) throw new Error("Herdr didn't bring the terminal back");
        await hc(["label", terminal, `${LABEL}=`]);
        // Last: closing the chat removes this header too.
        await app("pane.close", { pane: chat });
      } catch (e) {
        toast({ title: "Terminal didn't come back", body: plainError(e), level: "error" });
      }
      this.busy = false;
      cx.notify();
    });
  }

  // Chat → Helper: the helper terminal takes this pane's slot. The page we leave is closed or parked (running, no
  // pane); the helper keeps its own agent and pane, so switching back does not restart it.
  toHelper(self, cx) {
    const helper = helperFor(self);
    const coord = coordinatorFor(self);
    if (!helper || !coord || self.terminal === helper.address || this.busy) return;
    const existing = panes().find((p) => p.terminal === helper.address);
    if (existing) { run("pane.focus", { pane: existing.pane }); return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await app("pane.focus", { pane: self.pane });
        await app("terminal.keep", { terminal: helper.address, place: "right" });
        if (!(await waitPane((x) => x.terminal === helper.address, cx))) throw new Error("Herdr didn't open the Helper page");
        // Last: removing the page we came from leaves the helper in the slot.
        if (self.mod === CHAT) await app("pane.close", { pane: self.pane });
        else if (self.terminal) await app("terminal.park", { terminal: self.terminal });
      } catch (e) {
        toast({ title: "Helper didn't open", body: plainError(e), level: "error" });
      }
      this.busy = false;
      cx.notify();
    });
  }

  // Helper → Chat: open the Coordinator's chat in the helper pane's slot, then park the helper.
  toCoordinatorChat(self, cx) {
    const coord = coordinatorFor(self);
    const helper = helperFor(self);
    if (!coord || this.busy) return;
    const open = chatOf(coord.address);
    if (open) { run("pane.focus", { pane: open }); return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await app("pane.focus", { pane: self.pane });
        const out = await app("pane.split", { direction: "right", pane: self.pane, mod: CHAT, props: { terminal: coord.address } });
        if (!out.pane || !(await waitPane((x) => x.pane === out.pane, cx))) throw new Error("Herdr didn't open the chat");
        await hc(["label", coord.address, `${LABEL}=${out.pane}`]);
        // Last: parking the helper removes this header together with its pane.
        if (helper) await app("terminal.park", { terminal: helper.address });
      } catch (e) {
        toast({ title: "Chat didn't open", body: plainError(e), level: "error" });
      }
      this.busy = false;
      cx.notify();
    });
  }

  // Helper → Terminal: put the Coordinator terminal in the helper pane's slot, then park the helper.
  toCoordinatorTerminal(self, cx) {
    const coord = coordinatorFor(self);
    const helper = helperFor(self);
    if (!coord || this.busy) return;
    const own = panes().find((p) => p.terminal === coord.address);
    if (own) { run("pane.focus", { pane: own.pane }); return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await app("pane.focus", { pane: self.pane });
        await app("terminal.keep", { terminal: coord.address, place: "right" });
        if (!(await waitPane((x) => x.terminal === coord.address, cx))) throw new Error("Herdr didn't bring the terminal back");
        if (helper) await app("terminal.park", { terminal: helper.address });
      } catch (e) {
        toast({ title: "Terminal didn't come back", body: plainError(e), level: "error" });
      }
      this.busy = false;
      cx.notify();
    });
  }

  // A chat pane's ✕ does what an agent pane's does: ends the agent, and the pane goes (no dialog in collie).
  closeChat(chat) {
    const terminal = agentOf(chat);
    if (terminal) run("terminal.kill", { terminal });
    run("pane.close", { pane: chat });
  }

  // Chat | Terminal | Helper: three pages of the Coordinator pane, only one visible at a time.
  switcher(id, page, onChat, onTerminal, onHelper, canHelper) {
    const options = [[CHAT, "Chat"], ["terminal", "Terminal"], ...(canHelper ? [["helper", "Helper"]] : [])];
    return segmented(id, options, page, (v, _e, cx) => {
      if (v === CHAT) return onChat(cx);
      if (v === "helper") return onHelper(cx);
      return onTerminal(cx);
    });
  }

  // One copy of Herdr's live lists for the whole render (above): past ~50 ms Herdr stops it.
  render(cx) {
    return inRender(() => this.draw(cx));
  }

  draw(cx) {
    const t = theme();
    const self = this.me();
    if (!self) return div();
    // A chat pane wears its agent's header: same name, folder and status.
    const chatMode = self.mod === CHAT;
    const agent = chatMode ? agentOf(self.pane) : null;
    const entry = agent ? { terminal: agent } : null;
    // A Helper page is the helper terminal itself; Chat is a chat pane; otherwise it is the Coordinator terminal.
    const helper = helperFor(self);
    const helperMode = Boolean(helper && self.terminal === helper.address);
    const page = chatMode ? CHAT : helperMode ? "helper" : "terminal";
    const coord = chatMode ? (agent ? terminals().find((x) => x.address === agent) : coordinatorFor(self)) : coordinatorFor(self);
    const p = (entry && parked(entry.terminal)) ?? self;
    const lazy = chatMode && !entry && lazySlot(self.pane);
    const prog = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "Shell";
    // A Coordinator reads as its space, never its role or what it runs: the space's name, then its folder, quieter.
    const isAssistant = Boolean(lazy) || terminals().find((x) => x.address === (agent ?? self.terminal))?.labels?.["herdr.role"] === "coordinator";
    const space = isAssistant ? spaces().find((s) => s.tabs?.some((x) => x.id === self.tab)) : null;
    const name = helperMode ? "Helper" : isAssistant ? spaceName(space, home()) : chatMode && p === self ? "Chat" : prog;
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = self.pane;
    // Chat | Terminal | Helper belongs to the Coordinator only; worker panes keep their plain header.
    const canSwitch = isAssistant;
    // Only a Coordinator pane has the Helper page; other agents in the same space do not.
    const canHelper = false;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(TEXT.label)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_size_change((size, cx) => { if (Math.round(size.width) !== this.width) { this.width = Math.round(size.width); cx.notify(); } })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().max_w(260).min_w(0).truncate().font_medium().text_color(t.foreground).child(name))
      // The folder gives way first; the switch keeps its width; the gap after pushes the rest right.
      .child(div().flex_shrink_1().min_w(0).truncate().text_color(t.dim).child(folder(p.cwd)))
      .child(div().flex_1())
      // The status in words, right-aligned with the controls: "Working…" with its spinner, "Needs you", nothing at
      // rest (done is the normal state, no mark).
      .when(st === "working", (el) => el.child(h_flex().flex_none().gap(6).items_center().text_color(t.muted)
        .child(svg("mods/collie-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900))
        .when((this.width ?? Infinity) >= COMPACT_BELOW, (el) => el.child(div().whitespace_nowrap().child("Working…")))))
      .when(st === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(RADIUS.control).bg(t.blocked + "26").text_size(TEXT.id).font_semibold().text_color(t.blocked).child("Needs you")))
      // Hover buttons come before the switch so Chat | Terminal never moves.
      .when(this.hovered, (el) => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, self.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(chatMode && entry
          ? this.button(t, `ph-x-${pane}`, "close", null, null, () => this.closeChat(pane))
          : this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })))
      .when(canSwitch, (el) => el.child(this.switcher(`ph-mode-${pane}`, page,
        // Chat: from a Coordinator terminal, the existing split/park swap; from Helper, target the Coordinator.
        (cx) => (helperMode ? this.toCoordinatorChat(self, cx) : this.toChat(self, cx)),
        // Terminal: from Chat, the existing swap; from Helper, target the Coordinator terminal.
        (cx) => (helperMode ? this.toCoordinatorTerminal(self, cx)
          : lazy && !agentOf(pane) ? setShared("collie-chat.startreq", { pane, at: Date.now() }) : this.toTerminal(pane, cx)),
        (cx) => this.toHelper(self, cx),
        canHelper)));
  }
}
