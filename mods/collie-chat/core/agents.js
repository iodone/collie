// How to start (or start again) the agent a Coordinator chat runs on: the person's chosen agent and flags
// ({ agent, model, effort, fast, perm }, from the New space dialog or the chat's own picker), the argv that resumes a
// session whose agent ended, and the choices the picker offers (the model menu's rules, ported from shepherdr's
// core/agents.js: #21). No pins, search sections or typed model ids: the picker lists every model the CLIs offer, plus
// each agent's own default.

// A flag's value in argv: --model x, --model=x, or -m x.
function flag(argv, ...names) {
  for (let i = argv.length - 1; i >= 0; i--) {
    for (const n of names) {
      if (argv[i] === n && i + 1 < argv.length) return argv[i + 1];
      if (argv[i].startsWith(n + "=")) return argv[i].slice(n.length + 1);
    }
  }
  return null;
}
// Codex's -c key=value overrides.
function overrides(argv) {
  const out = {};
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "-c" && argv[i] !== "--config") continue;
    const m = /^([\w.]+)=(.*)$/.exec(argv[i + 1]);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// Flags that are about what to resume, which model, effort or speed: set again by a restart.
const CLAUDE_DROP = new Set(["--model", "--effort", "--settings", "--session-id", "--resume", "-r", "--permission-mode"]);
const CLAUDE_BARE = new Set(["--continue", "-c", "--fork-session", "--dangerously-skip-permissions"]);
// Flags whose next word is their value (so it isn't taken for a first message).
const CLAUDE_VALUE = new Set(["--add-dir", "--mcp-config", "--append-system-prompt", "--system-prompt",
  "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--agent", "--agents", "--plugin-dir",
  "--fallback-model", "--output-format", "--input-format", "--name", "--setting-sources", "--betas", "--debug-file"]);
const CODEX_VALUE = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-a", "--ask-for-approval",
  "-C", "--cd", "--add-dir", "-i", "--image", "--enable", "--disable", "--local-provider", "--oss"]);

// The old agent's flags worth keeping (permissions, folders, ...), without what is chosen again
// or a first message.
function kept(kind, argv) {
  const out = [];
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (kind === "claude") {
      if (CLAUDE_BARE.has(a)) continue;
      if (CLAUDE_DROP.has(a)) { if (rest[i + 1] && !rest[i + 1].startsWith("-")) i++; continue; }
      if ([...CLAUDE_DROP].some((f) => a.startsWith(f + "="))) continue;
      if (CLAUDE_VALUE.has(a)) { out.push(a, rest[++i]); continue; }
      if (a.startsWith("-")) out.push(a);
    } else {
      if (i === 0 && (a === "resume" || a === "fork")) { if (rest[1] && !rest[1].startsWith("-")) i++; continue; }
      if (a === "--no-daemon" || a === "--dangerously-bypass-approvals-and-sandbox" || a === "--full-auto") continue;
      if (["-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval"].includes(a)) { i++; continue; }
      if ((a === "-c" || a === "--config") && /^(model|model_reasoning_effort|service_tier)=/.test(rest[i + 1] ?? "")) { i++; continue; }
      if (CODEX_VALUE.has(a)) { out.push(a, rest[++i]); continue; }
      if (a.startsWith("-")) out.push(a);
    }
  }
  return out.filter((x) => x !== undefined);
}

// The same agent and flags as `argv`, without what resumed a conversation (and without a
// first message), or null when argv resumed none: for a fresh start once that session is gone.
export function freshArgv(kind, argv) {
  argv = argv ?? [];
  const at = argv.findIndex((a, i) => (i === 0 || !a.startsWith("-")) && /^(claude|codex)$/.test(String(a).split("/").pop()));
  if (at < 0) return null;
  const rest = argv.slice(at + 1), out = [argv[at]];
  let resumed = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (kind === "claude") {
      if (a === "--resume" || a === "-r" || a === "--session-id") { resumed ||= a !== "--session-id"; if (rest[i + 1] && !rest[i + 1].startsWith("-")) i++; continue; }
      if (/^--(resume|session-id)=/.test(a)) { resumed ||= a.startsWith("--resume"); continue; }
      if (a === "--continue" || a === "-c") { resumed = true; continue; }
      if (a === "--fork-session") continue;
      if (CLAUDE_VALUE.has(a) || ["--model", "--effort", "--settings", "--permission-mode"].includes(a)) { out.push(a, rest[++i]); continue; }
    } else {
      if (i === 0 && (a === "resume" || a === "fork")) { resumed = true; continue; }
      if (a === "--last") continue;
      if (CODEX_VALUE.has(a)) { out.push(a, rest[++i]); continue; }
    }
    // A word that isn't a flag or a flag's value: the session's id or a first message.
    if (a.startsWith("-")) out.push(a);
  }
  return resumed ? out.filter((x) => x !== undefined) : null;
}

