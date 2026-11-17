// The card for a secret an agent asked for (its terminal's label collie.secret.ask.NAME, core/secrets.js asksIn()):
// "Secret: NAME", the reason, a masked box, Save and Decline. Save writes Collie's vault here directly (core/secrets.js
// kept()); the agent is told by name only. The value never goes through hc send, the conversation, a log or an
// artifact. For a few seconds after, the card says "Kept: NAME". Ported from shepherdr's secret-card.js for #22,
// drawn as ordinary rows of this chat's message list (strips.js): every control carries its own handler, so there is
// no keyboard sink or hit testing. The host does the rest: host.readVault()/host.writeVault(text) keep the vault on
// this machine, host.say(line, cx) sends the agent the words it hears (never the value).

import { InputState } from "gpui-base";
import * as secrets from "./core/secrets.js";
import { hc } from "herdr";
import { terminals } from "./live.js";
import { headStrip } from "./cards.js";
import { green } from "./lib/ui.js";

const KEPT_FOR = 6000;
const key = (address, name) => `${address}|${name}`;

export class SecretCards {
  // host: { readVault() -> Promise<string | null>, writeVault(text) -> Promise<void>, say(line, cx), where (where the
  // vault is kept, in the agent's words: "This computer", or the honest one for an agent on another machine) }.
  constructor(host) {
    this.host = host;
    // Per ask: { box, err, busy }; and asks answered a moment ago: { address, name, why, how, at }.
    this.states = new Map();
    this.kept = new Map();
    // Told when an ask is kept or declined here: (ask, how), for its quiet line (main.js).
    this.onEnd = null;
  }

  // What to show for a terminal: its asks, then those just kept or declined.
  items(address) {
    const now = Date.now(), out = secrets.asksIn(terminals().find((x) => x.address === address)?.labels).map((a) => ({ address, ...a }));
    for (const [k, v] of this.kept) {
      if (now - v.at > KEPT_FOR) { this.kept.delete(k); continue; }
      if (v.address === address && !out.some((a) => a.name === v.name)) out.push({ address, name: v.name, why: v.why, how: v.how });
    }
    return out;
  }

  // From render: boxes for asks that have none yet (made right after, never in render), and those of asks gone let go.
  prepare(list, cx) {
    const want = new Set(list.filter((a) => !a.how).map((a) => key(a.address, a.name)));
    for (const [k, st] of this.states) if (!want.has(k) && !st.busy) { st.box?.release(); this.states.delete(k); }
    const missing = [...want].filter((k) => !this.states.has(k));
    for (const k of missing) this.states.set(k, { box: null, err: "", busy: false });
    // A box made in render would make Herdr render again mid-render: right after.
    if (missing.length) cx.timer.after(0, (cx) => {
      for (const k of missing) {
        const st = this.states.get(k);
        if (!st || st.box) continue;
        st.box = InputState.new({ placeholder: "Paste the value" });
        st.box.set_masked(true);
        st.box.on("change", (_e, cx) => { st.err = ""; cx.notify(); });
        st.box.on("submit", (_e, cx) => { const [address, name] = k.split("|"); this.save({ address, name }, cx); });
      }
      cx.notify();
    });
    if (this.kept.size && !this.keptTimer) {
      this.keptTimer = true;
      cx.timer.after(KEPT_FOR + 50, (cx) => { this.keptTimer = false; cx.notify(); });
    }
  }

  save(ask, cx) {
    const st = this.states.get(key(ask.address, ask.name));
    const value = st?.box?.value() ?? "";
    if (!st || st.busy) return;
    if (!value) { st.err = "Paste the value first."; cx.notify(); return; }
    st.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const text = await this.host.readVault().catch(() => null);
        await this.host.writeVault(secrets.kept(text, ask.name, value, ask.why ?? ""));
        st.box?.set_value("");
        this.kept.set(key(ask.address, ask.name), { address: ask.address, name: ask.name, why: ask.why, how: "Kept", at: Date.now() });
        this.host.say(secrets.keptLine(ask.name, this.host.where), cx);
        hc(["label", ask.address, `collie.secret.ask.${ask.name}=`]).catch(() => {});
        this.onEnd?.(ask, "Kept");
      } catch (e) { st.err = String(e?.message ?? e); }
      st.busy = false;
      cx.notify();
    });
  }

  // Whether an ask's masked box is made yet; focus() puts the keyboard in it.
  ready(ask) {
    return Boolean(this.states.get(key(ask.address, ask.name))?.box);
  }

  focus(ask) {
    this.states.get(key(ask.address, ask.name))?.box?.focus();
  }

  decline(ask, cx) {
    const st = this.states.get(key(ask.address, ask.name));
    if (st?.busy) return;
    if (st) st.busy = true;
    cx.spawn(async (cx) => {
      // A refused ask never had a value here; one kept before is taken back out of the vault.
      try {
        const text = await this.host.readVault().catch(() => null);
        if (text && secrets.has(text, ask.name)) await this.host.writeVault(secrets.declined(text, ask.name));
      } catch {}
      if (st) st.busy = false;
      this.kept.set(key(ask.address, ask.name), { address: ask.address, name: ask.name, why: ask.why, how: "Declined", at: Date.now() });
      this.host.say(secrets.declinedLine(ask.name), cx);
      hc(["label", ask.address, `collie.secret.ask.${ask.name}=`]).catch(() => {});
      this.onEnd?.(ask, "Declined");
      cx.notify();
    });
  }

  // The card's strips. opts: { who (whose ask: "Claude"), links ([ctl] at the header's right) }.
  strips(ask, opts = {}) {
    const id = `${ask.address}-${ask.name}`.replace(/[^\w-]/g, "_");
    const st = this.states.get(key(ask.address, ask.name));
    if (ask.how) return [headStrip({ who: ask.how === "Kept" ? "Kept" : "Declined", asks: false, dot: ask.how === "Kept" ? green() : undefined, links: opts.links }),
      { key: "title", kind: "title", text: `Secret: ${ask.name}` },
      { key: "kept", kind: "text", tone: "dim", text: ask.how === "Kept" ? "The agent was told its name, never the value." : "The agent was told you won't give it now." }];
    const has = Boolean(st?.box?.value());
    const out = [headStrip({ who: opts.who, links: opts.links }), { key: "title", kind: "title", text: `Secret: ${ask.name}` }];
    if (ask.why) out.push({ key: "why", kind: "text", tone: "muted", text: ask.why });
    out.push({ key: "box", kind: "input", state: st?.box ?? null, placeholder: "Paste the value" });
    out.push({ key: "note", kind: "text", tone: st?.err ? "red" : "dim", text: st?.err || "Agents use it by name, never seeing it." });
    const live = has && !st?.busy;
    out.push({ key: "actions", kind: "controls", align: "end", ctls: [
      { id: `sdecline-${id}`, label: "Decline", look: "plain", fn: (cx) => this.decline(ask, cx) },
      { id: `ssave-${id}`, label: st?.busy ? "Saving…" : "Save", look: "primary", disabled: !live, fn: live ? (cx) => this.save(ask, cx) : null }] });
    return out;
  }
}
