// Coordinator chat: an agent's conversation as a chat, read from the agent's own session log, with a box to write to
// it. The agent keeps running in its terminal, parked behind this pane (herdr.chat); this shows it another way.
// Opened by mods/collie-tabs (openCoordinator) as a space's Coordinator tab:
// { role: "coordinator", template, space, folder, slot, settings }: chat with no agent yet. Its first message starts
// the agent (the template) parked behind this chat with that message as its task; shared "coordinator.slots"[slot] =
// { space, tab, pane, folder } says which pane and tab it is. When that agent ends, the chat is empty again.
// Or { terminal }: an agent's address ("t7", or "vps/t7" on another machine), read-only, to read a conversation.
// The box's pick button (picker.js, #21) chooses the agent, model, reasoning effort, Fast and permissions before the
// first message, or restarts the running agent on them (mods/collie-tabs/bin/restart.sh: same session or a handoff, the
// tab's and slot's labels kept). The box takes files (attach.js, #20: a drop, a paste, the desktop's picker) and sends
// their paths with the message, copying them to another machine first; images show as thumbnails and open in the
// viewer (viewer.js). Typing "/" lists the agent's commands (core/slash.js); "#" lists the spaces its machine reaches
// (core/mentions.js). #22 added the chat's cards and states: reactions (chips under a message, the emoji picker in
// reactions.js), secrets an agent asks for by name (secret-card.js, core/secrets.js into Collie's own store), the
// artifacts a publish made (a card that opens the collie-artifacts viewer), and what the agent left running in the
// background (core/bg-jobs.js). Shepherdr's threads, Tasks panel and voice stay out: this is the Coordinator's
// conversation only.

import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea, ScrollHandle, TextView } from "gpui-base";
import { appHome, exec, hc, home, openOverlay, props, readTextFile, run, setShared, shared, theme, watchFolder, writeTextFile } from "herdr";
import { terminals, panes, spaces, inRender } from "./live.js";
import { FIND, LOG, Conversation, records, summary, excerpt } from "./core/chat-log.js";
import { WORDS, LOST, lostMessage, shellWord, sessionStarted, sessionFailed, notSent, dayOf, dayLabel, clock,
  firstUser, firstKeys, literal, briefLabel, newsLine, published, artifactLine, resolveArtifacts, bgGroups,
  subagentsOf, subagentWord, ago,
} from "./core/chat-view.js";
import { sendBody, refusal, messageBody, reactionLine } from "./core/send.js";
import { BgJobs } from "./core/bg-jobs.js";
import * as secrets from "./core/secrets.js";
import { SecretCards } from "./secret-card.js";
import { frequent, used } from "./core/emoji.js";
import { openViewer, artifactCli } from "./lib/artview.js";
import { asPerson } from "./core/person.js";
import { NAMES, argvFor, asPick, current as currentOf, fitPick, freshArgv, line, samePick, sessionOf } from "./core/agents.js";
import { cleanCommand } from "./core/clean-env.js";
import { parseTemplate } from "./core/template.js";
import { chatLabel } from "./core/spaces.js";
import { words as askWords, howAnswered } from "./core/asks.js";
import { AskCards } from "./cards.js";
import { strip } from "./strips.js";
import { ScreenWatch, screenStrips, openCard as openScreen, starting } from "./screens.js";
import { H, RADIUS, TEXT, button, plainError, toast } from "./lib/ui.js";
import { chatPick, withChatPickText } from "./core/pick-settings.js";
import { ModelPicker, PICK, loadChoices } from "./picker.js";
import * as attach from "./attach.js";
import { messageText, names, imagePaths } from "./core/attach.js";
import * as slash from "./core/slash.js";
import * as mentions from "./core/mentions.js";
import { ImageViewer, VIEW } from "./viewer.js";
import EmojiPicker from "./reactions.js";

const PAGE = 200;
const KEEP = 2000;
const KINDS = { "claude-code": "claude", claude: "claude", codex: "codex" };
const TEMPLATE = 'dir="$HOME/.config/herdr-core/templates"; ';
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const personHc = asPerson({ hc, exec });
// A request's id is <terminal>.<time>.<hook pid>: its moment.
const askAt = (id) => { const p = String(id).split("."), sec = Number(p[p.length - 2]); return Number.isFinite(sec) && sec > 1e9 ? sec * 1000 + 999 : Date.now(); };

// Which CLI a terminal runs: "claude" | "codex" from its report or its program, else null.
const cliOf = (k) => {
  const a = String(k?.status?.app ?? k?.agent ?? k?.foreground?.name ?? "");
  return /^claude/.test(a) ? "claude" : /^codex/.test(a) ? "codex" : null;
};

export default class CoordinatorChat extends View {
  init(_props, cx) {
    const P = props() ?? {};
    // The model menu is this mod too, in an overlay (openPicker): it draws none of the chat.
    if (P.picker) {
      this.picker = new ModelPicker(P.picker, cx);
      return;
    }
    // The image viewer is this mod too, in an overlay (openImages/openText): it draws none of the chat.
    if (P.viewer) {
      this.viewer = new ImageViewer(P.viewer, cx);
      return;
    }
    // So is the emoji picker (reactions.js), opened by openReactions().
    if (P.react) {
      this.reactions = new EmojiPicker(P.react, cx);
      return;
    }
    this.origin = P.terminal ?? null;
    this.addr = this.origin;
    this.readOnly = Boolean(P.terminal);
    this.role = P.role ?? null;
    this.slot = P.slot ?? null;
    // A restored/opened-elsewhere chat may have lost the shared slot record; rebuild it so the
    // pane header's Chat/Terminal switch knows this pane.
    if (this.role === "coordinator" && this.slot && !shared("coordinator.slots")?.[this.slot]) {
      const own = panes().find((p) => p.mod === "collie-chat" && p.focused) ?? panes().find((p) => p.mod === "collie-chat");
      if (own) setShared("coordinator.slots", { ...(shared("coordinator.slots") ?? {}), [this.slot]: { space: P.space, tab: own.tab, pane: own.pane, folder: P.folder ?? null } });
    }
    this.template = P.template ?? (this.role === "coordinator" ? "collie-coordinator" : null);
    this.machine = this.addr?.includes("/") ? this.addr.split("/")[0] : null;
    this.phase = this.addr ? "finding" : "fresh";
    this.conv = null;
    this.path = null;
    this.kind = null;
    this.start = null;
    // The last pane header's start request this chat answered (shared "collie-chat.startreq").
    this.startReqAt = shared("collie-chat.startreq")?.at ?? null;
    // What the agent starts on, from the chat's picker (shared "collie-chat.pick"), and the pick this chat last
    // answered: { agent, model, effort, fast, perm } (core/agents.js). The menus are what Collie's agents offer.
    this.pick = null;
    this.pickAtPos = null;
    this.pickReqAt = shared("collie-chat.pick")?.at ?? null;
    // The picker's Restart (shared "collie-chat.restartreq" = { pane, at, pick }), answered once.
    this.restartReqAt = shared("collie-chat.restartreq")?.at ?? null;
    this.restarting = false;
    this.menus = null;
    this.dflt = {};
    this.end = 0;
    this.records = [];
    this.pending = [];
    this.queue = [];
    // The box's files (attach.js: tiles above it, their paths in the message) and the images the chat shows
    // (attach.viewable), the #spaces picked into it (core/mentions.js), and the "/" list's state.
    this.files = [];
    this.views = {};
    this.viewAsked = new Set();
    this.picked = [];
    this.slashSel = 0;
    this.slashOff = null;
    this.cmds = [];
    this.cmdsFor = null;
    this.lastValue = "";
    this.reach = null;
    this.reachFor = undefined;
    this.saveAt = 0;
    this.note = null;
    this.error = null;
    this.firstSend = null;
    this.swapping = false;
    this.lostTried = new Set();
    // Claude's PermissionRequest hook (ask-hook.sh) leaves requests in data/chat-asks/: { id, req, words }, oldest
    // first; a closed one leaves a quiet line.
    this.askDir = `${appHome()}/data/chat-asks`;
    this.asks = [];
    this.askEnds = [];
    this.askWatch = null;
    this.cards = new AskCards({
      reply: (ask, text, cx) => this.reply(ask, text, cx),
      toTerminal: () => this.toTerminal(),
      chatAbout: () => this.box.focus?.(),
    });
    // Secrets an agent asks for by name (secret-card.js): its terminal's collie.secret.ask.NAME labels, each a masked
    // card here; the value lands in Collie's own vault (~/.local/share/collie/secrets/vault.json), never in the log.
    const chat = this;
    this.secretCards = new SecretCards({
      readVault: () => chat.readVault(),
      writeVault: (text) => chat.writeVault(text),
      say: (line, cx) => chat.say(line, cx),
      // This window's machine keeps them; an agent on another machine can't use them yet (no vault sync: #16).
      get where() { return chat.machine ? `this computer, not ${chat.machine}` : "This computer"; },
    });
    this.secretCards.onEnd = (ask, how) => this.secretEnded(ask, how);
    this.secretEnds = [];
    // Reactions: the emoji picker's request (shared "collie-chat.reactreq"), your reactions just sent (shown until the
    // log says the same), how often and how lately the person used each emoji, and where the react button was pressed.
    this.reactReqAt = shared("collie-chat.reactreq")?.at ?? null;
    this.myReacts = new Map();
    this.uses = {};
    this.reactAt = null;
    this.usePath = `${appHome()}/data/chat-emoji-uses.json`;
    if (!this.readOnly) cx.spawn(async (cx) => {
      try { this.uses = JSON.parse(await readTextFile(this.usePath)) ?? {}; } catch {}
      cx.notify();
    });
    // Artifacts a publish made (core/task-artifacts.js, lib/artview.js): the machine's registry, read when the
    // conversation has a publish and again while one isn't listed yet.
    this.arts = null;
    this.artsAt = 0;
    this.artsLoading = false;
    // What the agent left running in the background (core/bg-jobs.js): its shells and watchers, live, each stoppable;
    // the row opened over the box, the last lines it printed, and a Stop on its way.
    this.bgJobs = new BgJobs();
    this.jobOpen = null;
    this.jobOut = new Map();
    this.jobStopping = new Set();
    this.groupOpen = {};
    // CLI start screens (screens.js): trust this folder, sign in, ... while this agent hasn't started its session.
    this.screens = new ScreenWatch();
    this.screenBusy = new Set();
    this.screenErr = new Map();
    this.pinned = true;
    this.scroll = ScrollHandle.new();
    this.box = TextareaState.new({ placeholder: "Message the Coordinator…" });
    this.box.set_rows(1);
    this.box.on("submit", (e, cx) => { if (!e?.shift) this.enter(cx, Boolean(e?.secondary)); });
    this.box.on("change", (_e, cx) => this.boxChanged(cx));
    // A paste with no text: the clipboard's image (or files copied in a file manager) becomes a tile.
    this.box.on("paste_other", (_e, cx) => cx.spawn(async (cx) => {
      const got = await attach.fromClipboard().catch(() => []);
      if (got.length) { this.addFiles(got); this.saveSoon(cx); cx.notify(); }
    }));
    // What the last chat left unsent (its words, its files, its held messages): per slot, or per agent when opened by
    // its address. Dropped pasted images older than a day go at the same time.
    this.draftFile = `${appHome()}/data/chat-drafts/${String(this.slot ? `slot:${this.slot}` : this.addr ?? "none").replace(/[^\w.-]+/g, "_")}.json`;
    if (this.addr || this.role) cx.spawn(async (cx) => { await this.loadDraft(cx); attach.prune(); });
    cx.timer.every(1000, (cx) => cx.notify());
    // The pane header's Terminal on a chat with no agent yet (mods/collie-pane-chat), and the model menu's picks.
    cx.timer.every(1000, (cx) => this.startRequest(cx));
    cx.timer.every(1000, (cx) => this.pickTicks(cx));
    // The emoji picker's pick (shared "collie-chat.reactreq"), answered once.
    cx.timer.every(500, (cx) => this.reactTicks(cx));
    // Before the first message: what the last chat saved in Collie's settings (the picker's choice), else
    // props.settings (the Coordinator's configured CLI), else the agents' own defaults. pickReady lets a first message
    // sent at once wait for it.
    this.pickReady = null;
    if (!this.readOnly) {
      let ready = null;
      this.pickReady = new Promise((r) => { ready = r; });
      cx.spawn(async (cx) => { try { await this.loadPick(cx); } finally { ready(); } });
    }
    // Asks: the hook's request folder while there is an agent; the flag says a chat shows it.
    cx.spawn(async (cx) => this.watchAsks(cx));
    // CLI start screens: read while the agent is still before its session.
    cx.timer.every(2000, (cx) => cx.spawn(async () => this.screenTick(cx)));
    // A slot chat whose agent already runs (a reload, or Herdr started it): follow it (adoptSlot below).
    if (this.addr) cx.spawn(async (cx) => this.follow(cx));
    else if (this.slot) cx.timer.every(2000, (cx) => this.adoptSlot(cx));
  }

