// Pure, read-only projections for mods/collie. No herdr/service imports and no task-state synthesis.
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

// Queue is exactly the persisted waiting Decisions. Tasks and receipts only supply navigation below.
export function waitingQueue(decisions) {
  return decisions.filter((d) => d?.state === "waiting").sort((a, b) =>
    Number(Boolean(a.hold)) - Number(Boolean(b.hold))
    || (a.priority?.value ?? 5) - (b.priority?.value ?? 5)
    || time(a.decided_at ?? a.card?.created_at) - time(b.decided_at ?? b.card?.created_at)
    || String(a.id).localeCompare(String(b.id)));
}

export const workingDecisions = (decisions) => decisions
  .filter((d) => d?.state === "routed" || d?.state === "acting")
  .sort((a, b) => time(b.decided_at) - time(a.decided_at) || String(a.id).localeCompare(String(b.id)));

export const settledDecisions = (decisions) => decisions
  .filter((d) => ["done", "closed", "failed"].includes(d?.state))
  .sort((a, b) => time(b.settled?.at ?? b.decided_at) - time(a.settled?.at ?? a.decided_at));

export const workingCount = (decisions) => workingDecisions(decisions).length;

const prefixed = (machine, address) => machine && address && !String(address).includes("/")
  ? `${machine}/${address}`
  : address ?? null;

function matchingTask(receipt, groups) {
  const id = receipt?.task?.id;
  if ((typeof id !== "string" && typeof id !== "number") || !String(id)) return null;
  const matches = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const task of group?.tasks ?? []) {
      if ([task.ref, task.key, task.id].some((value) => value !== undefined && String(value) === String(id))) {
        matches.push({ group, task });
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

// A navigation link, not a second task state: it is resolved only when a row is opened.
export function taskTarget(decision, receipt, groups, detail = null) {
  if (!decision?.id || receipt?.decision_ref !== decision.id) return null;
  const found = matchingTask(receipt, groups);
  if (!found) return null;
  const group = found.group;
  const task = { ...found.task, ...detail };
  if (typeof group.folder !== "string" || !group.folder) return null;
  const machine = group.machine ?? task.machine ?? null;
  const last = task.agents?.at(-1);
  const live = task.live?.at(-1);
  const address = typeof live === "string" ? live : live?.address ?? last?.address;
  const spawn = decision.actions?.find((a) => a.kind === "spawn_task")?.spawn;
  return {
    decision: decision.id,
    ref: String(task.ref ?? task.key ?? task.id),
    title: task.title ?? spawn?.title ?? decision.card?.question ?? decision.why,
    folder: group.folder,
    worktree: task.worktree ?? null,
    machine,
    branch: task.branch ?? null,
    base: task.base ?? null,
    start: task.start ?? null,
    pr: task.pr ?? null,
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
