// Pure, read-only projections for mods/collie-inbox. No herdr/service imports and no second state machine.
const STATE = ".local/state/collie";
const root = (home) => String(home ?? "").replace(/\/+$/, "");
const time = (value) => Date.parse(value ?? "") || 0;

export const queuePath = (home) => `${root(home)}/${STATE}/queue.json`;
export const receiptPath = (home, ref) => /^rc_[0-9a-z]{8,32}$/.test(ref ?? "")
  ? `${root(home)}/${STATE}/receipts/${ref}.json`
  : null;

export function parseQueue(text) {
  if (text === null || text === undefined || !String(text).trim()) return [];
  const value = JSON.parse(String(text));
  if (!value || typeof value !== "object" || !Array.isArray(value.decisions)) {
    throw new Error("queue.json must contain a decisions array");
  }
  return value.decisions;
}

// The one human queue: waiting Decisions, by priority then age. Holds sink.
export function waitingQueue(decisions) {
  return decisions.filter((d) => d?.state === "waiting").sort((a, b) =>
    Number(Boolean(a.hold)) - Number(Boolean(b.hold))
    || (a.priority?.value ?? 5) - (b.priority?.value ?? 5)
    || time(a.decided_at ?? a.card?.created_at) - time(b.decided_at ?? b.card?.created_at)
    || String(a.id).localeCompare(String(b.id)));
}

export const workingDecisions = (decisions) => decisions
  .filter((d) => d?.state === "open")
  .sort((a, b) => time(b.decided_at) - time(a.decided_at) || String(a.id).localeCompare(String(b.id)));

// Settled is the Decision's terminal state (with a settled record), never "done history".
export const settledDecisions = (decisions) => decisions
  .filter((d) => d?.state === "settled" || Boolean(d?.settled))
  .sort((a, b) => time(b.settled?.at ?? b.decided_at) - time(a.settled?.at ?? a.decided_at));

export const workingCount = (decisions) => workingDecisions(decisions).length;

// Work states. The person's four states are the projection; the Decision machine has three.
export const STAGE_WORD = {
  needs: "Needs you", todo: "Todo", working: "Working", settled: "Settled",
};

// A waiting Decision whose Card is an accept/rework (its task said ready) is the positive one.
export const ticketNeed = (decision) =>
  decision?.receipt_ref || decision?.card?.kind === "accept" ? "ready" : "needs";

// Herdr-task's own states stay below Work: queue/scheduled are Todo's reasons.
export function todoReason(target, decision) {
  const state = String(target?.state ?? "");
  if (!state) return decision?.why ?? null;
  if (state === "scheduled") return "scheduled";
  if (state === "queued") {
    const after = [...new Set([
      ...(Array.isArray(target.after) ? target.after : []),
      ...(Array.isArray(target.after_ext) ? target.after_ext : []),
      ...(Array.isArray(target.waiting_for) ? target.waiting_for : []),
      ...(Array.isArray(target.waiting_ext) ? target.waiting_ext : []),
    ])];
    return after.length ? `after ${after.join(", ")}` : "waiting for a slot";
  }
  if (state === "todo") return "not started";
  return decision?.why ?? null;
}

// Working phase: build / review / verify / merge. It is a label, not a state.
export function workKind(decision, target, live = {}) {
  if (live.verifier) return "verify";
  if (live.reviewer || (decision?.run?.kind === "review" && live.driver)) return "review";
  if (target?.state === "merging" || decision?.run?.phase === "merging") return "merge";
  return decision?.run?.kind === "review" ? "review" : "build";
}

// live: { driver, reviewer, verifier, blocked } from the Work's live agents.
export function ticketStage(decision, target, live = {}) {
  const state = decision?.state;
  if (state === "settled" || decision?.settled) return "settled";
  if (state === "waiting") return "needs";
  if (live.blocked) return "needs";
  if (live.driver || live.reviewer || live.verifier) return "working";
  const task = String(target?.state ?? "");
  // A readable queued/scheduled/todo task is still Todo, even though the Decision has a task_ref.
  if (["queued", "scheduled", "todo"].includes(task)) return "todo";
  // A task_ref without a readable task (remote, ended, or a seeded ticket) still means a Work ran.
  if (decision?.run?.task_ref) return "working";
  if (["running", "ready", "merging", "done"].includes(task)) return "working";
  return "todo";
}

// Needs you / each project's Todo→Working / Settled. `items`: [{ decision, stage, target }].
const GROUP_RANK = { todo: 0, working: 1 };
const needOrder = (a, b) => Number(Boolean(a.decision.hold)) - Number(Boolean(b.decision.hold))
  || (a.decision.priority?.value ?? 5) - (b.decision.priority?.value ?? 5)
  || time(a.decision.decided_at ?? a.decision.card?.created_at) - time(b.decision.decided_at ?? b.decision.card?.created_at)
  || String(a.decision.id).localeCompare(String(b.decision.id));

