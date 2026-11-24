import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadProtocol } from "../../protocol/validate.mjs";
import { settle } from "../../protocol/invariants.mjs";
import type { CoordinatorConfig } from "./coordinator.ts";

type Json = Record<string, any>;
type Term = Json & { address: string; state?: string; labels?: Json };

const execFileAsync = promisify(execFile);
const protocol = await loadProtocol(resolve(new URL("../../protocol", import.meta.url).pathname));

export const HELPER_LABELS = {
  role: "herdr.role=helper",
  space: (space: string) => `herdr.job.space=${space}`,
  coordinator: (tab: string) => `herdr.coordinator=${tab}`,
};

export type HelperRunner = (args: string[]) => Promise<Json>;

export const defaultHelperRunner: HelperRunner = async (args) => {
  const { stdout } = await execFileAsync(process.env.COLLIE_HC_CLI ?? "hc", args, { maxBuffer: 4 * 1024 * 1024 });
  try { return JSON.parse(stdout); } catch { return { stdout }; }
};

export interface HelperJobOptions {
  stateDir: string;
  space: string;
  folder?: string;
  config: CoordinatorConfig;
  rolePromptRef: string;
  run?: HelperRunner;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** How long to let the agent draw its prompt before the first send; 0 sends at once. */
  bootWaitMs?: number;
  coordinatorAddress?: string;
  coordinatorTab?: string;
}

export interface HelperHandle {
  address: string;
  created: boolean;
  space: string;
  tab: string;
}

export interface HelperResult {
  decision: Json;
  address: string;
}

export const helperRoot = (stateDir: string, space: string): string => join(stateDir, "helper", space);
export const jobsDir = (stateDir: string, space: string): string => join(helperRoot(stateDir, space), "jobs");
export const decisionsDir = (stateDir: string, space: string): string => join(helperRoot(stateDir, space), "decisions");

/** `hc` names are unique among live terminals on a machine; the space suffix keeps helpers apart. */
export function helperName(space: string): string {
  const safe = String(space).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = `collie-helper-${safe}`;
  if (name.length <= 32) return name;
  const hash = createHash("sha256").update(String(space)).digest("hex").slice(0, 4);
  return `collie-helper-${safe.slice(0, 13)}-${hash}`;
}

export function helperCliArgs(config: CoordinatorConfig, stateDir?: string): string[] {
  if (Array.isArray(config.helper_args) && config.helper_args.length) return [...config.helper_args];
  const addDir = stateDir ? ["--add-dir", stateDir] : [];
  if (config.cli === "codex") {
    const model = config.model && config.model !== "default" ? config.model : null;
    const effort = config.effort ? config.effort : null;
    return [
      "codex",
      ...(model ? ["--model", model] : []),
      ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
      "--no-daemon",
      "--sandbox", "workspace-write",
      "--ask-for-approval", "on-request",
      ...addDir,
    ];
  }
  return [
    "claude",
    ...(config.model && config.model !== "default" ? ["--model", config.model] : []),
    ...(config.effort ? ["--effort", config.effort] : []),
    "--permission-mode", "auto",
    ...addDir,
  ];
}

const terminalList = (value: Json): Term[] => {
  const list = Array.isArray(value) ? value : value?.terminals;
  return Array.isArray(list) ? list : [];
};

const isLive = (term: Json): boolean => term?.state === "live" || term?.state === undefined;

async function withLabels(run: HelperRunner, term: Term): Promise<Term> {
  if (!term?.address) return term;
  try {
    const info = await run(["get", term.address, "--json"]);
    const found = (info?.terminal ?? info) as Json;
    return { ...term, ...found, labels: { ...(term.labels ?? {}), ...(found?.labels ?? {}) } };
  } catch {
    return term;
  }
}

