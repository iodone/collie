import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Json = Record<string, any>;
export type TaskRunner = (args: string[]) => Promise<Json>;

export interface HerdrAgentOptions {
  run?: TaskRunner;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  onSpawn?: (task: SpawnedTask) => Promise<void> | void;
}

export interface SpawnedTask {
  ref: string;
  folder: string;
  space: string;
  project?: string;
  previousState: string;
}

export const defaultHerdrRunner: TaskRunner = async (args) => {
  const { stdout } = await execFileAsync(process.env.COLLIE_TASK_CLI ?? "collie-task", args, { maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
};

export async function runningHerdrTasks(space: string, options: HerdrAgentOptions = {}): Promise<Json[]> {
  const groups = await (options.run ?? defaultHerdrRunner)(["list", "--all", "--slim", "--json"]);
  const now = (options.now ?? (() => new Date()))();
  const tasks = (Array.isArray(groups) ? groups : [groups]).flatMap((group) => Array.isArray(group?.tasks) ? group.tasks : []);
  return tasks.filter((task) => task?.state === "running" && task?.space === space).slice(0, 16).map((task) => {
    if (task.started_at === null || task.started_at === undefined) throw new Error(`running task ${String(task.ref)} has no started_at`);
    const changed = new Date(task.started_at);
    if (Number.isNaN(changed.getTime())) throw new Error(`running task ${String(task.ref)} has no valid started_at`);
    return {
      task_id: text(task.ref, "running task ref"),
      state: "running",
      state_changed_at: changed.toISOString(),
      elapsed_seconds: Math.max(0, Math.floor((now.getTime() - changed.getTime()) / 1000)),
    };
  });
}

const defaultRunner = defaultHerdrRunner;
const iso = (value: unknown, fallback: Date): string => {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string" && value) return new Date(value).toISOString();
  return fallback.toISOString();
};
const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`ready task is missing ${field}`);
  return value;
};
const receiptId = () => `rc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const taskRef = (result: Json): string => {
  const ref = result.ref;
  if (typeof ref !== "string" || !ref.trim() || ref.length > 240) {
    throw new Error("collie-task add --json returned no canonical task ref");
  }
  return ref;
};

function spawnAction(decision: Json): Json {
  if (decision.human_boundary?.chat_injection !== false) throw new Error("machine events must not enter chat");
  if (decision.risk?.forced_waiting) throw new Error("guarded decisions require a card before dispatch");
  const actions = decision.actions?.filter((action: Json) => action.kind === "spawn_task") ?? [];
  if (actions.length !== 1) throw new Error(`M1 requires exactly one spawn_task action, got ${actions.length}`);
  const spawn = actions[0].spawn;
  if (!spawn) throw new Error("spawn_task action has no spawn payload");
  if (typeof spawn.title !== "string" || !/^(?![\s-])[^{}\r\n]{1,200}$/.test(spawn.title)) {
    throw new Error("spawn.title is not a safe collie-task title");
  }
  if (typeof spawn.brief_ref !== "string" || !/^\/[^\s]+$/.test(spawn.brief_ref)) {
    throw new Error("spawn.brief_ref must be an absolute path");
  }
  return spawn;
}

export async function spawnHerdrTask(
  decision: Json,
  rule: Json,
  options: HerdrAgentOptions = {},
): Promise<SpawnedTask> {
  const run = options.run ?? defaultRunner;
  const spawn = spawnAction(decision);
  const configuredFolder = rule.to?.cwd?.path;
  if (rule.to?.kind !== "herdr_task" || rule.to?.cwd?.kind !== "git" || typeof configuredFolder !== "string") {
    throw new Error("herdr agent requires a herdr_task rule with a git cwd");
  }
  const folder = configuredFolder.startsWith("~/") ? `${homedir()}${configuredFolder.slice(1)}` : configuredFolder;
  const space = rule.to.space ?? decision.space;
  if (typeof space !== "string" || !space) throw new Error("spawn requires a space");

  const args = [
    "add", spawn.title, "--folder", folder, "--space", space, "--json",
    "--prompt-file", spawn.brief_ref, "--worktree",
  ];
  if (rule.to.playbook) args.push("--set", `playbook=${rule.to.playbook.name}@${rule.to.playbook.version}`);
  if (spawn.base === "branch") args.push("--base", text(spawn.branch, "spawn.branch"));
  else if (spawn.base === "main") args.push("--base", "main");
  if (rule.agent?.cli) args.push("--agent", rule.agent.cli);
  if (rule.agent?.model) args.push("--model", rule.agent.model);
  if (rule.agent?.effort) args.push("--effort", rule.agent.effort);

  const added = await run(args);
  const ref = taskRef(added);
  await run(["start", ref, "--folder", folder, "--space", space, "--json"]);
  return {
    ref, folder, space,
    ...(rule.to.project ? { project: rule.to.project } : {}), previousState: "todo",
  };
}

export async function waitForHerdrReceipt(
  task: SpawnedTask,
  decision: Json,
  options: HerdrAgentOptions = {},
): Promise<Json> {
  const run = options.run ?? defaultRunner;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = options.pollIntervalMs ?? 5_000;
  const maxPolls = options.maxPolls ?? 720;
  let previousState = task.previousState;

  for (let poll = 0; poll < maxPolls; poll += 1) {
    const view = await run(["show", task.ref, "--folder", task.folder, "--json", "--evidence"]);
    const state = view.state;
    if (state !== "ready") {
      if (state === "done") throw new Error("task reached done before a ready receipt was collected");
      if (typeof state !== "string") throw new Error("collie-task show returned no state");
      previousState = state;
      if (poll + 1 < maxPolls) await sleep(interval);
      continue;
    }

    const received = now();
    const evidence = view.evidence ?? {};
    const summary = text(evidence.summary ?? view.summary, "summary");
    const details = text(evidence.details ?? view.details, "details");
    const proof = evidence.proof ?? view.proof;
    if (!proof || typeof proof !== "object") throw new Error("ready task is missing proof");
    const proofId = text(proof.id, "proof id");
    const proofTitle = text(proof.title, "proof title");
    const commits = (evidence.commits?.list ?? []).map((row: unknown) =>
      Array.isArray(row) ? `commit:${row[0]}` : `commit:${String(row)}`,
    );
    const proofRef = `artifact:${proofId}`;
    const refs = [...new Set([...commits, proofRef])] as string[];

    return {
      id: receiptId(),
      decision_ref: decision.id,
      received_at: received.toISOString(),
      origin: "herdr-task ready",
      task: {
        id: task.ref,
        space: task.space,
        state: "ready",
        previous_state: previousState,
        state_changed_at: iso(view.ready_at, received),
        started_at: iso(view.started_at, received),
      },
      progress: {
        basis: "task_state_advance",
        advanced: previousState !== "ready",
        verdict: "advanced",
      },
      summary,
      details,
      proof: {
        id: proofId,
        title: proofTitle,
        refs,
      },
    };
  }
  throw new Error(`task ${task.ref} did not reach ready after ${maxPolls} polls`);
}

export async function runHerdrTask(
  decision: Json,
  rule: Json,
  options: HerdrAgentOptions = {},
): Promise<Json> {
  const task = await spawnHerdrTask(decision, rule, options);
  await options.onSpawn?.(task);
  return waitForHerdrReceipt(task, decision, options);
}