// How to start the chosen agent: { argv, resume } (resume: argv already continues the session).
// `session`: the old conversation's id when it can be resumed (same agent only).
export function argvFor(pick, old) {
  const same = pick.agent === old.agent;
  const flags = same ? kept(pick.agent, old.argv ?? []) : [];
  if (pick.agent === "claude") {
    const a = ["claude", ...flags];
    if (pick.model) a.push("--model", pick.model);
    if (pick.effort) a.push("--effort", pick.effort);
    a.push("--settings", JSON.stringify({ fastMode: Boolean(pick.fast) }));
    if (pick.perm === "bypassPermissions") a.push("--dangerously-skip-permissions");
    else if (pick.perm) a.push("--permission-mode", pick.perm === "manual" ? "default" : pick.perm);
    if (same && old.session) return { argv: [...a, "--resume", old.session], resume: true, base: a };
    return { argv: a, resume: false, base: a };
  }
  // Codex runs its commands outside hc without --no-daemon (as herdr-task and restart.sh add).
  const a = [...flags, "--no-daemon"];
  if (pick.model) a.push("-m", pick.model);
  if (pick.effort) a.push("-c", `model_reasoning_effort="${pick.effort}"`);
  // always said, so Fast off wins over a service_tier in config.toml (default: the standard tier)
  a.push("-c", `service_tier="${pick.fast ? "fast" : "default"}"`);
  if (pick.perm === "full") a.push("--dangerously-bypass-approvals-and-sandbox");
  else if (pick.perm === "read-only") a.push("-s", "read-only", "-a", "on-request");
  else if (pick.perm) a.push("-s", "workspace-write", "-a", "on-request");
  if (same && old.session) return { argv: ["codex", "resume", ...a, old.session], resume: true, base: ["codex", ...a] };
  return { argv: ["codex", ...a], resume: false, base: ["codex", ...a] };
}

// The conversation's id, from its log's file name.
export function sessionOf(kind, path) {
  const m = kind === "claude" ? /([0-9a-f-]{36})\.jsonl$/.exec(path ?? "") : /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path ?? "");
  return m ? m[1] : null;
}

// A copy of the conversation in a new tab beside this one, through the CLI's own fork (shepherdr's forkArgv).
export function forkArgv(kind, argv, session) {
  argv = argv ?? [];
  // The same model, effort and speed as the original.
  const same = kind === "claude"
    ? ["--model", "--effort", "--settings"].flatMap((f) => { const v = flag(argv, f); return v ? [f, v] : []; })
    : (() => {
      const m = flag(argv, "-m", "--model"), o = overrides(argv);
      return [...(m ? ["-m", m] : []), "--no-daemon",
        ...["model_reasoning_effort", "service_tier"].flatMap((k) => (o[k] ? ["-c", `${k}="${o[k]}"`] : []))];
    })();
  const flags = [...kept(kind, argv), ...same];
  return kind === "claude" ? ["claude", ...flags, "--resume", session, "--fork-session"] : ["codex", "fork", ...flags, session];
}

// ---- what the agent runs on, and what the picker offers --------------------------------------

export const NAMES = { claude: "Claude Code", codex: "Codex" };

// Claude Code's current models, as its /model menu offers them (`id` is what --model gets).
const CLAUDE_MODELS = [
  { id: "opus", name: "Opus 5.5" },
  { id: "opus[1m]", name: "Opus 5.5 · 1M" },
  { id: "claude-fable-5-1", name: "Fable 5.1" },
  { id: "sonnet", name: "Sonnet 5.5" },
  { id: "haiku", name: "Haiku 5.5" },
];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"];

// Permission modes as each CLI has them (Claude: --permission-mode, or --dangerously-skip-permissions for full
// access; Codex: its sandbox and approvals). `short` is the picker's one-word form.
export const PERMS = {
  claude: [{ id: "manual", label: "Ask", short: "Ask" }, { id: "auto", label: "Auto", short: "Auto" },
    { id: "acceptEdits", label: "Accept edits", short: "Edits" }, { id: "plan", label: "Plan", short: "Plan" },
    { id: "bypassPermissions", label: "Full access", short: "Full" }],
  codex: [{ id: "read-only", label: "Read only", short: "Read" }, { id: "auto", label: "Auto", short: "Auto" },
    { id: "full", label: "Full access", short: "Full" }],
};

