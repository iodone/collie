// The model menu's words and the choices each agent offers, shared by the chat's picker and the
// coordinator settings rows. Everything else Shepherdr kept in this core (Tasks, Web, Add-ons)
// belonged to panels Collie does not run, and is not ported.

import { NAMES, levelName, current, rowFor, menuFor } from "./agents.js";

export const MODEL_MENU = { reasoning: "Reasoning", fast: "Fast", permissions: "Permissions" };
const modelOf = (menus, sel) => menus?.[sel?.agent]?.models?.find((m) => m.id === sel.model) ?? null;

export function modelLabel(menus, sel) {
  const m = modelOf(menus, sel);
  const level = sel?.effort ?? m?.defaultEffort ?? null;
  return [m?.name ?? sel?.model, levelName(level), sel?.fast ? "Fast" : null].filter(Boolean).join(" · ") || "Choose a model";
}

// What the agents offer, from each CLI's own settings (agents.js parseDefaults) and which are installed:
// { menus, permDefault, defaults } (defaults: the first installed CLI's own, what an unset role runs).
export function choicesFrom(dflts, installed = { claude: true, codex: true }) {
  const menus = Object.fromEntries(["claude", "codex"].filter((k) => installed[k]).map((k) => [k, menuFor(k, dflts[k])]));
  const permDefault = { claude: dflts.claude?.mode ?? "manual", codex: "auto" };
  const first = menus.claude ? "claude" : Object.keys(menus)[0] ?? "claude";
  const c = current(first, [], {}, dflts[first]);
  const model = rowFor(first, c) ?? menus[first]?.models?.[0]?.id ?? null;
  return { menus, permDefault, defaults: { agent: first, model, effort: c.effort ?? null, fast: false, perm: permDefault[first] } };
}
