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

// Queue dependencies are metadata on a todo Task, never another Task state.
export function todoReason(target, decision) {
  const dependsOn = Array.isArray(target?.depends_on) ? target.depends_on : [];
  if (dependsOn.length) return `after ${dependsOn.join(", ")}`;
  if (target?.state === "todo") return "not started";
  return decision?.why ?? null;
}

// The only Task states visible to Collie.
export function taskLifecycle(task) {
  const state = String(task?.state ?? "");
  return state === "running" || state === "ready" || state === "done" ? state : "todo";
}

// Working phase: build / review / verify. It is a live-agent label, not a Task state.
export function workKind(decision, target, live = {}) {
  if (live.verifier) return "verify";
  if (live.reviewer || (decision?.run?.kind === "review" && live.driver)) return "review";
  return decision?.run?.kind === "review" ? "review" : "build";
}

// live: { driver, reviewer, verifier, blocked } from the Work's live agents.
// Decision settled/waiting wins first, then live blocked/roles, then Task ready/done/running.
// A running Task stays Working without a live terminal; done without a settled Decision is Settled.
// An unreadable task_ref retains Working history; an unrelated open Decision is Todo.
export function ticketStage(decision, target, live = {}) {
  const state = decision?.state;
  if (state === "settled" || decision?.settled) return "settled";
  if (state === "waiting") return "needs";
  if (live.blocked) return "needs";
  if (live.driver || live.reviewer || live.verifier || live.other) return "working";
  const lifecycle = taskLifecycle(target);
  if (lifecycle === "ready") return "needs";
  if (lifecycle === "done") return "settled";
  if (lifecycle === "running") return "working";
  // A task_ref without a readable task (remote, ended, or a seeded ticket) still means a Work ran.
  if (decision?.run?.task_ref && (!target || !target.state)) return "working";
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
  // Working: newest first; Todo: the oldest first.
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

// Decision.run.task_ref and Receipt.task.id are the task's canonical ref (for example COLL-42).
function matchingKey(id, groups) {
  if (!id) return null;
  const matches = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const task of group?.tasks ?? []) {
      if (task.ref !== undefined && String(task.ref) === id) matches.push({ group, task });
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
  const helper = (role) => ["reviewer", "verifier", "helper"].includes(role);
  // The ticket's fixed terminal is the driver. Helpers are separate hc children; their
  // tabs are opened from the live role list, not by stealing the driver's terminal block.
  const driver = live.find((agent) => typeof agent === "string"
    ? Boolean(agent)
    : agent?.address && !helper(agent.role));
  // With no live driver, only the driver's own history may supply the Terminal. A helper is
  // always a separate role tab, never a fallback driver.
  const address = typeof driver === "string" ? driver : driver?.address ?? last?.address;
  const spawn = decision.actions?.find((a) => a.kind === "spawn_task")?.spawn;
  return {
    decision: decision.id,
    project: spawn?.project ?? null,
    playbook: task.playbook ?? decision.playbook?.id ?? null,
    ref: String(task.ref),
    title: task.title ?? spawn?.title ?? decision.card?.question ?? decision.why,
    state: task.state ?? null,
    folder: group.folder,
    worktree: task.worktree ?? null,
    machine,
    branch: task.branch ?? null,
    base: task.base ?? null,
    start: task.start ?? null,
    base_set: task.base_set === true,
    agents: Array.isArray(task.agents) ? task.agents : [],
    live,
    depends_on: Array.isArray(task.depends_on) ? task.depends_on : [],
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

// Tasks without Decisions are synthetic Work. Canonical refs alone deduplicate the two sources.
export function orphanTickets(decisions, groups) {
  const linked = new Set(decisions.map((decision) => decision?.run?.task_ref).filter(Boolean).map(String));
  const out = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const task of group?.tasks ?? []) {
      if (!task.space || !task.ref || linked.has(String(task.ref))) continue;
      const at = task.done_at ?? task.ready_at ?? task.started_at ?? task.created_at ?? task.agents?.at(-1)?.at ?? Date.now();
      const done = task.state === "done";
      const project = String(group.folder ?? "").split("/").filter(Boolean).pop() || null;
      out.push({
        id: `task:${task.ref}`,
        ...(project ? { project } : {}),
        state: done ? "settled" : "open",
        decided_at: new Date(at).toISOString(),
        ...(done ? { settled: { at: new Date(at).toISOString(), outcome: "done" } } : {}),
        space: task.space,
        title: task.title ?? task.ref,
        why: task.why ?? null,
        synthetic: true,
        run: { task_ref: task.ref },
      });
    }
  }
  return out;
}

const driverRole = (role) => !role || role === "driver" || role === "worker";

// Live helper roles, merging the task record with current terminal labels. Drivers stay in the
// fixed Ticket Terminal; the returned agents are rendered as separate Herdr tabs.
export function taskAgents(target, terms = []) {
  const key = target?.key;
  const label = key ? `${key.slug}#${key.id}` : null;
  const byAddress = new Map();
  for (const raw of Array.isArray(target?.live) ? target.live : []) {
    const agent = typeof raw === "string" ? { address: raw, role: "worker" } : raw;
    if (agent?.address) byAddress.set(agent.address, agent);
  }
  if (label) for (const term of terms) {
    if (term.state !== "live" || term.labels?.["herdr.task"] !== label) continue;
    const old = byAddress.get(term.address) ?? {};
    byAddress.set(term.address, { ...old, address: term.address, role: old.role ?? term.labels?.["herdr.role"] ?? "worker", status: old.status ?? term.status });
  }
  return [...byAddress.values()].filter((agent) => agent.address && !driverRole(agent.role) && agent.status !== "done");
}