/** A kept shell still carries the labels; only the configured agent counts as the helper. */
function isHelperProgram(term: Json, config: CoordinatorConfig): boolean {
  if (!isLive(term)) return false;
  const agent = String(term.agent ?? "");
  const argv = Array.isArray(term.argv) ? term.argv.join(" ") : String(term.argv ?? "");
  const names = config.cli === "claude" ? ["claude", "claude-code"] : ["codex"];
  return names.includes(agent) || argv.includes(config.cli);
}

export async function listHelpers(run: HelperRunner, space: string): Promise<Term[]> {
  const result = await run(["ls", "--json", "--label", HELPER_LABELS.role, "--label", HELPER_LABELS.space(space)]);
  return Promise.all(terminalList(result).map((term) => withLabels(run, term)));
}

export async function listCoordinators(run: HelperRunner): Promise<{ space: string; address: string; tab: string; cwd: string | null }[]> {
  const result = await run(["ls", "--json", "--label", "herdr.role=coordinator"]);
  const terms = await Promise.all(terminalList(result).map((term) => withLabels(run, term)));
  return terms.filter(isLive).flatMap((term) => {
    const space = term.labels?.["herdr.coordinator.space"];
    if (!space) return [];
    return [{
      space,
      address: term.address,
      tab: term.labels?.["herdr.coordinator.tab"] ?? term.address,
      cwd: typeof term.cwd === "string" && term.cwd ? term.cwd : null,
    }];
  });
}

export async function findCoordinator(run: HelperRunner, space: string): Promise<{ address: string; tab: string; cwd: string | null }> {
  const result = await run(["ls", "--json", "--label", "herdr.role=coordinator", "--label", `herdr.coordinator.space=${space}`]);
  const terms = await Promise.all(terminalList(result).map((term) => withLabels(run, term)));
  const term = terms.find(isLive);
  if (!term) throw new Error(`space ${space} has no live Coordinator terminal`);
  return {
    address: term.address,
    tab: term.labels?.["herdr.coordinator.tab"] ?? term.address,
    cwd: typeof term.cwd === "string" && term.cwd ? term.cwd : null,
  };
}

const stripFrontmatter = (value: string): string => value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

function bootPrompt(options: HelperJobOptions): string {
  const role = stripFrontmatter(readFileSync(options.rolePromptRef, "utf8")).trim();
  return `${role}\n\n---\nYou are the persistent Coordinator helper for space ${options.space}. Stay in this session; one job arrives at a time as a JSON file, and you write exactly one Decision JSON to the output path named in that job. Never write the Ledger or policy, never spawn a task yourself, and never answer in prose. Reply READY.`;
}

function jobPrompt(options: HelperJobOptions, jobPath: string, outputPath: string): string {
  return [
    `Collie helper job for space ${options.space}.`,
    `Job JSON: ${jobPath}`,
    `Decision output: ${outputPath}`,
    `Role: ${options.rolePromptRef}`,
    "Read the job, follow the role prompt and the job snapshot/policy, and write one Decision JSON to the output path.",
    "Every action needs kind and risk_tags ([] when none). spawn_task needs spawn{title,brief_ref,base,access}; ask needs ask{kind,question,options}; waiting needs a card.",
    "Include playbook{name,version} when the Decision selects one; at most one spawn_task per Decision.",
    "For spawn_task set brief_ref to /pending/brief; the service renders the trusted brief.",
    "Do not write the Ledger or policy and do not spawn anything yourself. Reply DONE.",
  ].join("\n");
}

const sleepDefault = (ms: number) => {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  setTimeout(done, ms);
  return promise;
};

async function sendWhenIdle(run: HelperRunner, address: string, text: string, options: HelperJobOptions): Promise<void> {
  const sleep = options.sleep ?? sleepDefault;
  const interval = options.pollIntervalMs ?? 500;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let last: unknown = null;
  for (;;) {
    let status: string | null = null;
    try {
      const info = await run(["get", address, "--json"]);
      const raw = (info.terminal ?? info)?.status;
      status = typeof raw === "string" ? raw : raw?.state ?? null;
    } catch {}
    if (status === "blocked") throw new Error(`helper ${address} is blocked; answer it in the helper terminal`);
    if (status !== "working") {
      try {
        await run(["send", address, text, "--json"]);
        return;
      } catch (error) {
        last = error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`helper ${address} did not accept a prompt: ${last instanceof Error ? last.message : String(last)}`);
    }
    await sleep(interval);
  }
}