// An effort level as the person reads it: "xhigh" -> "Extra high". The CLIs still get the raw value.
const LEVELS = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra", none: "None" };
export const levelName = (e) => (e ? LEVELS[e] ?? e[0].toUpperCase() + e.slice(1) : null);
// The picker's segmented control has one row: an effort's short word.
const SHORT = { minimal: "Min", low: "Low", medium: "Med", high: "High", xhigh: "X-high", max: "Max", ultra: "Ultra", none: "None" };
export const effortShort = (e) => SHORT[e] ?? levelName(e) ?? e;

// What a model id says, in words: "claude-opus-5-5" -> "Opus 5.5", "opus[1m]" -> "Opus 1M".
export function modelName(id) {
  if (!id) return null;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(id);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}`;
  const a = /^([a-z]+)(\[1m\])?$/.exec(id);
  if (a) return `${a[1][0].toUpperCase()}${a[1].slice(1)}${a[2] ? " 1M" : ""}`;
  return id;
}

// The agent's own settings on its machine: Claude's settings.json, Codex's config.toml and model list. Read once per
// menu (mods/collie-chat/picker.js runs it there).
export const DEFAULTS = `
if [ "$1" = claude ]; then
  f="$HOME/.claude/settings.json"
  command -v jq >/dev/null && [ -f "$f" ] && jq -r '"model\\t\\(.model // "")", "effort\\t\\(.effortLevel // "")", "fast\\t\\(if .fastMode == true then "on" else "" end)", "per\\t\\(.modelSettings // {} | with_entries(.value |= (.effortLevel // null)) | tojson)", "mode\\t\\(.permissions.defaultMode // "")"' "$f" 2>/dev/null
else
  f="$HOME/.codex/config.toml"
  for k in model model_reasoning_effort service_tier sandbox_mode approval_policy; do
    printf '%s\\t%s\\n' "$k" "$(sed -n "s/^$k[[:space:]]*=[[:space:]]*\\"\\{0,1\\}\\([^\\"]*\\)\\"\\{0,1\\}.*/\\1/p" "$f" 2>/dev/null | head -1)"
  done
  c="$HOME/.codex/models_cache.json"
  [ -f "$c" ] && { printf 'models\\t'; tr -d '\\n' < "$c"; echo; }