export function ticketGroup(items) {
  const all = (Array.isArray(items) ? items : []).filter((x) => x?.decision && x.stage);
  const top = all.filter((x) => x.stage === "needs").sort(needOrder);
  const settled = all.filter((x) => x.stage === "settled")
    .sort((a, b) => time(b.decision.settled?.at ?? b.decision.decided_at) - time(a.decision.settled?.at ?? a.decision.decided_at)
      || String(a.decision.id).localeCompare(String(b.decision.id)));
  const rest = all.filter((x) => ["todo", "working"].includes(x.stage));
  const rank = (x) => GROUP_RANK[x.stage] ?? 99;
  const when = (x) => time(x.decision.decided_at);
  // Working: newest first; Todo (queue/scheduled): the oldest first.
  const sorted = (a, b) => rank(a) - rank(b)
    || (a.stage === "working" ? when(b) - when(a) : when(a) - when(b))
    || String(a.decision.id).localeCompare(String(b.decision.id));
  // A project is the execution grouping: explicit Decision.project, else the task folder,
  // else the space (older tickets had no project dimension).
  const projectOf = (x) => String(x.decision.project ?? x.target?.project ?? x.target?.folder ?? x.decision.space ?? "");
  const byProject = new Map();
  for (const x of rest) {
    const key = projectOf(x);
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(x);
  }
  const projects = [...byProject.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({ key, rows: byProject.get(key).sort(sorted) }));
  return { top, projects, settled };
}

const prefixed = (machine, address) => machine && address && !String(address).includes("/")
  ? `${machine}/${address}`
  : address ?? null;

function matchingTask(receipt, groups) {
  const id = receipt?.task?.id;
  if ((typeof id !== "string" && typeof id !== "number") || !String(id)) return null;
  return matchingKey(String(id), groups);
}

// A Decision's run.task_ref is the task's key ("folder#id"), ref ("CEENF-1") or id. Open
// Decisions have no receipt yet; the task list still links them.
function matchingKey(id, groups) {
  if (!id) return null;
  const matches = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const task of group?.tasks ?? []) {
      if ([task.ref, task.key, task.id].some((value) => value !== undefined && String(value) === id)) {
        matches.push({ group, task });
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

// A navigation link, not a second state: it is resolved only when a row is opened.
export function taskTarget(decision, receipt, groups, detail = null) {
  if (!decision?.id) return null;
  const found = receipt?.decision_ref === decision.id ? matchingTask(receipt, groups) : null;
  const linked = found ?? matchingKey(decision.run?.task_ref, groups);
  if (!linked) return null;
  const group = linked.group;
  const task = { ...linked.task, ...detail };
  if (typeof group.folder !== "string" || !group.folder) return null;
  const machine = group.machine ?? task.machine ?? null;
  const last = task.agents?.at(-1);
  const live = Array.isArray(task.live) ? task.live : [];
  const agent = live.at(-1);
  const address = typeof agent === "string" ? agent : agent?.address ?? last?.address;
  const spawn = decision.actions?.find((a) => a.kind === "spawn_task")?.spawn;
  return {
    decision: decision.id,
    project: spawn?.project ?? null,
    playbook: task.playbook ?? decision.playbook?.id ?? null,
    verification: Array.isArray(task.verifications) ? task.verifications.at(-1) ?? null : null,
    ref: String(task.ref ?? task.key ?? task.id),
    title: task.title ?? spawn?.title ?? decision.card?.question ?? decision.why,
    state: task.state ?? null,
    folder: group.folder,
    worktree: task.worktree ?? null,
    machine,
    branch: task.branch ?? null,
    base: task.base ?? null,
    start: task.start ?? null,
    pr: task.pr ?? null,
    base_set: task.base_set === true,
    agents: Array.isArray(task.agents) ? task.agents : [],
    live,
    after: Array.isArray(task.after) ? task.after : [],
    after_ext: Array.isArray(task.after_ext) ? task.after_ext : [],
    waiting_for: Array.isArray(task.waiting_for) ? task.waiting_for : [],
    waiting_ext: Array.isArray(task.waiting_ext) ? task.waiting_ext : [],
    progress: task.progress ?? null,
    proof: task.proof ?? null,
    terminal: prefixed(machine, address),
    key: (group.slug ?? task.key?.split("#")[0]) && task.id !== undefined
      ? { machine, folder: group.folder, slug: group.slug ?? task.key.split("#")[0], id: task.id }
      : null,
    log: last?.log ? { path: last.log, kind: last.agent ?? null } : null,
    note: address ? null : "This task hasn't started.",
  };
}

export function diffTarget(target) {
  const cwd = target?.worktree ?? target?.folder;
  const start = target?.start ?? target?.base;
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
  if (typeof start !== "string" || !start || start.startsWith("-") || /\s/.test(start)) return null;
  return { cwd, on: target.machine ?? undefined, range: `${start}...HEAD` };
}