export async function ensureHelper(options: HelperJobOptions): Promise<HelperHandle> {
  const run = options.run ?? defaultHelperRunner;
  const coordinator = options.coordinatorAddress
    ? { address: options.coordinatorAddress, tab: options.coordinatorTab ?? options.coordinatorAddress, cwd: null as string | null }
    : await findCoordinator(run, options.space);
  const folder = coordinator.cwd ?? options.folder;
  if (!folder) throw new Error(`space ${options.space} has no folder to start the Coordinator helper in`);

  const found = await listHelpers(run, options.space);
  const alive = found.find((term) => isHelperProgram(term, options.config));
  if (alive) return { address: alive.address, created: false, space: options.space, tab: coordinator.tab };

  // A kept terminal whose program is gone still owns the labels and the name. Remove it first.
  for (const stale of found) {
    if (!stale.address) continue;
    try { await run(["kill", stale.address]); } catch {}
    try { await run(["rm", stale.address]); } catch {}
  }

  const writeDir = decisionsDir(options.stateDir, options.space);
  mkdirSync(writeDir, { recursive: true });
  const result = await run([
    "run", "--bg", "--keep", "--json", "--name", helperName(options.space), "--cwd", folder,
    "--parent", coordinator.address,
    "--label", HELPER_LABELS.role,
    "--label", HELPER_LABELS.space(options.space),
    "--label", HELPER_LABELS.coordinator(coordinator.tab),
    "--", ...helperCliArgs(options.config, writeDir),
  ]);
  const address = result.address ?? result.terminal?.address ?? result.id;
  if (typeof address !== "string" || !address) throw new Error("hc run did not return a helper terminal address");
  const bootWait = options.bootWaitMs ?? 0;
  if (bootWait > 0) {
    const sleep = options.sleep ?? sleepDefault;
    const deadline = Date.now() + bootWait;
    while (Date.now() < deadline) {
      const info = await run(["get", address, "--json"]).catch(() => null);
      const raw = (info?.terminal ?? info)?.status;
      const status = typeof raw === "string" ? raw : raw?.state ?? null;
      if (status === "idle" || status === "done") break;
      await sleep(options.pollIntervalMs ?? 500);
    }
  }
  await sendWhenIdle(run, address, bootPrompt(options), options);
  return { address, created: true, space: options.space, tab: coordinator.tab };
}