  // One copy of Herdr's live lists for the whole render (live.js): past ~50 ms Herdr stops it.
  render(cx) {
    if (this.picker) return this.picker.render(cx);
    if (this.viewer) return this.viewer.render(cx);
    if (this.reactions) return this.reactions.render(cx);
    return inRender(() => this.draw(cx));
  }

  draw(cx) {
    const t = theme();
    const rows = this.rows(cx);
    // The images the box and the rows show: each is linked for image() once, its size read with it.
    this.needViews([...this.files.filter((f) => f.image).map((f) => f.path), ...rows.flatMap((r) => r.paths ?? [])], cx);
    // Newest at the bottom: the last row is on screen while the person is at the bottom.
    if (this.pinned && rows.length) this.scroll.scroll_to_item(rows.length - 1);
    // What the agent left running in the background, over the box (core/bg-jobs.js, #22).
    const bg = this.readOnly ? null : this.background(t, cx);
    return div().id("collie-chat").flex().flex_col().size_full().min_h(0).bg(t.background)
      .child(this.list(t, rows, cx))
      .when(Boolean(bg), (el) => el.child(bg))
      .child(this.composer(t, cx));
  }

  // ---- the conversation's rows -----------------------------------------------------------------

  rows(cx) {
    const out = [];
    const items = this.conv?.items ?? [];
    const first = firstUser(items);
    // The artifacts this conversation's publishes made (lib/artview.js's registry): a card for the latest publish of
    // one, a quiet line for its earlier ones, and a "Publishing…" line while the registry doesn't list it yet.
    const arts = this.resolveArts(items);
    let day = null;
    items.forEach((x, i) => {
      const at = x.at ?? 0;
      if (at && dayOf(at) !== day) {
        day = dayOf(at);
        out.push({ kind: "day", id: `day-${day}`, at, text: dayLabel(at) });
      }
      if (x.kind === "user") {
        const label = briefLabel(x, i, { start: this.start, template: this.template, first });
        out.push(label
          ? { kind: "brief", id: x.id, at, text: label }
          : { kind: "user", id: x.id, at, text: x.text ?? "", from: x.from ?? null, images: x.images ?? 0, paths: x.paths ?? null });
      } else if (x.kind === "agent") {
        out.push({ kind: "agent", id: x.id, at, text: x.text ?? "" });
      } else if (x.kind === "artifact") {
        const r = arts.get(x.id);
        if (r) out.push({ kind: "artifact", id: x.id, art: r.id, title: r.title, text: r.title, version: r.version, v: r.v, line: !r.latest });
        else if (Date.now() - (x.at ?? 0) < 180000) out.push({ kind: "artifact", id: x.id, pending: true, text: "" });
      } else if (x.kind === "tools" && x.steps?.length) {
        out.push({ kind: "tools", id: x.id, at, text: summary(x.steps) });
      } else if (x.kind === "news") {
        out.push({ kind: "news", id: x.id, at, ref: x.ref, event: x.event, text: newsLine(x) });
      } else if (x.kind === "ask") {
        out.push({ kind: "tools", id: x.id, at, text: `Asked you: ${excerpt(x.text, 120)}` });
      }
    });
    // The cards waiting on the person: this agent's start screen, then its asks (asks.js).
    const scr = this.addr && !this.readOnly ? openScreen(this.addr) : null;
    if (scr) out.push({ kind: "card", id: `card:${scr.id}`, strips: screenStrips(scr, {
      who: this.cliName(), busy: this.screenBusy.has(scr.id), error: this.screenErr.get(scr.id),
      press: (i, cx) => this.pressScreen(scr, i, cx), toTerminal: () => this.toTerminal() }) });
    for (const a of this.asks) out.push({ kind: "card", id: `card:${a.id}`, strips: this.cards.strips(a, { who: this.cliName() }) });
    // The secrets it asks for by name (its terminal's labels): a masked card each, then those answered a moment ago.
    const secretList = this.addr && !this.readOnly ? this.secretCards.items(this.addr) : [];
    // Prepared every render, an empty list too: a gone ask's box is let go.
    if (this.addr && !this.readOnly) this.secretCards.prepare(secretList, cx);
    for (const a of secretList) out.push({ kind: "card", id: `card:secret:${a.name}`, strips: this.secretCards.strips(a, { who: this.cliName() }) });
    for (const e of this.askEnds) out.push({ kind: "askend", id: `ae:${e.id}`, at: e.at, text: `${e.title} · ${e.how}` });
    for (const e of this.secretEnds) out.push({ kind: "secretend", id: `se:${e.id}`, at: e.at, text: `Secret: ${e.name} · ${e.how}` });
    // Sent from here but not in the log yet: shown as sent (or why not).
    for (const p of this.pending) out.push({ kind: p.failed ? "failed" : "user", id: p.id, at: p.at, text: p.text,
      error: p.failed ?? null, pending: !p.delivered, files: p.files ?? null, paths: p.paths ?? null });
    for (const m of this.queue) out.push({ kind: "queued", id: m.id, at: 0,
      text: m.label ?? [m.text, ...(m.files ?? []).map((f) => f.name)].filter(Boolean).join(" · ") });
    if (this.note) out.push({ kind: "note", id: "note", at: 0, text: this.note });
    if (this.phase === "ended") out.push({ kind: "note", id: "ended", at: 0, text: WORDS.ended });
    if (this.phase === "unsupported") out.push({ kind: "failed", id: "unsupported", at: 0, text: "This terminal doesn't run Claude Code or Codex." });
    if (this.error) out.push({ kind: "failed", id: "error", at: 0, text: this.error });
    return out;
  }