fi
true`;

function parsePer(text) {
  try { return JSON.parse(text || "{}") ?? {}; } catch { return {}; }
}

// The agent's own settings, from DEFAULTS' output on its machine.
export function parseDefaults(kind, stdout) {
  const out = {};
  for (const line of (stdout ?? "").split("\n")) {
    const t = line.indexOf("\t");
    if (t > 0) out[line.slice(0, t)] = line.slice(t + 1);
  }
  let models = null;
  if (out.models) {
    try {
      models = (JSON.parse(out.models).models ?? []).filter((m) => m.visibility !== "hide").map((m) => ({
        id: m.slug, label: m.display_name || m.slug,
        efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter(Boolean),
        fast: (m.service_tiers ?? []).length > 0,
        defaultEffort: m.default_reasoning_level ?? null,
      }));
    } catch {}
  }
  return kind === "claude"
    ? { model: out.model || null, effort: out.effort || null, fast: Boolean(out.fast), per: parsePer(out.per), mode: out.mode || null }
    : { model: out.model || null, effort: out.model_reasoning_effort || null, fast: ["fast", "priority"].includes(out.service_tier),
      sandbox: out.sandbox_mode || null, approval: out.approval_policy || null, models };
}

// What the agent runs on now: { agent, model, effort, fast, perm }. `argv` is its arguments, `meta` what its log says.
export function current(kind, argv, meta, dflt) {
  argv = argv ?? [];
  meta = meta ?? {};
  dflt = dflt ?? {};
  if (kind === "claude") {
    let fast = Boolean(dflt.fast);
    const s = flag(argv, "--settings");
    if (s && /"fastMode"\s*:\s*(true|false)/.test(s)) fast = /"fastMode"\s*:\s*true/.test(s);
    if (meta.speed) fast = meta.speed === "fast";
    const perm = argv.includes("--dangerously-skip-permissions") ? "bypassPermissions" : flag(argv, "--permission-mode") ?? dflt.mode ?? "manual";
    return { agent: "claude", model: meta.model ?? flag(argv, "--model") ?? dflt.model ?? null,
      effort: meta.effort ?? flag(argv, "--effort") ?? dflt.effort ?? null, fast, perm: perm === "default" ? "manual" : perm };
  }
  const o = overrides(argv);
  const tier = o.service_tier;
  const model = meta.model ?? flag(argv, "-m", "--model") ?? o.model ?? dflt.model ?? null;
  const sandbox = flag(argv, "-s", "--sandbox") ?? o.sandbox_mode ?? dflt.sandbox;
  const perm = argv.includes("--dangerously-bypass-approvals-and-sandbox") || sandbox === "danger-full-access" ? "full"
    : sandbox === "read-only" ? "read-only" : "auto";
  return { agent: "codex", model, perm,
    effort: meta.effort ?? o.model_reasoning_effort ?? dflt.effort ?? null,
    fast: tier ? ["fast", "priority"].includes(tier) : Boolean(dflt.fast) };
}

// "Claude Code · Opus 5.5 · High · Fast · Plan" — what a chat's pick button says.
export function line(c, menus = null) {
  if (!c) return "";
  const model = menus?.[c.agent]?.models?.find((m) => (m.id ?? null) === (c.model ?? null));
  const perm = menus?.[c.agent]?.perms?.find((x) => x.id === c.perm) ?? PERMS[c.agent]?.find((x) => x.id === c.perm);
  return [NAMES[c.agent] ?? c.agent, model?.name ?? modelName(c.model) ?? "Default", levelName(c.effort), c.fast ? "Fast" : null, perm?.label]
    .filter(Boolean).join(" · ");
}

// What the model picker shows for one agent: { name, models, perms }. Every model the CLI offers (Codex: its own
// models_cache.json; Claude Code: its /model menu), each with the effort levels it takes, whether it has Fast, and
// (Claude) the level it runs at by default. A null id is the agent's own default: no model flag. `currentModel` (the
// model it runs on, or the chosen one) stays in the list even when the CLI doesn't name it.
export function menuFor(agent, dflt, currentModel = null) {
  dflt = dflt ?? {};
  if (agent === "claude") {
    const models = CLAUDE_MODELS.map((m) => ({ id: m.id, name: m.name, efforts: CLAUDE_EFFORTS,
      defaultEffort: dflt.per?.[m.id.replace(/\[1m\]$/, "")] ?? dflt.effort ?? null, fast: m.id.startsWith("opus") }));
    if (currentModel && !models.some((m) => m.id === currentModel)) models.unshift({ id: currentModel, name: modelName(currentModel), efforts: CLAUDE_EFFORTS, defaultEffort: dflt.effort ?? null, fast: false });
    return { name: NAMES.claude, perms: PERMS.claude,
      models: [{ id: null, name: "Claude's own model", efforts: CLAUDE_EFFORTS, defaultEffort: dflt.effort ?? null, fast: true }, ...models] };
  }
  const models = (dflt.models ?? []).map((m) => ({ id: m.id, name: m.label, efforts: m.efforts?.length ? m.efforts : CODEX_EFFORTS,
    defaultEffort: m.defaultEffort ?? dflt.effort ?? null, fast: m.fast }));
  if (currentModel && !models.some((m) => m.id === currentModel)) models.unshift({ id: currentModel, name: currentModel, efforts: CODEX_EFFORTS, defaultEffort: dflt.effort ?? null, fast: false });
  return { name: NAMES.codex, perms: PERMS.codex,
    models: [{ id: null, name: "Codex's own model", efforts: CODEX_EFFORTS, defaultEffort: dflt.effort ?? null, fast: true }, ...models] };
}

// What the agents offer, from each CLI's own settings and which are installed:
// { menus, permDefault, defaults } (defaults: the first installed CLI's own, what an unset chat starts on).
// `currentModels`: each agent's running/chosen model, kept in its list.
export function choicesFrom(dflts = {}, installed = { claude: true, codex: true }, currentModels = {}) {
  const menus = Object.fromEntries(["claude", "codex"].filter((k) => installed[k])
    .map((k) => [k, menuFor(k, dflts[k], currentModels[k] ?? null)]));
  const permDefault = { claude: dflts.claude?.mode ?? "manual", codex: "auto" };
  const first = menus.claude ? "claude" : menus.codex ? "codex" : "claude";
  const c = current(first, [], {}, dflts[first] ?? {});
  const model = menus[first]?.models.find((m) => m.id)?.id ?? null;
  return { menus, permDefault, defaults: { agent: first, model, effort: c.effort ?? null, fast: false, perm: permDefault[first] } };
}

// A pick that fits what the menus offer: an unknown agent or model falls back to the first offered one, an effort the
// model doesn't take is cleared, another agent's permission mode goes back to that agent's default.
export function fitPick(menus, pick, permDefault = {}) {
  const agent = menus?.[pick?.agent] ? pick.agent : Object.keys(menus ?? {})[0] ?? "claude";
  const menu = menus?.[agent];
  const known = (id) => menu?.models?.find((m) => (m.id ?? null) === (id ?? null)) ?? null;
  let model = pick?.model ?? null;
  let m = known(model);
  if (!m) { model = menu?.models?.[0]?.id ?? null; m = known(model); }
  const effort = pick?.effort && (m?.efforts ?? []).includes(pick.effort) ? pick.effort : null;
  const perm = menu?.perms?.some((x) => x.id === pick?.perm) ? pick.perm : (permDefault?.[agent] ?? menu?.perms?.[0]?.id ?? null);
  return { agent, model, effort, fast: Boolean(m?.fast && pick?.fast), perm };
}

// A model picked in the menu: the effort and speed stay where it has them; another agent brings its own permission
// modes (full access staying full access).
export function chooseModel(menus, permDefault, sel, agent, id) {
  const m = menus?.[agent]?.models?.find((x) => (x.id ?? null) === (id ?? null));
  if (!m) return sel;
  const next = { ...sel, agent, model: m.id ?? null };
  if (next.effort && !m.efforts.includes(next.effort)) next.effort = null;
  if (!m.fast) next.fast = false;
  if (agent !== sel.agent) {
    const full = sel.perm === "bypassPermissions" || sel.perm === "full";
    next.perm = full ? (agent === "claude" ? "bypassPermissions" : "full") : permDefault?.[agent] ?? null;
    next.fast = false;
  }
  return next;
}

// The level that applies: the chosen one, else the model's default.
export function pickLevel(menus, sel) {
  const m = menus?.[sel?.agent]?.models?.find((x) => (x.id ?? null) === (sel?.model ?? null));
  return sel?.effort ?? m?.defaultEffort ?? null;
}

// What would change, in words, or [] when nothing would.
export function pickChanges(menus, sel, was) {
  if (!sel || !was) return [];
  const row = (s) => menus?.[s?.agent]?.models?.find((x) => (x.id ?? null) === (s?.model ?? null));
  const level = (s) => pickLevel(menus, s);
  const out = [];
  if (sel.agent !== was.agent) out.push(menus?.[sel.agent]?.name ?? NAMES[sel.agent] ?? sel.agent);
  if (sel.agent !== was.agent || (sel.model ?? null) !== (was.model ?? null)) out.push(row(sel)?.name ?? modelName(sel.model) ?? "Default");
  if (level(sel) && level(sel) !== level(was)) out.push(levelName(level(sel)));
  if (Boolean(sel.fast) !== Boolean(was.fast)) out.push(sel.fast ? "Fast" : "Standard");
  if ((sel.perm ?? null) !== (was.perm ?? null)) {
    const p = menus?.[sel.agent]?.perms?.find((x) => x.id === sel.perm) ?? PERMS[sel.agent]?.find((x) => x.id === sel.perm);
    out.push(p?.label ?? sel.perm);
  }
  return out;
}

// The same pick, field for field (null and undefined the same).
export function samePick(a, b) {
  const one = (s) => [s?.agent ?? null, s?.model ?? null, s?.effort ?? null, Boolean(s?.fast), s?.perm ?? null].join("|");
  return one(a) === one(b);
}

// A saved or given choice as a pick: { agent, model, effort, fast, perm }, with "default" (the settings' word for "the
// CLI's own") as null. Anything unknown is dropped; fitPick then keeps what the menus offer.
export function asPick(settings) {
  if (!settings || !["claude", "codex"].includes(settings.agent)) return null;
  const word = (v) => (v && v !== "default" ? String(v) : null);
  return { agent: settings.agent, model: word(settings.model), effort: word(settings.effort),
    fast: Boolean(settings.fast), perm: settings.perm ? String(settings.perm) : (settings.agent === "claude" ? "manual" : "auto") };
}