export function validateProposal(value: unknown, options: { space: string; at: string }): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("helper Decision must be a JSON object");
  const proposal = value as Json;
  if (!["open", "waiting", "settled"].includes(proposal.state)) throw new Error("helper Decision needs state = open | waiting | settled");
  if (typeof proposal.why !== "string" || !proposal.why.trim() || proposal.why.length > 140) {
    throw new Error("helper Decision needs why ≤ 140 chars");
  }
  if (!Array.isArray(proposal.actions)) throw new Error("helper Decision needs an actions array");

  const run: Json = { task_ref: null, coordinator_ref: null };
  if (proposal.run && typeof proposal.run === "object" && proposal.run.kind) run.kind = proposal.run.kind;
  const playbook = proposal.playbook ?? null;
  const waiting = proposal.state === "waiting";
  const priorityAction = proposal.actions.find((action: Json) => action.kind === "priority");
  const holdAction = proposal.actions.find((action: Json) => action.kind === "hold");
  const policyAction = proposal.actions.find((action: Json) => action.kind === "propose_policy");
  const priority = priorityAction?.priority ? { value: priorityAction.priority.value, set_at: options.at } : null;
  const hold = holdAction?.hold ? { until: holdAction.hold.until ?? null, reason: holdAction.hold.reason } : null;
  const policy = policyAction?.rule ? { ...policyAction.rule } : null;
  const candidate = {
    id: "dc_00000000", key: "helper:validate", space: options.space,
    space_candidates: [options.space], event_ref: null, case_ref: null,
    state: proposal.state, why: proposal.why, decided_by: "coordinator", decided_at: options.at,
    playbook,
    occurrence: { object_key: "none:helper", kind: "none", round: 1, hops: 0 },
    actions: proposal.actions,
    risk: { tags: [], forced_waiting: false },
    run,
    human_boundary: { form: waiting ? "card" : "none", chat_injection: false },
    priority,
    hold,
    card: waiting ? proposal.card ?? null : null,
    receipt_ref: null,
    proposal: policy,
    ack: null,
    settled: null,
  };
  if (proposal.state === "settled") {
    Object.assign(candidate, settle(candidate, {
      at: options.at, by: "coordinator", outcome: proposal.settled?.outcome ?? "dropped",
    }));
  }
  const result = protocol.validate(candidate, "urn:collie:decision:v1");
  if (!result.valid) {
    throw new Error(`helper Decision is invalid: ${result.errors.map((error: Json) => `${error.path || "/"} ${error.message}`).join("; ")}`);
  }
  return {
    state: proposal.state,
    why: proposal.why,
    actions: proposal.actions,
    ...(playbook ? { playbook } : {}),
    ...(run.kind ? { run: { kind: run.kind } } : {}),
    ...(priority ? { priority } : {}),
    ...(hold ? { hold } : {}),
    ...(waiting ? { card: proposal.card } : {}),
    ...(policy ? { proposal: policy } : {}),
    ...(candidate.settled ? { settled: candidate.settled } : {}),
  };
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

async function waitForDecision(path: string, options: HelperJobOptions): Promise<Json> {
  const sleep = options.sleep ?? sleepDefault;
  const interval = options.pollIntervalMs ?? 500;
  const timeout = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeout;
  let lastError: unknown = null;
  for (;;) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "state" in parsed && "actions" in parsed) return parsed;
        lastError = new Error("Decision file has no state/actions yet");
      } catch (error) { lastError = error; }
    }
    if (Date.now() >= deadline) {
      throw new Error(`helper did not write ${path} within ${timeout}ms${lastError ? `: ${lastError instanceof Error ? lastError.message : lastError}` : ""}`);
    }
    await sleep(interval);
  }
}

/** One job at a time per space: the helper session is a serial queue, not a pool. */
const queues = new Map<string, Promise<unknown>>();
export function enqueueHelperJob<T>(space: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(space) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(space, next.catch(() => {}));
  return next;
}

export async function runHelperJob(job: Json, options: HelperJobOptions): Promise<HelperResult> {
  const run = options.run ?? defaultHelperRunner;
  const now = options.now ?? (() => new Date());
  const at = now().toISOString();
  const id = `hj_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const jobs = jobsDir(options.stateDir, options.space);
  const decisions = decisionsDir(options.stateDir, options.space);
  mkdirSync(jobs, { recursive: true });
  mkdirSync(decisions, { recursive: true });
  const jobPath = join(jobs, `${id}.json`);
  const outputPath = join(decisions, `${id}.json`);
  const jobDoc = {
    version: 1,
    id,
    space: options.space,
    created_at: at,
    job,
    instruction: {
      role_prompt_ref: options.rolePromptRef,
      output_contract: "urn:collie:decision:v1",
      output_path: outputPath,
    },
  };
  writeAtomic(jobPath, JSON.stringify(jobDoc, null, 2) + "\n");

  const helper = await ensureHelper(options);
  await sendWhenIdle(run, helper.address, jobPrompt(options, jobPath, outputPath), options);
  const proposal = await waitForDecision(outputPath, options);
  return { decision: validateProposal(proposal, { space: options.space, at }), address: helper.address };
}
