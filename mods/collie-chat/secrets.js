// Secrets for agents: collie-secret's vault, ~/.local/share/collie/secrets/vault.json
// ($COLLIE_SECRETS_HOME moves it), owner-only. One machine, one scope: a value is kept here
// and every agent on this machine uses it by name. The masked card in the chat writes it
// directly; the value never goes through hc send, a chat, a log or an artifact.
// An agent asks with a label on its own terminal, collie.secret.ask.<NAME>=<why>
// (collie-secret ask); answering removes it and tells the agent by name only.

import { appHome, home, exec, hc, readTextFile, writeTextFile } from "herdr";
import { terminals } from "./live.js";
import { NAME, ASK, asksIn, keptLine, declinedLine } from "./core/secrets.js";
import { sendAsPerson } from "./core/person.js";
export { NAME };

const bin = () => `${appHome()}/bin/collie-secret`;
const vaultDir = () => (globalThis.process?.env?.COLLIE_SECRETS_HOME) || `${home()}/.local/share/collie/secrets`;
const vault = () => `${vaultDir()}/vault.json`;

// ---- scopes: collie keeps one vault, on this machine ----
export const scopeKey = (s) => s?.scope ?? "local";
export const levels = (_address) => [{ scope: "local", machine: null, space: null, label: "This computer" }];
export const where = (_s) => "This computer";
export const keptOn = () => ({ here: true, set: true, id: null, name: "" });
export const whereNow = async () => keptOn();

// ---- asks -----------------------------------------------------------------------------------

export function asksOf(address, ts = terminals()) {
  return asksIn(ts.find((x) => x.address === address)?.labels);
}

export function allAsks() {
  return terminals().filter((t) => t.state === "live" || t.state == null)
    .flatMap((t) => asksOf(t.address).map((a) => ({ address: t.address, ...a })));
}

async function answer(address, name, text) {
  await hc(["label", address, `${ASK}${name}=`]).catch(() => {});
  await sendAsPerson({ hc, exec }, address, text).catch(() => {});
}

export async function decline(address, name) {
  await answer(address, name, declinedLine(name));
}

// ---- the vault ------------------------------------------------------------------------------

async function read() {
  const text = await readTextFile(vault()).catch(() => null);
  if (text == null) return { text: null, data: { version: 1, secrets: {} } };
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!data || typeof data.secrets !== "object" || Array.isArray(data.secrets)) {
    throw new Error("The Collie vault isn't readable; fix or move it first.");
  }
  return { text, data };
}

async function change(fn) {
  const r = await exec(bin(), ["init"]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Couldn't open the Collie vault.");
  for (let i = 0; i < 3; i++) {
    const { text, data } = await read();
    fn(data);
    try { await writeTextFile(vault(), JSON.stringify(data, null, 2) + "\n", text); return; }
    catch (e) { if (i === 2) throw e; }
  }
}

export async function entries() {
  const { data } = await read();
  return Object.entries(data.secrets)
    .filter(([name, e]) => NAME.test(name) && e && typeof e.value === "string")
    .map(([name, e]) => ({ name, scope: "local", machine: null, space: null, at: e.at ?? null }));
}

export async function keep(name, _scope, value) {
  if (!NAME.test(name)) throw new Error("Name it like an environment variable: GITHUB_TOKEN.");
  const v = String(value ?? "").replace(/[\r\n]+$/, "");
  if (!v) throw new Error("Type or paste the value first.");
  await change((data) => { data.secrets[name] = { value: v, why: "This computer", at: Date.now() }; });
  for (const a of allAsks().filter((a) => a.name === name)) await answer(a.address, name, keptLine(name, where()));
}

export async function remove(name) {
  await change((data) => { delete data.secrets[name]; });
}
