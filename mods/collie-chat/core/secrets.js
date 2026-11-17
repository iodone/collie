// Secrets an agent asks for by name (its terminal's label collie.secret.ask.NAME): the words it hears when the person
// keeps or declines one (never the value), and where this machine keeps them. Ported from shepherdr's core/secrets.js
// for the Coordinator chat (#22), with Collie's own store (COLLIE_SECRETS_HOME, else $HOME/.local/share/collie/secrets)
// and none of Shepherdr's vault (~/.herdr/vault.json), remote keepers or `move-to` moving. Plain JS: no herdr, node or
// DOM, so bun test runs it anywhere.

export const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
// The label an agent's terminal carries while it waits on a secret (the ask command sets it; the card answers it).
export const ASK = "collie.secret.ask.";

// What a terminal's labels ask for: [{ name, why }].
export function asksIn(labels) {
  const l = labels ?? {};
  return Object.keys(l).filter((k) => k.startsWith(ASK) && NAME.test(k.slice(ASK.length)) && l[k])
    .sort().map((k) => ({ name: k.slice(ASK.length), why: l[k] === "-" ? "" : String(l[k]) }));
}

// The agent hears it's kept, by name: never the value.
export const keptLine = (name, where = "This computer") => `<hc from="person" secret="${name}">Kept: ${name} (for ${where}). Use it by name, never print it or put it in a chat, brief, artifact or commit.</hc>`;

// The agent hears it declined, and carries on without it.
export const declinedLine = (name) => `<hc from="person" secret="${name}">Declined: ${name}. The person won't give it now: go on without it, or say plainly what you can't do without it. Don't ask for its value in the chat.</hc>`;

// ---- the vault ---------------------------------------------------------------------------------
// Where a machine keeps its secrets: $COLLIE_SECRETS_HOME, else <home>/.local/share/collie/secrets (the same store the
// artifacts live in: Collie's, never Shepherdr's). One file, read and written by the person's card only.
export function vaultDir({ home = "/", env = {} } = {}) {
  const set = String(env.COLLIE_SECRETS_HOME ?? "").trim();
  return set ? set : `${String(home).replace(/\/+$/, "")}/.local/share/collie/secrets`;
}
export const vaultFile = (at = {}) => `${vaultDir(at).replace(/\/+$/, "")}/vault.json`;

// A vault, as its file keeps it: { version, secrets: { NAME: { value, why, at } } } (null text: none yet).
export function vault(text) {
  let d = null;
  try { d = JSON.parse(String(text ?? "null")); } catch { d = null; }
  const secrets = d && typeof d === "object" && d.secrets && typeof d.secrets === "object" && !Array.isArray(d.secrets) ? d.secrets : {};
  return { version: 1, secrets };
}

// Every secret's name in a vault, sorted, and whether one is kept (never a value).
export function names(text) {
  return Object.keys(vault(text).secrets).sort();
}
export const has = (text, name) => Boolean(vault(text).secrets[name]);

// The vault after keeping one: the same JSON shape, the name's value replaced, the others untouched. A name the
// person keeps again replaces its value (with its new why and time).
export function kept(text, name, value, why = "", at = Date.now()) {
  const v = vault(text);
  v.secrets[name] = { value: String(value ?? ""), why: String(why ?? ""), at };
  return JSON.stringify({ ...v, secrets: Object.fromEntries(Object.entries(v.secrets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }, null, 2) + "\n";
}

// The vault without one: the person's card declined it (and no value was ever written).
export function declined(text, name) {
  const v = vault(text);
  delete v.secrets[name];
  return JSON.stringify({ ...v, secrets: Object.fromEntries(Object.entries(v.secrets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }, null, 2) + "\n";
}
