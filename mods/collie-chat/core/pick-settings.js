// Where a Coordinator chat keeps the choice its picker made, so the next chat starts from it: Collie's own settings,
// ~/.local/state/collie/coordinator.json, in its "chat" field ({ agent, model, effort, fast, perm }). The headless
// coordinator's own settings (everywhere.coordinator: cli/model/effort) stay the New space dialog's; a chat never reads
// or writes Shepherdr settings. Pure, so the tests run anywhere.

export const CHAT = "chat";

// The saved chat choice as a pick, or null when there is none (a file that isn't JSON, no "chat" field).
export function chatPick(cfg) {
  const v = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg[CHAT] : null;
  if (!v || typeof v !== "object" || !["claude", "codex"].includes(v.agent)) return null;
  const word = (x) => (x && x !== "default" ? String(x) : null);
  return { agent: v.agent, model: word(v.model), effort: word(v.effort), fast: Boolean(v.fast),
    perm: v.perm ? String(v.perm) : (v.agent === "claude" ? "manual" : "auto") };
}

// `cfg` with the chat choice set; everything else in the file is kept as it was.
export function withChatPick(cfg, pick) {
  const current = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
  if (!pick || !["claude", "codex"].includes(pick.agent)) return current;
  return {
    ...current,
    [CHAT]: {
      agent: pick.agent,
      model: pick.model ?? null,
      effort: pick.effort ?? null,
      fast: Boolean(pick.fast),
      perm: pick.perm ?? null,
    },
  };
}

// A file's text with the chat choice set, as it is written: JSON.stringify's shape, a last newline.
export function withChatPickText(text, pick) {
  let cfg = {};
  try { cfg = JSON.parse(text ?? "{}") ?? {}; } catch { cfg = {}; }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
  return JSON.stringify(withChatPick(cfg, pick), null, 2) + "\n";
}

// The same text with the chat choice taken out (kept for a reset: nothing calls it yet).
export function withoutChatPickText(text) {
  let cfg = {};
  try { cfg = JSON.parse(text ?? "{}") ?? {}; } catch { return text ?? ""; }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return text ?? "";
  const { [CHAT]: _drop, ...rest } = cfg;
  return JSON.stringify(rest, null, 2) + "\n";
}