  list(t, rows, cx) {
    const empty = !this.readOnly && this.phase === "fresh" && !rows.length;
    return div().id("collie-chat-rows").flex().flex_col().flex_1().min_h(0).overflow_y_scrollbar()
      .track_scroll(this.scroll).px(24).py(12).gap(6)
      .when(empty, (el) => el.items_center().justify_center().child(
        div().max_w(420).flex().flex_col().gap(6).items_center()
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child(WORDS.emptyTitle))
          .child(div().text_size(TEXT.body).text_color(t.muted).child(WORDS.emptyBody))
          .when(Boolean(this.pick?.agent), (el2) => el2.child(div().text_size(TEXT.id).text_color(t.dim).child(line(this.pick, this.menus))))))
      .children(rows.map((r) => this.row(t, r, cx)))
      .when(this.working(), (el) => el.child(this.workingRow(t, cx)));
  }

  row(t, r, cx) {
    if (r.kind === "day") return this.quiet(t, r, { center: true, small: true });
    if (r.kind === "brief") return this.quiet(t, r);
    if (r.kind === "tools") return this.quiet(t, r);
    if (r.kind === "news") return this.quiet(t, r, { small: true });
    if (r.kind === "askend") return this.quiet(t, r, { small: true });
    if (r.kind === "secretend") return this.quiet(t, r, { small: true });
    if (r.kind === "card") return this.card(t, r);
    if (r.kind === "artifact") return this.artifact(t, r);
    if (r.kind === "queued") return this.quiet(t, r, { text: `${WORDS.inQueue} · ${excerpt(r.text, 100)}` });
    if (r.kind === "note") return this.quiet(t, r, { small: true });
    if (r.kind === "failed") return this.quiet(t, r, { danger: true });
    if (r.kind === "user") {
      return h_flex().id(r.id).w_full().justify_end().child(
        div().max_w(560).flex().flex_col().gap(2).items_end()
          .when(Boolean(r.files?.length), (el) => el.child(h_flex().max_w(520).gap(4).items_center()
            .child(svg("mods/collie-chat/file.svg").size(12).flex_none().text_color(t.dim))
            .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(r.files.join(", ")))))
          .when(Boolean(String(r.text ?? "").trim()), (el) => el.child(div().rounded(RADIUS.card).bg(t.raised).border_1().border_color(t.border).px(12).py(8).text_size(13)
            .text_color(t.foreground).child(TextView.markdown(`chat-md-${r.id}`, literal(this.mentionsIn(r.text)) || " ").selectable(true))))
          .when(Boolean(r.paths?.length), (el) => el.child(this.thumbs(t, r.paths, r.id, cx, { faded: r.pending })))
          .when(Boolean(r.error), (el) => el.child(div().text_size(11).text_color(t.ansi1).child(notSent(r.error))))
          .child(h_flex().gap(8).items_center()
            .child(this.reactions_(t, r, cx))
            .child(div().text_size(11).text_color(t.dim).child(r.pending ? "Sending…" : clock(r.at)))));
    }
    // The agent's own words.
    return div().id(r.id).w_full().flex().flex_col().gap(2).px(2).py(2)
      .child(div().text_size(13).text_color(t.foreground).child(TextView.markdown(`chat-md-${r.id}`, r.text || " ").selectable(true)))
      .child(h_flex().gap(8).items_center()
        .child(this.reactions_(t, r, cx))
        .when(Boolean(r.at), (el) => el.child(div().text_size(11).text_color(t.dim).child(clock(r.at)))));
  }

  // A published artifact: its card (the latest publish of it; earlier ones a quiet line), or a quiet line while the
  // registry doesn't list it yet. Either way its press opens it in the collie-artifacts viewer (lib/artview.js).
  artifact(t, r) {
    const icon = (n) => svg("mods/collie-artifacts/artifacts.svg").size(n).flex_none();
    if (r.pending || r.line) {
      return h_flex().id(r.id).w_full().py(2).gap(6).items_center().text_size(12).text_color(t.dim)
        .when(Boolean(r.art) && !r.pending, (el) => el.rounded(RADIUS.control).px(4).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.muted))
          .on_click((_e, cx) => { cx.stop_propagation(); this.openArtifact(r); }))
        .child(icon(12))
        .child(div().min_w(0).truncate().child(r.pending ? WORDS.publishing : published(r.title, r.v)));
    }
    return h_flex().id(r.id).w_full().max_w(420).gap(10).items_center().px(10).py(8).rounded(RADIUS.card).cursor_pointer()
      .bg(t.surface).border_1().border_color(t.border).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); this.openArtifact(r); })
      .child(div().size(32).flex_none().flex().items_center().justify_center().rounded(RADIUS.control).bg(t.raised).text_color(t.muted).child(icon(16)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().font_medium().text_color(t.foreground).truncate().child(r.title))
        .child(div().text_size(12).text_color(t.dim).child(artifactLine(r.version))))
      .child(h_flex().h(28).px(10).flex_none().items_center().rounded(RADIUS.control).border_1().border_color(t.input).bg(t.background)
        .text_size(TEXT.label).font_medium().text_color(t.foreground).child(WORDS.open));
  }

  // A message's reactions: one chip per emoji (yours filled, the count when several people or a repeat), and the react
  // button that opens the emoji picker over it.
  reactions_(t, r, cx) {
    const pills = r.text || r.paths?.length ? this.pills(r.id) : [];
    // A read-only chat (another agent's conversation) shows its reactions and takes none; a message still being sent
    // has no log id yet.
    const live = !this.readOnly && !r.pending && !r.error;
    const chip = (p) => h_flex().id(`pill-${r.id}-${p.emoji}`).h(20).px(6).gap(4).flex_none().items_center().rounded(10)
      .bg(p.you ? t.selected : t.raised).border_1().border_color(p.you ? t.accent : t.border)
      .when(live, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggleReaction(r.id, r.text ?? "", p.emoji, cx); }))
      .child(div().text_size(12).child(p.emoji))
      .when(p.count > 1, (el) => el.child(div().text_size(TEXT.id).text_color(t.muted).child(String(p.count))));
    return h_flex().id(`react-row-${r.id}`).gap(2).items_center()
      .children(pills.map(chip))
      .when(live, (el) => el.child(div().id(`react-${r.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(10)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (e) => { this.reactAt = e.position; })
        .on_click((_e, cx) => { cx.stop_propagation(); this.openReactions(r); })
        .child(svg("mods/collie-chat/react/smile-plus.svg").size(13).flex_none().text_color(t.dim))));
  }

  // A card (an ask, a start screen): its strips, one row each, looking like one card (strips.js).
  card(t, r) {
    return div().id(r.id).w_full().flex().flex_col().py(4)
      .children(r.strips.map((s, i) => strip(t, s, i === 0, i === r.strips.length - 1)));
  }

  quiet(t, r, { center = false, small = false, danger = false, text = null } = {}) {
    return h_flex().id(r.id).w_full().py(2).when(center, (el) => el.justify_center())
      .child(div().text_size(small ? 10 : 11).text_color(danger ? t.ansi1 : t.dim).child(text ?? r.text));
  }

  workingRow(t, cx) {
    const now = Date.now();
    const started = this.turnStarted ?? now;
    const secs = Math.max(0, Math.round((now - started) / 1000));
    const words = this.stopping ? WORDS.stopped : WORDS.working;
    return h_flex().id("collie-chat-working").w_full().gap(8).items_center().py(4)
      .child(div().flex_1().text_size(11).text_color(t.muted).child(`${words} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`))
      .child(button("collie-chat-stop", "Stop", { onClick: (_e, cx) => this.stop(cx) }));
  }

  // ---- reactions (#22) ---------------------------------------------------------------------------

  // A message's reactions as pills: { emoji, you, agent, count }, the log's word with yours just sent.
  pills(id) {
    if (!id) return [];
    const list = [...(this.conv?.reactions?.get(id) ?? [])];
    const mine = this.myReacts.get(id);
    if (mine) for (const [emoji, on] of mine) {
      const i = list.findIndex((r) => r.by === "you" && r.emoji === emoji);
      if (on && i < 0) list.push({ emoji, by: "you" });
      if (!on && i >= 0) list.splice(i, 1);
    }
    const by = new Map();
    for (const r of list) {
      const p = by.get(r.emoji) ?? { emoji: r.emoji, you: false, agent: false, count: 0 };
      p[r.by === "you" ? "you" : "agent"] = true;
      p.count++;
      by.set(r.emoji, p);
    }
    return [...by.values()];
  }

  // The emoji picker (reactions.js), anchored to the react button that was pressed: its left edge at the button's,
  // above it when there is room, else below.
  openReactions(row) {
    const W = 360, H = 420;
    const p = this.reactAt;
    const at = p ? { x: Math.max(8, p.x - W + 28), y: Math.max(8, p.y - H - 8) } : "pointer";
    const fr = frequent(this.uses, 18);
    openOverlay({ mod: "collie-chat", kind: "popup", frame: "none", width: W, height: H, at,
      props: { react: { pane: this.myPane(), target: row.id, text: row.text ?? "", height: H, width: W,
        frequent: fr, mine: this.pills(row.id).filter((p) => p.you).map((p) => p.emoji) } } });
  }

  // The picker's answer, once each: only this chat's pane's, and only for 5 s (an older request is another chat's).
  reactTicks(cx) {
    if (this.readOnly) return;
    const mine = this.myPane();
    const rq = shared("collie-chat.reactreq");
    if (!mine || !rq || rq.pane !== mine || rq.at === this.reactReqAt || !(Date.now() - rq.at < 5000)) return;
    this.reactReqAt = rq.at;
    cx.timer.after(0, (cx) => this.toggleReaction(rq.target, rq.text, rq.emoji, cx));
  }

  // How often the person used an emoji (data/chat-emoji-uses.json, core/emoji.js used()): the picker's frequent list.
  useEmoji(emoji) {
    this.uses = used(this.uses, emoji);
    (async () => {
      await exec("mkdir", ["-p", `${appHome()}/data`]).catch(() => null);
      await writeTextFile(this.usePath, JSON.stringify(this.uses), null).catch(() => null);
    })();
  }

  // The person's reaction on (or off) a message: one tag line to the agent, shown at once. While the agent waits on
  // the person (its own dialog, a question), it waits in the queue instead.
  toggleReaction(id, text, emoji, cx) {
    const on = !this.pills(id).some((p) => p.emoji === emoji && p.you);
    const mine = new Map(this.myReacts.get(id) ?? []);
    mine.set(emoji, on);
    this.myReacts.set(id, mine);
    if (on) this.useEmoji(emoji);
    const line = reactionLine(emoji, text, on);
    const st = this.status();
    if (st === "blocked" || this.asks.length) {
      this.queue.push({ id: `r${Date.now()}`, text: line, files: [], quote: null, raw: true, label: on ? `${emoji} reaction` : `${emoji} reaction removed` });
      this.saveSoon(cx);
    } else if (this.addr) personHc(["send", this.addr, line]);
    cx.notify();
  }

  // ---- secrets an agent asks for by name (#22) ---------------------------------------------------

  // Collie's own vault on this machine (~/.local/share/collie/secrets/vault.json): read, and written 0600 in a 0700
  // folder (core/secrets.js kept()). Never Shepherdr's ~/.herdr/vault.json.
  vaultPath() {
    return secrets.vaultFile({ home: home() });
  }

  async readVault() {
    return await readTextFile(this.vaultPath()).catch(() => null);
  }

  async writeVault(text) {
    const path = this.vaultPath();
    const dir = path.slice(0, path.lastIndexOf("/"));
    await exec("sh", ["-c", 'mkdir -p "$1" && chmod 700 "$1"', "x", dir]);
    await writeTextFile(path, text, null);
    await exec("chmod", ["600", path]);
  }

  // The words the agent hears (a kept or a declined secret): never the value. A blocked agent gets them queued.
  say(line, cx) {
    if (!this.addr) return;
    if (this.status() === "blocked" || this.asks.length) {
      this.queue.push({ id: `s${Date.now()}`, text: line, files: [], quote: null, raw: true, label: "Answer" });
      this.saveSoon(cx);
      cx.notify();
      return;
    }
    personHc(["send", this.addr, line]);
  }

  // A secret card answered here: its quiet line, at the card's moment.
  secretEnded(ask, how) {
    this.secretEnds = [...this.secretEnds, { id: `${ask.address}:${ask.name}:${Date.now()}`, name: ask.name, how, at: Date.now() }].slice(-20);
  }

  // ---- artifacts a publish made (#22) ------------------------------------------------------------

  // Which artifact each publish in the conversation made: the first version this agent published from a few seconds
  // before the call to five minutes after, not already taken (core/chat-view.js resolveArtifacts()).
  resolveArts(items) {
    return resolveArtifacts(items, this.arts, String(this.addr ?? "").split("/").pop());
  }

  // Every artifact on the agent's machine (collie-artifact list --all, the same registry mods/collie-artifacts reads),
  // read when the conversation has a publish, again every few seconds while one isn't listed yet.
  loadArts(cx) {
    if (this.artsLoading || this.readOnly || Date.now() - (this.artsAt ?? 0) < 3000) return;
    if (!(this.conv?.items ?? []).some((x) => x.kind === "artifact")) return;
    this.artsLoading = true;
    cx.spawn(async (cx) => {
      try {
        const out = await artifactCli(this.machine, ["list", "--all"]);
        this.arts = out?.artifacts ?? [];
      } catch {}
      this.artsAt = Date.now();
      this.artsLoading = false;
      cx.notify();
    });
  }

  // An artifact in the collie-artifacts viewer (lib/artview.js): a modal over the chat, that version when an earlier
  // publish's line was pressed, else the latest.
  openArtifact(row) {
    openViewer({ id: row.art, title: row.title, version: row.line && row.v ? row.v : row.version, latest: row.version,
      machine: this.machine ?? null, modal: true });
  }

  // ---- what the agent left running in the background (#22) ---------------------------------------

  // Its shells and watchers (core/bg-jobs.js): live while its agent is, none once it ended or this chat only reads.
  jobs() {
    if (!this.conv || this.phase !== "ready" || this.readOnly || !this.kind) return [];
    return this.bgJobs.list(this.kind, this.conv);
  }

  // Runs a shell script on the agent's machine (core/bg-jobs.js: its first argument is $0).
  runThere(script, args) {
    return exec("sh", ["-c", script, ...args], { on: this.machine });
  }

  // A look at the agent's processes when one is due, and the open row's last lines again.
  async lookJobs(cx) {
    const pid = terminals().find((x) => x.address === this.addr)?.foreground?.pid;
    if (!pid || !this.conv || this.phase !== "ready") return;
    const jobs = this.bgJobs;
    if (jobs.due(this.kind, this.conv) && await jobs.look((s, a) => this.runThere(s, a), this.kind, pid, this.conv)) cx.notify();
    const open = this.jobs().find((j) => j.id === this.jobOpen);
    if (this.jobOpen && !open) { this.jobOpen = null; cx.notify(); }
    if (open?.path) {
      const text = await jobs.output((s, a) => this.runThere(s, a), open);
      if (text !== null && text !== this.jobOut.get(open.id)) { this.jobOut.set(open.id, text); cx.notify(); }
    }
  }

  // Stop on an open row: its processes end; its CLI then tells the agent, as when it stops one itself.
  stopJob(job, cx) {
    const pid = terminals().find((x) => x.address === this.addr)?.foreground?.pid;
    if (!pid || this.jobStopping.has(job.id)) return;
    this.jobStopping.add(job.id);
    const jobs = this.bgJobs;
    cx.spawn(async (cx) => {
      await jobs.stop((s, a) => this.runThere(s, a), this.kind, pid, job).catch(() => {});
      this.jobStopping.delete(job.id);
      if (this.jobOpen === job.id) this.jobOpen = null;
      cx.notify();
    });
  }

  // Above the box: the Coordinator's own subagents at work, then its background shells and watchers, at most one row of
  // each kind (bgGroups()): one shows as its own row (an icon, its name, how long), two or more as one row ("3
  // background processes") that opens in place to the list of them. A shell's or watcher's row opens to its command,
  // what it printed last (Claude Code's), and Stop; a subagent's opens to "Open its chat" (this mod, read-only).
  background(t, rcx) {
    const now = Date.now();
    const kids = this.phase === "ended" ? [] : subagentsOf(terminals(), this.addr, now).map((k) => ({ ...k, kind: "child", id: `c:${k.address}`, label: k.title }));
    const shown = [...kids, ...this.jobs()];
    if (!shown.length) return null;
    const age = (at) => div().flex_none().text_size(TEXT.id).text_color(t.dim).child(ago(at, now));
    const row = (h) => {
      if (h.kind === "child") return this.subagentRow(t, h, age, rcx);
      const on = this.jobOpen === h.id;
      const head = h_flex().id(`job-${h.id}`).w_full().h(24).px(6).gap(8).items_center().rounded(RADIUS.control).cursor_pointer().text_size(TEXT.label)
        .when(on, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.jobOpen = on ? null : h.id;
          cx.notify();
          if (!on) cx.spawn(async (cx) => this.lookJobs(cx));
        })
        .child(svg(h.kind === "monitor" ? "mods/collie-chat/eye.svg" : "mods/collie-chrome/terminal.svg").size(12).flex_none().text_color(t.working))
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(h.label ?? ""))
        .child(age(h.at))
        .child(svg(on ? "mods/collie-chat/chevron-up.svg" : "mods/collie-chat/chevron-down.svg").size(12).flex_none().text_color(t.dim));
      if (!on) return head;
      const out = this.jobOut.get(h.id);
      const lines = out === undefined ? null : out.split("\n").slice(-8).map((l) => (l.length > 200 ? l.slice(0, 199) + "…" : l));
      const stopping = this.jobStopping.has(h.id);
      return v_flex().w_full().child(head)
        .child(v_flex().w_full().pl(26).pr(6).pt(4).pb(6).gap(6)
          .child(div().w_full().text_size(TEXT.id).text_color(t.muted).child((h.cmd ?? "").length > 300 ? h.cmd.slice(0, 299) + "…" : h.cmd ?? ""))
          .when(Boolean(h.path), (el) => el.child(v_flex().w_full().px(8).py(6).rounded(RADIUS.control).bg(t.surface).border_1().border_color(t.border)
            .text_size(TEXT.id).text_color(t.dim)
            .children(lines === null ? [div().child(WORDS.loading)] : lines.length && lines.some(Boolean) ? lines.map((l) => div().w_full().truncate().child(l || " ")) : [div().child(WORDS.noOutput)])))
          .child(h_flex().child(stopping
            ? h_flex().h(H.sm).px(10).items_center().text_size(TEXT.label).text_color(t.dim).child(WORDS.stopping)
            : button(`job-stop-${h.id}`, WORDS.stop, { onClick: (_e, cx) => this.stopJob(h, cx) }))));
    };
    // two or more of a kind: one row, opening in place to each of them
    const group = (g) => {
      const on = Boolean(this.groupOpen[g.kind]);
      const icon = g.kind === "proc" ? svg("mods/collie-chrome/terminal.svg").size(12).flex_none().text_color(t.working)
        : g.status === "working" ? svg("mods/collie-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
        : g.status === "needs" ? div().size(6).mx(3).flex_none().rounded(3).bg(t.ansi1)
        : svg("mods/collie-chat/check.svg").size(12).flex_none().text_color(t.dim);
      const head = h_flex().id(`bg-group-${g.kind}`).w_full().h(24).px(6).gap(8).items_center().rounded(RADIUS.control).cursor_pointer().text_size(TEXT.label)
        .when(on, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.groupOpen[g.kind] = !on; cx.notify(); })
        .child(icon)
        .child(div().flex_none().font_medium().text_color(t.foreground).child(g.words))
        .when(g.kind === "sub", (el) => el.child(div().flex_none().text_color(g.status === "needs" ? t.ansi1 : t.dim).child(subagentWord(g.status))))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(g.newest.label ?? ""))
        .child(age(g.newest.ended ? now - (g.newest.ended - g.newest.at) : g.newest.at))
        .child(svg(on ? "mods/collie-chat/chevron-up.svg" : "mods/collie-chat/chevron-down.svg").size(12).flex_none().text_color(t.dim));
      if (!on) return head;
      return v_flex().w_full().child(head).child(v_flex().w_full().pl(20).pt(2).children(g.items.map(row)));
    };
    return v_flex().id("collie-chat-bg").flex_none().w_full().px(14).pt(4)
      .children(bgGroups(shown).map((g) => (g.words ? group(g) : row(g.items[0]))));
  }

  // One subagent over the box: its status (a spinner at work, red asking, a check once done), "Reviewer · Codex", its
  // state in words and how long. It opens to what it does now and "Open its chat": its conversation in this mod, in a
  // dialog, read-only.
  subagentRow(t, h, age, rcx) {
    const on = this.jobOpen === h.id && !h.ended;
    const word = subagentWord(h.status);
    const icon = h.status === "working" ? svg("mods/collie-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
      : h.status === "needs" ? div().size(6).mx(3).flex_none().rounded(3).bg(t.ansi1)
      : svg("mods/collie-chat/check.svg").size(12).flex_none().text_color(t.dim);
    const head = h_flex().id(`sub-${h.address}`).w_full().h(24).px(6).gap(8).items_center().rounded(RADIUS.control).cursor_pointer().text_size(TEXT.label)
      .when(on, (el) => el.bg(t.hover))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); if (h.ended) return; this.jobOpen = on ? null : h.id; cx.notify(); })
      .child(icon)
      .child(div().min_w(0).truncate().font_medium().text_color(t.foreground).child(h.label))
      .child(div().flex_none().text_color(h.status === "needs" ? t.ansi1 : t.dim).child(word))
      .child(div().flex_1())
      .child(age(h.ended ? Date.now() - (h.ended - h.at) : h.at))
      .child(h.ended ? div().size(12).flex_none() : svg(on ? "mods/collie-chat/chevron-up.svg" : "mods/collie-chat/chevron-down.svg").size(12).flex_none().text_color(t.dim));
    if (!on) return head;
    const k = terminals().find((x) => x.address === h.address);
    const now = typeof k?.status === "object" ? k.status?.msg : null;
    return v_flex().w_full().child(head)
      .child(v_flex().w_full().pl(26).pr(6).pt(4).pb(6).gap(6)
        .when(Boolean(now), (el) => el.child(div().w_full().truncate().text_size(TEXT.id).text_color(t.dim).child(now)))
        .child(h_flex().child(button(`sub-open-${h.address}`, WORDS.subOpen, {
          onClick: (_e, cx) => {
            cx.stop_propagation();
            openOverlay({ mod: "collie-chat", kind: "dialog", width: 760, height: 0.85, props: { terminal: h.address, title: h.label } });
          } }))));
  }

  // ---- the box ----------------------------------------------------------------------------------

  composer(t, cx) {
    if (this.readOnly) return div().id("collie-chat-foot").px(24).py(8).text_size(11).text_color(t.dim).child(WORDS.readOnly);
    const can = this.phase !== "starting" && this.phase !== "ended";
    const pick = can ? this.pickShown() : null;
    const list = can ? this.suggestions(cx) : [];
    const sel = Math.min(this.slashSel, Math.max(0, list.length - 1));
    return v_flex().id("collie-chat-box").w_full().px(16).py(10).gap(6).border_t(1).border_color(t.border)
      .child(div().w_full().rounded(RADIUS.card).border_1().border_color(t.border).bg(t.raised).overflow_hidden()
        .when(list.length > 0, (el) => el.child(this.slashList(t, list, sel, cx)))
        .when(this.files.length > 0, (el) => el.child(this.tiles(t, cx)))
        .child(div().px(10).py(6).child(Textarea.new(this.box).w_full().text_size(13).text_color(t.foreground)))
        // A drop anywhere on the field takes its files, as a paste does.
        .on_drop((e, cx) => this.dropFiles(e.paths ?? [], cx))
        .on_key_down((e, cx) => this.boxKey(e, cx, list, sel)))
      .child(h_flex().w_full().items_center().gap(8)
        .child(button("collie-chat-attach", "", { kind: "plain", icon: "mods/collie-chat/plus.svg",
          onClick: (_e, cx) => this.pickFiles(cx) }))
        .child(div().flex_1())
        .when(Boolean(pick?.agent), (el) => el.child(this.pickButton(t, cx)))
        .when(can, (el) => el.child(button("collie-chat-send", "Send", { kind: "primary", onClick: (_e, cx) => this.enter(cx, false) }))));
  }

  // The box's own keys: the "/" list's Up / Down / Tab / Escape, then Enter sending (Shift+Enter a new line).
  boxKey(e, cx, list, sel) {
    const k = e.key, m = e.modifiers ?? {};
    if (list.length) {
      const n = list.length;
      if (k === "down" || k === "up") { this.slashSel = (sel + (k === "down" ? 1 : n - 1)) % n; cx.stop_propagation(); cx.notify(); return; }
      if (k === "tab") { cx.stop_propagation(); this.pick(list[sel], cx); return; }
      if (k === "escape") { this.slashOff = this.box.value().replace(/\n+$/, ""); cx.stop_propagation(); cx.notify(); return; }
    }
    if (k !== "enter" || m.shift) return;
    cx.stop_propagation();
    this.enter(cx, Boolean(m.control || m.platform));
  }

  // What the "/" and "#" lists offer for the box, in their order: spaces (#) first, then the agent's commands (/).
  suggestions(cx) {
    const v = this.box.value().replace(/\n+$/, "");
    // The spaces "#" lists are the agent's machine's: read from its reach map once per machine.
    if (this.reachFor !== this.machine) {
      this.reachFor = this.machine;
      this.reach = null;
      cx.spawn(async (cx) => this.loadReach(cx));
    }
    const kind = this.slashKind();
    // The commands of the CLI behind the box: its own, plus the person's from its machine (core/slash.js).
    if (kind && this.cmdsFor !== kind) {
      this.cmdsFor = kind;
      cx.spawn(async (cx) => this.loadCmds(kind, cx));
    }
    if (this.slashOff === v) return [];
    const h = mentions.typing(v);
    if (h !== null) {
      const sp = mentions.match(this.reach?.spaces ?? [], h.toLowerCase())
        .map((x) => ({ space: x, name: `#${x.name}`, about: x.route ? x.machine : "This machine", key: `space-${x.id}` }));
      if (sp.length) return sp;
    }
    const w = slash.typing(v);
    if (w === null || !this.cmds.length) return [];
    return slash.match(this.cmds, w);
  }

  // Which CLI's commands: the running agent's, else the one the first message will start.
  slashKind() {
    return this.kind ?? (this.pick?.agent === "codex" ? "codex" : this.pick?.agent === "claude" ? "claude" : null);
  }

  async loadCmds(kind, cx) {
    const on = this.machine ? { on: this.machine } : {};
    const cwd = props()?.folder ?? this.slotRec()?.folder ?? "";
    const mine = kind === "claude"
      ? slash.scanned((await exec("sh", ["-c", slash.SCAN, "scan", cwd], on).catch(() => null))?.stdout)
      : [];
    if (this.slashKind() !== kind) return;
    this.cmds = slash.commandList(kind, mine);
    cx.notify();
  }

  // A pick from the "/" list: a space's short form in the box (its token goes in at send), or a command.
  pick(c, cx) {
    if (c.space) {
      const next = mentions.pickInto(this.box.value(), c.space);
      this.picked = [...this.picked.filter((x) => x.name !== c.space.name), c.space];
      this.box.set_value(next);
      this.slashOff = next.replace(/\n+$/, "");
    } else {
      this.box.set_value(`/${c.name} `);
      this.slashOff = `/${c.name} `;
    }
    this.slashSel = 0;
    this.box.focus();
    this.saveSoon(cx);
    cx.notify();
  }

  // The "/" list: the agent's commands, or the spaces "#" reaches, that match what is typed.
  slashList(t, list, sel, cx) {
    return v_flex().id("collie-chat-slash").w_full().p(4).gap(1).border_b(1).border_color(t.border)
      .children(list.map((c, i) => h_flex().id(`slash-${c.key ?? c.name}`).h(26).flex_none().px(8).gap(10).items_center()
        .rounded(RADIUS.control).cursor_pointer()
        .when(i === sel, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.pick(c, cx); })
        .child(div().flex_none().text_size(TEXT.label).font_medium().text_color(t.foreground)
          .child(c.space ? c.name : `/${c.name}`))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.id).text_color(t.dim).child(c.about))));
  }

  // Files waiting to go: small tiles above the box, each removable; an image shows itself, a file its name.
  tiles(t, cx) {
    const imgs = this.files.filter((x) => x.image).map((x) => x.path);
    return h_flex().id("collie-chat-tiles").w_full().flex_wrap().gap(attach.THUMB_GAP).px(10).pt(8)
      .children(this.files.map((f, i) => {
        const tile = f.image
          ? this.thumb(t, f.path).id(`collie-chat-file-${i}`).cursor_pointer()
            .on_click((_e, cx) => { cx.stop_propagation(); this.openImages(imgs, imgs.indexOf(f.path)); })
          : v_flex().id(`collie-chat-file-${i}`).size(attach.THUMB).flex_none().px(4).gap(3).items_center().justify_center()
            .rounded(RADIUS.card).border_1().border_color(t.border).bg(t.background)
            // A pasted text opens to read.
            .when(Boolean(f.text), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); this.openText(f); }))
            .child(svg("mods/collie-chat/file.svg").size(16).flex_none().text_color(t.dim))
            .child(div().w_full().text_center().truncate().text_size(10).text_color(t.muted).child(f.name));
        return div().relative().flex_none().child(tile)
          .child(div().id(`collie-chat-file-x-${i}`).absolute().top(-6).right(-6).size(18).flex().items_center().justify_center()
            .rounded(9).cursor_pointer().bg(t.popover).border_1().border_color(t.border).text_color(t.muted)
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              attach.drop(f);
              this.files = this.files.filter((x) => x !== f);
              this.saveSoon(cx);
              cx.notify();
            })
            .child(svg("mods/collie-chat/x.svg").size(10)));
      }));
  }

  // An image as a tile-sized square, cropped to fill it (attach.cover); a quiet square until its size is known.
  thumb(t, path) {
    const v = this.views[path];
    const box = div().relative().size(attach.THUMB).flex_none().rounded(RADIUS.card).overflow_hidden().bg(t.raised);
    const edge = div().absolute().inset_0().rounded(RADIUS.card).border_1().border_color(t.border);
    if (!v) return box.child(edge);
    const c = attach.cover(v.w, v.h, attach.THUMB);
    return box.child(image(v.rel).absolute().left(c.left).top(c.top).w(c.w).h(c.h)).child(edge);
  }

  // Images under a sent message: each whole, its shape kept, fitted together in the row (attach.fitThumbs).
  thumbs(t, paths, id, cx, { faded = false } = {}) {
    const fit = attach.fitThumbs(paths.map((p) => this.views[p] ?? null), 520);
    return h_flex().id(`thumbs-${id}`).gap(attach.THUMB_GAP).items_end().justify_end()
      .when(faded, (el) => el.opacity(0.55))
      .children(fit.boxes.map((b, i) => {
        const v = this.views[paths[i]];
        return div().relative().w(b.w).h(b.h).flex_none().rounded(RADIUS.card).overflow_hidden().bg(t.raised).cursor_pointer()
          .on_click((_e, cx) => { cx.stop_propagation(); this.openImages(paths, i); })
          .when(Boolean(v), (el) => el.child(image(v.rel).size_full()))
          .child(div().absolute().inset_0().rounded(RADIUS.card).border_1().border_color(t.border));
      }));
  }

  // The images the chat shows, linked where image() can load them, with their sizes. Asked once each.
  needViews(paths, cx) {
    const want = [...new Set(paths)].filter((p) => p && !this.views[p] && !this.viewAsked.has(p));
    if (!want.length) return;
    for (const p of want) this.viewAsked.add(p);
    // Asked from render: start it right after.
    cx.timer.after(0, (cx) => cx.spawn(async (cx) => {
      Object.assign(this.views, await attach.viewable(want));
      cx.notify();
    }));
  }

  // The viewer (viewer.js) on these images, from the i-th.
  openImages(paths, i) {
    const all = paths.map((p) => (this.views[p] ? { ...this.views[p], name: attach.base(p), path: p } : null));
    const images = all.filter(Boolean);
    if (!images.length) return;
    i = images.indexOf(all[i] ?? images[0]);
    openOverlay({ mod: "collie-chat", kind: "popup", frame: "none", width: VIEW.width, height: VIEW.height, at: "pointer",
      props: { viewer: { images, index: Math.max(0, Math.min(images.length - 1, i)) } } });
  }

  // A pasted text file in the viewer (viewer.js), over the chat.
  openText(f) {
    openOverlay({ mod: "collie-chat", kind: "popup", frame: "none", width: VIEW.width, height: VIEW.height, at: "pointer",
      props: { viewer: { textPath: f.path, title: f.name } } });
  }

  // The desktop's own file picker (pick-files.py: macOS's panel, else xdg-desktop-portal): the chosen files join the
  // message as tiles, as a drop or a paste makes them.
  pickFiles(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'P=/usr/bin/python3; [ -x "$P" ] || P=python3; exec "$P" -I "$1"',
        "x", `${appHome()}/mods/collie-chat/pick-files.py`]).catch(() => null);
      const list = (r?.stdout ?? "").split("\n").filter(Boolean);
      if (r && r.code !== 0) toast({ title: "Couldn't open the file picker", level: "error" });
      if (!list.length) { cx.notify(); return; }
      this.addFiles(attach.paths(list));
      this.saveSoon(cx);
      this.box.focus();
      cx.notify();
    });
  }

  // Dropped or pasted paths join the box's files (the same path twice: once).
  dropFiles(list, cx) {
    this.addFiles(attach.paths(list));
    this.saveSoon(cx);
    this.box.focus();
    cx.notify();
  }

  addFiles(list) {
    for (const f of list) if (!this.files.some((x) => x.path === f.path)) this.files.push(f);
    this.files = this.files.slice(0, 20);
  }

  // The box changed: a big paste (over 8 KB or 200 lines) becomes a text file to send; copied files pasted as text
  // (file:// lines) become attachments; a new value closes the "/" list's selection reset.
  boxChanged(cx) {
    const was = this.lastValue ?? "", now = this.box.value();
    this.lastValue = now;
    if (now.length - was.length > 8192 || now.split("\n").length - was.split("\n").length > 200) {
      let a = 0;
      while (a < was.length && was[a] === now[a]) a++;
      let b = 0;
      while (b < was.length - a && was[was.length - 1 - b] === now[now.length - 1 - b]) b++;
      const pasted = now.slice(a, now.length - b);
      const rest = was.slice(0, a) + was.slice(was.length - b);
      this.box.set_value(rest);
      this.lastValue = rest;
      cx.spawn(async (cx) => {
        const f = await attach.textFile(pasted);
        if (f) { this.addFiles([f]); this.saveSoon(cx); cx.notify(); }
      });
      return;
    }
    // Copied files pasted as text (file:// lines) become attachments.
    const v = this.box.value();
    if (/^file:\/\/\S/m.test(v)) {
      const found = v.split("\n").filter((l) => /^file:\/\/\S+$/.test(l.trim())).map((l) => decodeURIComponent(l.trim().slice(7)));
      this.addFiles(attach.paths(found));
      const rest = v.split("\n").filter((l) => !/^file:\/\/\S+$/.test(l.trim())).join("\n");
      this.box.set_value(rest);
      this.lastValue = rest;
    }
    this.slashSel = 0;
    this.saveSoon(cx);
    cx.notify();
  }

  // ---- drafts -----------------------------------------------------------------------------------

  // The box's words, its files and its held messages, as the last chat left them.
  async loadDraft(cx) {
    const text = await readTextFile(this.draftFile).catch(() => null);
    let d = null;
    try { d = JSON.parse(text ?? "null"); } catch {}
    if (!d) return;
    if (d.text && !this.box.value()) { this.box.set_value(d.text); this.lastValue = d.text; }
    this.files = Array.isArray(d.files) ? d.files : [];
    this.queue = Array.isArray(d.queue) ? d.queue : [];
    cx.notify();
  }

  // Saved 400 ms after the last change, and only once (a burst of keystrokes writes one draft).
  saveSoon(cx) {
    this.saveAt = Date.now();
    cx.timer.after(400, (cx) => { if (Date.now() - this.saveAt >= 380) cx.spawn(async () => this.saveDraft()); });
  }

  async saveDraft() {
    const d = { text: this.box.value(), files: this.files, queue: this.queue };
    const empty = !String(d.text ?? "").trim() && !d.files.length && !d.queue.length;
    try {
      if (empty) { await exec("rm", ["-f", this.draftFile]); return; }
      await exec("mkdir", ["-p", `${appHome()}/data/chat-drafts`]);
      await writeTextFile(this.draftFile, JSON.stringify(d), null);
    } catch {}
  }

  // The spaces the agent's machine reaches, from its herdr-task reach map (what tell-assistant follows); none there
  // yet: the spaces on its own machine (core/mentions.js local()).
  async loadReach(cx) {
    const r = await exec("sh", ["-c", mentions.REACH_FILE], { on: this.machine }).catch(() => null);
    let graph = null;
    try { graph = JSON.parse(r?.stdout || "null")?.graph ?? null; } catch {}
    this.reach = { from: graph?.core?.name ?? this.machine,
      spaces: graph ? mentions.reachable(graph) : mentions.local(spaces(), this.machine) };
    cx.notify();
  }

  // A message's words with each #-mention in plain markdown: its name and machine, and "out of reach" when this
  // agent can't reach that space (the window's chat draws no chips).
  mentionsIn(text) {
    if (!mentions.hasMention(text)) return text;
    const ids = this.reach ? new Set(this.reach.spaces.map((x) => x.id)) : null;
    const by = new Map((this.reach?.spaces ?? []).map((x) => [x.id, x.machine]));
    return mentions.plain(text, ids, (m) => by.get(m.id));
  }

  // Enter: now (while the agent works, the CLI takes it mid-turn). Ctrl+Enter while it works: held here, sent once it
  // is free. The box's files go with the message (their paths, after the words); a picked #space becomes its token.
  enter(cx, hold) {
    const text = mentions.expand(this.box.value().trim(), this.picked);
    const files = this.files;
    if (!text && !files.length) return;
    this.box.set_value("");
    this.lastValue = "";
    this.files = [];
    this.picked = [];
    this.slashOff = null;
    this.slashSel = 0;
    this.saveSoon(cx);
    const msg = { id: `m${Date.now()}`, text, at: Date.now(), files };
    if (hold && this.status() === "working") {
      this.queue.push(msg);
      cx.notify();
      return;
    }
    this.send(msg, cx);
  }

  send(msg, cx) {
    this.pinned = true;
    if (this.phase === "fresh") { this.startAgent(msg, cx); return; }
    // The CLI shows its own start screen (a card here): typed words could pick one of its choices, so they wait
    // until it is answered (drainQueueNow).
    if (this.addr && openScreen(this.addr)) { this.queue.push(msg); cx.notify(); return; }
    // A card asks (a question, a permission, a plan): the words answer it, as typing in the CLI would.
    if (!msg.raw && this.asks.length && msg.text && !msg.files?.length) { this.cards.replyWith(this.asks[0], msg.text, cx); return; }
    if (this.phase !== "ready") { this.queue.push(msg); cx.notify(); return; }
    // A reaction's or a secret's line goes as it is, and is never shown as a message of the person's or awaited in the
    // log (no pending row): the log's own slot says what became of it.
    if (msg.raw) {
      cx.spawn(async (cx) => {
        const r = await sendBody(this.io(cx), this.addr, this.kind, msg.text).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
        if (r.code !== 0) {
          // Not retried on its own (a reaction that never lands is not worth a loop): one quiet line says so.
          this.note = notSent(refusal(r).message);
          cx.timer.after(6000, (cx) => { this.note = null; cx.notify(); });
          cx.notify();
        }
      });
      return;
    }
    // The person's words get their reply tag.
    const body = messageBody({ text: msg.text });
    // A command with its own menu in the CLI: after sending, show it where it works (the terminal).
    const menu = msg.files?.length ? null : slash.opensMenu(this.kind, msg.text);
    const p = { id: `pending-${msg.id}`, text: msg.text, at: Date.now(), sent: body, match: norm(msg.text).slice(0, 60) || null,
      files: names(msg.files), paths: imagePaths(msg.files) };
    this.pending.push(p);
    if (menu) this.note = `/${menu} opens a menu in the terminal. Switching to it.`;
    cx.spawn(async (cx) => {
      let r;
      try {
        // Here: the file's own path. On another machine: hc put lands a copy beside the agent, and that path goes.
        const paths = await attach.deliver(msg.files, this.addr, this.machine);
        p.sent = messageText(body, paths);
        r = await sendBody(this.io(cx), this.addr, this.kind, p.sent);
      } catch (e) {
        r = { code: 1, stderr: String(e?.message ?? e) };
      }
      if (r.code !== 0) { p.failed = refusal(r).message; cx.notify(); return; }
      p.delivered = true;
      cx.notify();
      if (menu) {
        await cx.sleep(900);
        this.pending = this.pending.filter((x) => x !== p);
        this.note = null;
        this.toTerminal();
        cx.notify();
        return;
      }
      for (let i = 0; i < 60 && this.pending.includes(p) && !p.failed; i++) {
        await cx.sleep(i ? 5000 : 20000);
        if (this.status() !== "working") { p.late = true; cx.notify(); break; }
      }
      cx.notify();
    });
  }

  // What core/send.js needs from here: hc (as the person), a sleep, the agent's status now.
  io(cx) {
    return { hc: personHc, sleep: (ms) => cx.sleep(ms), status: () => this.status() };
  }

  status() {
    const k = terminals().find((x) => x.address === this.addr);
    return ["working", "blocked", "done", "idle"].includes(k?.status) ? k.status : null;
  }

  working() {
    return this.phase !== "fresh" && this.phase !== "ended" && (this.status() === "working" || this.pending.some((p) => !p.failed));
  }

  // Stop: the CLI's own interrupt. The working line says "Stopping…" until it is idle.
  stop(cx) {
    if (this.status() !== "working") return;
    this.stopping = true;
    hc(["interrupt", this.addr]);
    cx.notify();
  }

  // ---- what the agent asks (ask-hook.sh, data/chat-asks) --------------------------------------

  cliName() {
    const k = terminals().find((x) => x.address === this.addr);
    const kind = KINDS[k?.status?.app] ?? KINDS[k?.foreground?.name] ?? this.kind;
    return kind === "codex" ? "Codex" : "Claude";
  }

  // The hook's flag: this chat is showing. Touched every few seconds; stale after 15.
  async flag() {
    if (this.machine || !this.addr || this.readOnly || this.phase === "ended") return;
    await exec("sh", ["-c", 'mkdir -p "$1/open" "$1/req" "$1/ans" "$1/end" && touch "$1/open/$2"', "x", this.askDir, this.addr]).catch(() => {});
  }

  async watchAsks(cx) {
    await exec("sh", ["-c", 'mkdir -p "$1/open" "$1/req" "$1/ans" "$1/end"', "x", this.askDir]).catch(() => {});
    for (;;) {
      if (this.addr && !this.readOnly) {
        await this.flag();
        await this.readAsks(cx).catch(() => {});
      }
      // One watch at a time, as for the log.
      this.askWatch ??= watchFolder(`${this.askDir}/req`).catch(() => null).finally(() => { this.askWatch = null; });
      await Promise.race([this.askWatch, cx.sleep(4000)]);
    }
  }

  async readAsks(cx) {
    const addr = this.addr;
    if (!addr) return;
    // Each request is named <terminal>.<time>.<hook pid>: one whose hook was killed (Claude stopped it) is gone, so
    // drop its file.
    const r = await exec("sh", ["-c", 'cd "$1/req" 2>/dev/null || exit 0; for f in "$2".*.json; do [ -f "$f" ] || continue; p=${f%.json}; p=${p##*.}; if kill -0 "$p" 2>/dev/null; then echo "$f"; else rm -f "$f"; fi; done; true', "x", this.askDir, addr]);
    if (addr !== this.addr) return;
    const ids = r.stdout.split("\n").filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    const kept = this.asks.filter((a) => ids.includes(a.id));
    // Gone without an answer from here: the hook says how (end/<id>: answered or declined in the terminal, the agent
    // stopped), else Claude stopped waiting on it.
    for (const a of this.asks.filter((a) => !ids.includes(a.id))) {
      const how = (await readTextFile(`${this.askDir}/end/${a.id}`).catch(() => null))?.trim();
      this.askEnded(a, how || "No longer waiting");
    }
    let added = false;
    for (const id of ids) {
      if (kept.some((a) => a.id === id)) continue;
      const text = await readTextFile(`${this.askDir}/req/${id}.json`).catch(() => null);
      let req = null;
      try { req = JSON.parse(text ?? ""); } catch {}
      // Unreadable here: it can only be allowed in the terminal.
      const w = req ? askWords(req) : { kind: "permission", title: "Claude asks for something the chat can't read", detail: "", unread: true };
      kept.push({ id, req, words: w });
      added = true;
    }
    if (added || kept.length !== this.asks.length) {
      this.asks = kept;
      this.cards.keep(kept.map((a) => a.id));
      cx.notify();
    }
  }

  // An ask closed: its quiet line (a question's own row is already in the log).
  askEnded(ask, how) {
    if (ask.words?.kind === "questions" || this.askEnds.some((e) => e.id === ask.id)) return;
    this.askEnds = [...this.askEnds, { id: ask.id, title: ask.words?.title ?? "Claude asks", how, at: askAt(ask.id) }].slice(-20);
  }

  // The card's answer goes to the waiting hook; it prints it as Claude's decision.
  reply(ask, text, cx) {
    this.asks = this.asks.filter((a) => a !== ask);
    const how = howAnswered(ask, text, "in the chat");
    if (how) this.askEnded(ask, how);
    this.cards.drop(ask);
    cx.notify();
    cx.spawn(async () => {
      if (how) await writeTextFile(`${this.askDir}/end/${ask.id}`, `${how}\n`, null).catch(() => {});
      await writeTextFile(`${this.askDir}/ans/${ask.id}.json`, text, null).catch(() => {});
    });
  }

  // The agent's terminal, for "Answer in terminal": a peek over the tab (the chat has no pane of its own for it).
  toTerminal() {
    if (this.addr) run("terminal.peek", { terminal: this.addr });
  }

  // ---- a CLI's own start screen (screens.js) ---------------------------------------------------

  async screenTick(cx) {
    if (!this.addr || this.readOnly) return;
    const k = terminals().find((x) => x.address === this.addr);
    if (!k || k.state !== "live") return;
    if (!starting(k) && !openScreen(this.addr)) return;
    await this.screens.tick(this.addr, k).catch(() => {});
    cx.notify();
  }

  // A press on one of the screen's choices: only if the screen still shows what the card was drawn from.
  async pressScreen(card, i, cx) {
    if (this.screenBusy.has(card.id)) return;
    this.screenBusy.add(card.id);
    this.screenErr.delete(card.id);
    cx.notify();
    const why = await this.screens.press(card, i).catch((e) => String(e?.message ?? e));
    this.screenBusy.delete(card.id);
    if (why) this.screenErr.set(card.id, why);
    cx.notify();
  }

  // ---- this chat's pane and slot ----------------------------------------------------------------

  // This chat's record from mods/collie-tabs' shared "coordinator.slots": { space, tab, pane, folder }.
  slotRec() {
    return this.slot ? shared("coordinator.slots")?.[this.slot] ?? null : null;
  }

  // The pane this chat shows in: its slot's, else the only collie-chat pane in its tab.
  myPane() {
    const rec = this.slotRec();
    if (rec?.pane && panes().some((p) => p.pane === rec.pane)) return rec.pane;
    const tab = rec?.tab ?? null;
    const free = panes().filter((p) => p.mod === "collie-chat" && (!tab || p.tab === tab));
    return free.length === 1 ? free[0].pane : null;
  }

  // This slot's live agent, if one was started (herdr.chat.slot).
  slotAgent() {
    if (!this.slot) return null;
    return terminals().find((x) => x.state === "live" && x.labels?.["herdr.chat.slot"] === this.slot)?.address ?? null;
  }

  // An empty slot chat whose agent is running after all: follow it, as if found at the start.
  adoptSlot(cx) {
    if (this.addr || this.phase !== "fresh") return;
    const a = this.slotAgent();
    if (!a) return;
    this.addr = a;
    this.machine = a.includes("/") ? a.split("/")[0] : null;
    this.path = null;
    this.reset();
    this.phase = "finding";
    cx.spawn(async (cx) => this.follow(cx));
    cx.notify();
  }

  // ---- starting the agent -----------------------------------------------------------------------

  // The first message starts the agent (its template), parked behind this chat, with the message as its task; then the
  // chat follows it as usual.
  startAgent(msg, cx, thenTerminal = false) {
    const pane = this.myPane();
    if (!pane) {
      toast({ title: "Couldn't start the Coordinator", body: "This chat hasn't found its pane. Try again in a moment.", level: "error" });
      return;
    }
    const rec = this.slotRec();
    const space = spaces().find((x) => x.id === (props()?.space ?? rec?.space));
    // A space on another machine starts its agent there (the pane's ids are that machine's).
    const machine = space?.machine ?? null;
    const folder = props()?.folder ?? rec?.folder ?? space?.folder ?? null;
    const template = props()?.template ?? this.template;
    // Files here go as their paths; on another machine they follow once it runs (hc put needs its address).
    const local = machine || !msg ? [] : (msg.files ?? []).map((f) => f.path);
    const task = msg ? messageText(msg.text, local) : "";
    const p = msg ? { id: `pending-${msg.id}`, text: msg.text, at: msg.at, sent: task, match: norm(msg.text).slice(0, 60) || null,
      files: names(msg.files), paths: imagePaths(msg.files) } : { failed: null };
    if (msg) this.pending.push(p);
    this.phase = "starting";
    this.turnStarted = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      // Every start goes through a one-off template (as Shepherdr did): its command first clears a parent Claude Code
      // session's markers the holder may carry (core/clean-env.js), then execs the agent. hc runs a template's command
      // under sh -c, and where sh is dash the shell would stay the terminal's program.
      let launch = template, oneOff = null, words = "";
      // The pick the chat's menu made (the last chat's saved choice, else props.settings, is its first one): the
      // template's command gives way to the chosen agent's argv ("default" = the agent's own model: no --model flag).
      if (this.pickReady) await this.pickReady;
      const pick = this.pick?.agent ? this.pick : asPick(props()?.settings);
      const on = machine ? { on: machine } : {};
      const src = (await exec("sh", ["-c", TEMPLATE + 'cat "$dir/$1.md"', "x", template], on).catch(() => null))?.stdout ?? "";
      const { body, command } = parseTemplate(src);
      const cmd = pick ? argvFor(pick, { agent: null, argv: [] }).argv.map(shellWord).join(" ") : command;
      if (pick) this.savePick();
      if (body && cmd) {
        words = body;
        oneOff = `collie-coordinator-${Date.now().toString(36)}`;
        const file = `---\nname: ${oneOff}\ndescription: A one-off Coordinator start with chosen settings (mods/collie-chat), removed after use.\ncommand: ${cleanCommand(cmd)}\n---\n${body}`;
        await exec("sh", ["-c", TEMPLATE + 'printf "%s" "$2" > "$dir/$1.md"', "x", oneOff, file], on);
        launch = oneOff;
      }
      const args = ["run", "--bg", "--json", "--no-parent", "--keep", ...(machine ? ["--on", machine] : []),
        ...(folder ? ["--cwd", folder] : []),
        "--label", `herdr.chat=${chatLabel(pane)}`, "--label", `herdr.chat.slot=${this.slot}`, "--label", `herdr.chat.origin=slot:${this.slot}`,
        "--label", `herdr.role=${this.role ?? "coordinator"}`, ...(pick ? ["--label", `herdr.agent=${pick.agent}`] : []),
        ...(space ? ["--label", `herdr.coordinator.space=${String(space.id).split("/").pop()}`] : []),
        ...(rec?.tab ? ["--label", `herdr.coordinator.tab=${String(rec.tab).split("/").pop()}`] : []),
        launch, ...(task ? [task] : [])];
      const r = await hc(args).catch((e) => ({ code: 1, stderr: String(e?.message ?? e), stdout: "" }));
      if (oneOff) exec("sh", ["-c", TEMPLATE + 'rm -f "$dir/$1.md"', "x", oneOff], on);
      let out = {};
      try { out = JSON.parse(r.stdout || "{}"); } catch {}
      // hc waits to hand the agent its first message and gives up while the CLI shows a screen of its own (trust this
      // folder): hc took too long, but the agent runs. Then this chat sends the template's words and the task itself
      // once the agent is idle past that screen (follow()).
      const late = (r.code !== 0 || !out.address) && this.slotAgent();
      if (late) out = { address: late, first_message: { sent: false } };
      if (out.address && out.first_message?.sent === false && words) this.firstSend = [words, task].filter(Boolean).join("\n\n");
      if ((r.code !== 0 && !late) || !out.address) {
        p.failed = (r.stderr || r.stdout || "It didn't start.").trim();
        // No message (the pane header's Terminal): the person sees nothing under it, so say it as a toast.
        if (!msg) toast({ title: "The Coordinator didn't start", body: p.failed, level: "error" });
        this.phase = "fresh";
        cx.notify();
        return;
      }
      // Remember what the person asked: the agent's first message is the template's words with it.
      if (msg) {
        const dir = `${appHome()}/data/chat-first`;
        const name = firstKeys({ slot: this.slot, origin: `slot:${this.slot}` })[0];
        exec("sh", ["-c", 'mkdir -p "$1" && printf "%s" "$3" > "$1/$2.txt"', "x", dir, name, msg.text]).catch(() => null);
      }
      this.addr = machine && !String(out.address).includes("/") ? `${machine}/${out.address}` : out.address;
      this.machine = this.addr.includes("/") ? this.addr.split("/")[0] : null;
      this.phase = "finding";
      this.turnStarted = Date.now();
      // On another machine: the files land there once the agent runs, then their paths go as a message of their own.
      if (machine && msg?.files?.length) {
        cx.spawn(async () => {
          const paths = await attach.deliver(msg.files, this.addr, this.machine).catch(() => []);
          if (paths.length) await personHc(["send", this.addr, paths.join("\n")]).catch(() => null);
        });
      }
      // The spaces "#" lists are that machine's now (suggestions() reloads them).
      cx.spawn(async (cx) => this.follow(cx));
      cx.notify();
      // From the pane header's Terminal: show its terminal once it runs (the usual Chat → Terminal).
      if (thenTerminal) {
        for (let i = 0; i < 40 && terminals().find((k) => k.address === this.addr)?.state !== "live"; i++) await cx.sleep(250);
        const mine = this.myPane();
        if (mine) { run("pane.focus", { pane: mine }); run("collie-pane-chat.toggle"); }
      }
    });
  }

  // The pane header's Terminal on a chat with no agent yet (mods/collie-pane-chat): start the agent, then show its
  // terminal. Shared "collie-chat.startreq" = { pane, at }; only this chat's pane, once (5 s), and only when fresh.
  startRequest(cx) {
    const req = shared("collie-chat.startreq");
    const mine = this.myPane();
    if (!req || !mine || req.pane !== mine || req.at === this.startReqAt || !(Date.now() - req.at < 5000) || this.phase !== "fresh") return;
    this.startReqAt = req.at;
    cx.timer.after(0, (cx) => { this.startAgent(null, cx, true); });
  }

  // ---- what the agent starts on, and restarting it (the model menu, picker.js) ------------------

  // Collie's own settings, where the chat's choice lives (never Shepherdr's).
  coordinatorPath() {
    return `${home()}/.local/state/collie/coordinator.json`;
  }

  // The choice before the first message: the last chat's, from Collie's settings (coordinator.json "chat"), else
  // props.settings (the Coordinator's configured CLI, from openCoordinator); fit to what this machine's CLIs offer,
  // else their defaults. As in shepherdr, the choice the person last made wins over the settings it opened with.
  async loadPick(cx) {
    const text = await readTextFile(this.coordinatorPath()).catch(() => null);
    let saved = null;
    try { saved = chatPick(JSON.parse(text ?? "{}")); } catch { saved = null; }
    const want = saved ?? asPick(props()?.settings);
    const space = spaces().find((x) => x.id === (props()?.space ?? this.slotRec()?.space));
    const machine = this.machine ?? space?.machine ?? null;
    try {
      const data = await loadChoices(machine, want?.agent ? { [want.agent]: want.model } : {});
      this.menus = data.menus;
      this.dflt = data.dflts ?? {};
      this.pick = fitPick(data.menus, want ?? data.defaults, data.permDefault);
    } catch {
      this.pick = want ?? { agent: "claude", model: null, effort: null, fast: false, perm: "manual" };
    }
    cx.notify();
  }

  // The chat's choice goes into Collie's settings' "chat" field, so the next coordinator chat starts from it; the rest
  // of the file (the headless coordinator's everywhere.coordinator) stays as it was.
  savePick() {
    if (this.readOnly || !this.pick?.agent) return;
    const pick = { ...this.pick };
    (async () => {
      const path = this.coordinatorPath();
      const text = await readTextFile(path).catch(() => null);
      await writeTextFile(path, withChatPickText(text, pick), text).catch(() => null);
    })();
  }

  // What the running agent is on, from its arguments and its log (core/agents.js current).
  currentPick() {
    if (!this.addr || !this.kind) return this.pick;
    const k = terminals().find((x) => x.address === this.addr);
    const kind = cliOf(k) ?? this.kind;
    const c = currentOf(kind, k?.foreground?.argv ?? k?.argv ?? [], this.conv?.meta ?? {}, this.dflt?.[kind] ?? {});
    return { agent: c.agent, model: c.model ?? null, effort: c.effort ?? null, fast: Boolean(c.fast), perm: c.perm ?? null };
  }

  // What the menu opens on: the choice before the first message, else what the agent runs on now (once its CLI is
  // known: until then the chat doesn't know what to show or restart).
  pickShown() {
    if (this.phase === "fresh") return this.pick?.agent ? this.pick : null;
    return this.kind ? this.currentPick() : null;
  }

  // The pick button: what the agent runs on (or starts on), opening the menu above it.
  pickButton(t, cx) {
    const c = this.pickShown();
    return h_flex().id("collie-chat-pick-button").h(H.sm).max_w(240).flex_none().pl(8).pr(5).gap(4).items_center()
      .rounded(RADIUS.control).border_1().border_color(t.input).bg(t.background)
      .text_size(TEXT.label).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (e) => { this.pickAtPos = e.position; })
      .on_click((_e, cx) => { cx.stop_propagation(); this.openPicker(this.pickAtPos, cx); })
      .child(div().min_w(0).truncate().child(line(c, this.menus) || "Agent"))
      .child(svg("mods/collie-chrome/chevron-down.svg").size(12).flex_none().text_color(t.dim));
  }

  // The model menu, this mod in an overlay above the button (picker.js). Its answers come back through shared
  // "collie-chat.pick" (before the first message) or "collie-chat.restartreq" (Restart).
  openPicker(at, cx) {
    const pane = this.myPane();
    const c = this.pickShown();
    if (!pane || !c?.agent) return;
    openOverlay({ mod: "collie-chat", kind: "popup", frame: "none", width: PICK.width, height: PICK.height,
      at: at ? { x: Math.max(8, at.x - PICK.width + 90), y: Math.max(8, at.y - PICK.height - 10) } : "pointer",
      props: { picker: { mode: this.phase === "fresh" ? "fresh" : "restart", pane, machine: this.machine, current: { ...c } } } });
  }

  // The menu's answers, once each: a pick before the first message (kept, and saved for the next chat), or Restart.
  // Only this chat's pane's, and only for 5 s (an older request is another chat's).
  pickTicks(cx) {
    const mine = this.myPane();
    if (!mine) return;
    const p = shared("collie-chat.pick");
    if (p && p.pane === mine && p.at !== this.pickReqAt && Date.now() - p.at < 5000) {
      this.pickReqAt = p.at;
      if (this.phase === "fresh" && p.pick?.agent && !samePick(this.pick, p.pick)) {
        this.pick = { ...p.pick };
        this.savePick();
        cx.notify();
      }
    }
    const rr = shared("collie-chat.restartreq");
    if (rr && rr.pane === mine && rr.at !== this.restartReqAt && Date.now() - rr.at < 5000) {
      this.restartReqAt = rr.at;
      cx.timer.after(0, (cx) => this.applyPick(rr.pick, cx));
    }
  }

  // Restart with the menu's choice: collie-tabs/bin/restart.sh starts the new agent parked behind this chat (the same
  // herdr.chat, herdr.chat.slot, herdr.role and herdr.coordinator.* labels), resuming when the agent stays the same,
  // else with a handoff; this chat follows it.
  applyPick(pick, cx) {
    if (this.restarting || !this.addr || !pick?.agent || this.phase === "fresh") return;
    const pane = this.myPane();
    if (!pane) return;
    this.restarting = true;
    cx.spawn(async (cx) => {
      try {
        const out = await hc(["get", this.addr, "--json"]).catch(() => null);
        let t = null;
        try { t = JSON.parse(out?.stdout || "null"); } catch {}
        if (!t?.address) throw new Error("This chat's agent wasn't found.");
        const kind = cliOf(t) ?? this.kind ?? pick.agent;
        const built = argvFor(pick, { agent: kind, argv: t.foreground?.argv ?? [], session: sessionOf(kind, this.path) });
        this.swapping = true;
        const next = await this.restartAgent(t, built, pane);
        this.followTo(next);
        // The choice now also starts the next conversation, as the menu's picks do.
        this.pick = { ...pick };
        this.savePick();
        this.note = built.resume ? "Restarted. The conversation continues." : `Started ${NAMES[pick.agent] ?? pick.agent} with a handoff.`;
        cx.timer.after(6000, (cx) => { this.note = null; cx.notify(); });
      } catch (e) {
        toast({ title: "The agent didn't restart", body: plainError(e), level: "error" });
      }
      this.swapping = false;
      this.restarting = false;
      cx.notify();
    });
  }

  // A new agent for this chat, through mods/collie-tabs/bin/restart.sh: HERDR_RESTART_CHAT names the chat pane it starts
  // parked behind (its herdr.chat label); HERDR_RESTART_RESUME says the argv continues the same conversation. The script
  // keeps the tab's and slot's labels, ends the old agent, and prints the new one's address.
  async restartAgent(t, built, pane) {
    const env = `HERDR_RESTART_CHAT="$1"${built.resume ? " HERDR_RESTART_RESUME=1" : ""}`;
    const r = await exec("sh", ["-c", `${env} bash "$2" "$3" "$4"`, "x", chatLabel(pane),
      `${appHome()}/mods/collie-tabs/bin/restart.sh`, t.address, JSON.stringify(built.argv)]);
    const addr = r.stdout.trim().split("\n").pop();
    if (r.code !== 0 || !addr) throw new Error((r.stderr || r.stdout || "It didn't restart.").trim());
    return addr;
  }

  // ---- following the log ------------------------------------------------------------------------

  log(args) {
    return exec("sh", ["-c", LOG, "log", ...args], { on: this.machine });
  }

  reset() {
    this.conv = null;
    this.start = null;
    this.end = 0;
    this.records = [];
  }

  set(phase, cx) {
    if (this.phase === phase) return;
    this.phase = phase;
    cx.notify();
  }

  rebuild() {
    this.conv = new Conversation(this.kind);
    this.conv.feed(this.records);
    this.settlePending();
  }

  // A message sent from here is in once the log has it (its typed words, at least: a quote stays in front).
  settlePending() {
    if (!this.conv || !this.pending.length) return;
    const users = this.conv.items.filter((x) => x.kind === "user");
    // Its typed words (or the start of them) in the log; a message that was only files has no words there to match, so
    // the log's first image after it says it arrived.
    const matches = (u, p) => (u.at ?? 0) >= p.at - 5000
      && (norm(u.text) === norm(p.sent) || (p.match && norm(u.text).includes(p.match)) || (!p.match && (u.images ?? 0) > 0));
    this.pending = this.pending.filter((p) => !users.some((u) => matches(u, p)));
  }

  // The agent's process and its log, again every few seconds: a /clear, a resume or a new agent started in the same
  // terminal writes another file.
  async locate(cx) {
    if (this.swapping || !this.addr) return;
    const r = await hc(["get", this.addr, "--json"]);
    let t = null;
    try { t = JSON.parse(r.stdout || "null"); } catch {}
    const gone = /not_found|no terminal/.test(`${r.stdout}\n${r.stderr}`);
    if (!gone && (!t || t.error)) return;
    if (gone || t?.state !== "live") {
      // Restarted from here: the new agent carries the origin.
      const origin = `slot:${this.slot}`;
      const next = terminals().find((x) => x.state === "live" && x.address !== this.addr && x.labels?.["herdr.chat.origin"] === origin);
      if (next) { this.followTo(next.address); return; }
      if (!gone && t && await this.checkLost(this.addr, cx, t)) return;
      this.set("ended", cx);
      return;
    }
    const kind = KINDS[t.status?.app] ?? KINDS[t.foreground?.name];
    if (!kind) { if (!(await this.checkLost(this.addr, cx, t))) this.set("unsupported", cx); return; }
    // Parked behind this chat: core keep stays on, so the agent survives a lost core like a pane's terminal.
    if (t.keep === false && !t.labels?.["herdr.tab"] && !panes().some((p) => p.terminal === this.addr)) await hc(["keep", this.addr]);
    // The agent lost its link to this chat (herdr.chat) while it has no pane of its own: link it again.
    const pane = this.slotRec()?.pane ?? null;
    if (!t.labels?.["herdr.chat"] && pane && !panes().some((p) => p.terminal === this.addr)
      && panes().some((p) => p.pane === pane && p.mod === "collie-chat")) await hc(["label", this.addr, `herdr.chat=${chatLabel(pane)}`]);
    const pid = t.foreground?.pid;
    if (!pid) { if (this.phase !== "ready") this.set("none", cx); return; }
    const f = await exec("sh", ["-c", FIND, "find", kind, String(pid)], { on: this.machine });
    let path = f.stdout.trim().split("\n").pop() ?? "";
    // Not in its session yet (no report, no turn): an empty chat.
    if (!path && !t.status && !(t.turn > 0) && cliOf(t)) path = "pending";
    if (path === "pending") {
      if (this.phase === "finding") { this.kind = kind; this.conv = new Conversation(kind); this.start = 0; this.set("ready", cx); }
      return;
    }
    if (!path) { if (this.phase !== "ready") this.set("none", cx); return; }
    if (path !== this.path || kind !== this.kind) {
      this.path = path;
      this.kind = kind;
      this.reset();
      this.pinned = true;
    }
  }

  // Shows another terminal from now on (the agent was restarted).
  followTo(addr) {
    this.addr = addr;
    this.machine = addr.includes("/") ? addr.split("/")[0] : null;
    this.path = null;
    this.reset();
    this.phase = "finding";
  }
  // Did the agent at `addr` stop because the session it resumed is gone ("No conversation found")? Then a new one
  // starts by itself, with the handover and its template's words again. Looked at once per agent.
  async checkLost(addr, cx, t = null) {
    if (this.lostTried.has(addr)) return false;
    this.lostTried.add(addr);
    if (!t) { try { t = JSON.parse((await hc(["get", addr, "--json"])).stdout || "null"); } catch {} }
    const kind = cliOf(t);
    const fresh = kind ? freshArgv(kind, t?.argv) : null;
    if (!fresh) return false;
    if (t.state !== "live" && (t.exit_code ?? 1) === 0) return false;
    const screen = (await hc(["read", addr, "--lines", "40"]).catch(() => null))?.stdout ?? "";
    if (!LOST.test(screen.split("\n").slice(-30).join("\n"))) return false;
    // One start for it, whichever chat saw it first: shared "collie-chat.lost" = { [address]: when }.
    const lost = shared("collie-chat.lost") ?? {};
    if (Date.now() - (lost[addr] ?? 0) < 120000) return true;
    setShared("collie-chat.lost", { ...Object.fromEntries(Object.entries(lost).filter(([, at]) => Date.now() - at < 120000)), [addr]: Date.now() });
    await this.lostSession(t, fresh, cx);
    return true;
  }

  // The session is gone: a new one starts in the same chat with a short handover, and the chat says so in one quiet
  // line. The agent still at its shell gets the new agent typed into that shell: the same terminal and labels.
  async lostSession(t, fresh, cx) {
    // A Coordinator's role is in its first message (its template): it gets that again, from this machine's copy.
    const template = this.template && !String(t.address).includes("/")
      ? await readTextFile(`${home()}/.config/herdr-core/templates/${this.template}.md`).catch(() => null) : null;
    const msg = lostMessage({ template });
    const mine = t.address === this.addr;
    if (mine) this.note = WORDS.sessionGone;
    try {
      if (t.state === "live") {
        // hc send pastes the line into the shell and presses Enter.
        const r = await hc(["send", t.address, [...fresh, msg].map(shellWord).join(" ")]);
        if (r.code !== 0) throw new Error(refusal(r).message);
        if (mine) this.note = sessionStarted;
      } else if (mine) {
        // Its terminal ended: a fresh agent for this chat, behind the same pane.
        await this.restart(fresh, msg);
        this.note = sessionStarted;
      }
    } catch (e) {
      if (mine) this.note = sessionFailed(String(e?.message ?? e));
    }
    if (mine) cx.timer.after(8000, (cx) => { this.note = null; cx.notify(); });
    cx.notify();
  }

  // A new agent for a chat whose terminal ended: a one-off template whose command is the fresh argv (hc run takes a
  // template, not a command line), run in this chat's pane as startAgent does. The handover is its whole body.
  async restart(fresh, msg) {
    const pane = this.myPane();
    if (!pane) throw new Error("its chat pane is gone");
    const on = this.machine ? { on: this.machine } : {};
    const name = `collie-coordinator-${Date.now().toString(36)}`;
    const file = `---\nname: ${name}\ndescription: A fresh Coordinator after its session was gone (mods/collie-chat), removed after use.\ncommand: ${cleanCommand(fresh.map(shellWord).join(" "))}\n---\n${msg}\n`;
    await exec("sh", ["-c", TEMPLATE + 'printf "%s" "$2" > "$dir/$1.md"', "x", name, file], on);
    const r = await hc(["run", "--bg", "--json", "--no-parent", "--keep", ...(this.machine ? ["--on", this.machine] : []),
      "--label", `herdr.chat=${chatLabel(pane)}`,
      "--label", `herdr.chat.slot=${this.slot}`, "--label", `herdr.chat.origin=slot:${this.slot}`, "--label", "herdr.role=coordinator",
      name]);
    exec("sh", ["-c", TEMPLATE + 'rm -f "$dir/$1.md"', "x", name], on);
    let out = {};
    try { out = JSON.parse(r.stdout || "{}"); } catch {}
    if (r.code !== 0 || !out.address) throw new Error((r.stderr || r.stdout || "it didn't start").trim());
    this.followTo(out.address);
  }

  // The newest page first; after that, what the log gained since.
  async pull(cx) {
    if (!this.path) return;
    const path = this.path;
    if (this.start === null) {
      const r = await this.log(["page", path, "999999999999999", String(PAGE)]);
      if (path !== this.path) return;
      if (r.stdout.startsWith("missing")) { this.path = null; return; }
      const { head, records: recs } = records(r.stdout);
      if (head[0] !== "P") return;
      this.start = Number(head[1]);
      this.end = Number(head[2]);
      this.records = recs;
      this.rebuild();
      this.pinned = true;
      this.phase = "ready";
      cx.notify();
      return;
    }
    const r = await this.log(["tail", path, String(this.end)]);
    if (path !== this.path) return;
    if (r.stdout.startsWith("missing")) { this.path = null; return; }
    const { head, records: recs } = records(r.stdout);
    if (head[0] !== "T") return;
    // Shorter than what was read: the file was replaced. Start over from its end.
    if (Number(head[2]) < this.end) { this.reset(); return; }
    this.end = Number(head[3]);
    if (!recs.length) return;
    this.records.push(...recs);
    if (this.records.length > KEEP) {
      // Down to three quarters, so the rebuild is now and then, not on every message.
      this.records = this.records.slice(-Math.floor(KEEP * 0.75));
      this.start = this.records[0].off;
      this.rebuild();
    } else this.conv.feed(recs);
    // Your reactions just sent stay shown as sent until the log says the same.
    for (const [id, mine] of this.myReacts) {
      const logged = this.conv.reactions.get(id) ?? [];
      for (const [emoji, on] of mine) if (logged.some((r) => r.by === "you" && r.emoji === emoji) === on) mine.delete(emoji);
      if (!mine.size) this.myReacts.delete(id);
    }
    this.settlePending();
    this.pinned = true;
    this.loadArts(cx);
    cx.notify();
  }

  async follow(cx) {
    let last = 0;
    for (;;) {
      try {
        if (!this.path || Date.now() - last > 4000) { last = Date.now(); await this.locate(cx); }
        if (this.phase === "ended") {
          // A Coordinator tab's chat stays: empty again, ready to start the next one.
          if (this.role) { this.addr = null; this.path = null; this.reset(); this.pending = []; this.phase = "fresh"; this.note = null; cx.notify(); return; }
          return;
        }
        await this.pull(cx);
        const k = terminals().find((x) => x.address === this.addr);
        if (this.status() === "idle") this.stopping = false;
        // The first message hc couldn't hand over (startAgent): sent once the agent is idle.
        if (this.firstSend && k?.turn > 0) this.firstSend = null;
        if (this.firstSend && k?.status?.state === "idle") {
          const text = this.firstSend;
          this.firstSend = null;
          const sent = await personHc(["send", this.addr, text]).catch(() => null);
          if (sent?.code !== 0) this.firstSend = text;
        }
        if (this.queue.length) this.drainQueueNow(cx);
        // What the agent left running in the background, and the open row's last lines (core/bg-jobs.js).
        if (this.phase === "ready" && this.kind === "codex") await this.lookJobs(cx).catch(() => {});
        else if (this.phase === "ready" && this.conv?.bg?.length) await this.lookJobs(cx).catch(() => {});
        if (this.error) { this.error = null; cx.notify(); }
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
      const working = this.status() === "working" || this.pending.length > 0;
      await cx.sleep(working ? 1500 : 4000);
    }
  }

  // A held message goes once the agent stops working (and isn't asking something).
  drainQueueNow(cx) {
    if (!this.queue.length || this.phase !== "ready") return;
    const st = this.status();
    if (st === "working" || st === "blocked" || (this.addr && openScreen(this.addr)) || this.asks.length || this.pending.some((p) => !p.failed)) return;
    const msg = this.queue.shift();
    if (msg) this.send(msg, cx);
    cx.notify();
  }
}
