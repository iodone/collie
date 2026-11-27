import { resolve } from "node:path";
import { Ledger, ledgerId } from "./ledger.ts";
import type { Dispatch } from "./ingress.ts";
import { applyGuard, checkBudget, checkPriorityChange, nextHops, settle } from "../protocol/invariants.mjs";
import { RECENT_DECISIONS_MAX, SNAPSHOT_BYTES_MAX } from "../protocol/constants.mjs";
import { loadProtocol } from "../protocol/validate.mjs";

type Json = Record<string, any>;
const protocol = await loadProtocol(resolve(new URL("../protocol", import.meta.url).pathname));
const assertValid = (value: Json, urn: string) => {
  const result = protocol.validate(value, urn);
  if (!result.valid) throw new Error(`${urn}: ${JSON.stringify(result.errors)}`);
};

export interface CoordinateOptions {
  ledger: Ledger;
  ruleset: Json;
  decide: (job: Json) => Promise<Json> | Json;
  now?: () => Date;
  spaceNote?: string;
  running?: Json[];
  activeTasks?: Json[];
  rolePromptRef?: string;
  policy?: string;
  origin?: "event" | "human";
  decided_by?: "system" | "coordinator" | "human";
  playbook?: { name: string; version: number };
  catalog?: Json;
  onDecision?: (decision: Json) => void;
  decisionId?: string;
  beforeCommit?: (decision: Json) => Promise<Json> | Json;
  /** Run a deferred budget Todo immediately without creating another waiting Card. */
  ignoreBudget?: boolean;
}

const messageOf = (dispatch: Dispatch): Json => dispatch.message ?? dispatch.event;

function activeSnapshot(ledger: Ledger, space: string, rawTasks: Json[]): Json[] {
  const tasks = rawTasks.filter((task) => task?.space === space && task?.state !== "done" && task?.ref);
  const byRef = new Map(tasks.map((task) => [String(task.ref), task]));
  const active = ledger.decisions
    .filter((decision) => decision.space === space && ["open", "waiting"].includes(decision.state))
    .sort((a, b) => Date.parse(b.decided_at ?? "") - Date.parse(a.decided_at ?? "") || String(b.id).localeCompare(String(a.id)))
    .slice(0, RECENT_DECISIONS_MAX)
    .map((decision) => {
      const spawn = decision.actions?.find((action: Json) => action.kind === "spawn_task")?.spawn;
      const task = decision.run?.task_ref ? byRef.get(String(decision.run.task_ref)) : null;
      return {
        decision_id: decision.id, task_ref: decision.run?.task_ref ?? null, kind: decision.run?.kind ?? null,
        goal: String(spawn?.title ?? decision.title ?? decision.why ?? decision.id).slice(0, 200),
        detail_ref: spawn?.brief_ref ?? null,
        decision_state: decision.state, task_state: task?.state ?? null,
      };
    });
  const linked = new Set(active.map((item) => item.task_ref).filter(Boolean));
  const orphans = tasks.filter((task) => !linked.has(String(task.ref)))
    .sort((a, b) => String(a.ref).localeCompare(String(b.ref)))
    .map((task) => ({
      decision_id: null, task_ref: String(task.ref), kind: null,
      goal: String(task.title ?? task.ref).slice(0, 200), detail_ref: null,
      decision_state: null, task_state: task.state,
    }));
  return [...active, ...orphans].slice(0, RECENT_DECISIONS_MAX);
}

const baseDecision = (dispatch: Dispatch, at: string, caseRef: string | null, meta: Json = {}): Json => {
  const message = messageOf(dispatch);
  return {
  id: ledgerId("dc"),
  key: message.source === "human" ? message.key : `${message.source}:${message.key}`,
  space: dispatch.space,
  ...(message.project ? { project: message.project } : {}),
  space_candidates: message.space_candidates ?? [dispatch.space],
  event_ref: message.source === "human" ? null : message.id,
  case_ref: caseRef,
  state: "open",
  decided_by: "coordinator",
  decided_at: at,
  occurrence: {
    object_key: message.merge?.object_key ?? `${message.object?.kind ?? "none"}:${message.object?.id ?? message.id}`,
    kind: message.object?.kind ?? "none",
    round: 1,
    hops: message.hops ?? 0,
  },
  risk: { tags: [], forced_waiting: false },
  run: { task_ref: null, coordinator_ref: null },
  human_boundary: { form: "none", chat_injection: false },
  priority: null,
  hold: null,
  card: null,
  receipt_ref: null,
  proposal: null,
  ack: null,
  settled: null,
  ...meta,
  };
};

function budgetDecision(dispatch: Dispatch, at: string, reason: string): Json {
  return {
    ...baseDecision(dispatch, at, null),
    state: "open",
    why: reason,
    decided_by: "system",
    actions: [],
    human_boundary: { form: "none", chat_injection: false },
    card: null,
  };
}

export function recordOnlyDecision(dispatch: Dispatch, at: string): Json {
  const question = "委派跳数已熔断，请检查这条链";
  const decision = {
    ...baseDecision(dispatch, at, null),
    state: "waiting",
    why: `hops ${messageOf(dispatch).hops ?? 0} 超过上限，只记录不再派发`,
    decided_by: "system",
    actions: [{ kind: "ask", risk_tags: [], ask: { kind: "alert", question, options: ["drop"] } }],
    human_boundary: { form: "card", chat_injection: false },
    card: { kind: "alert", question, options: ["drop"], state: "open", created_at: at,
      acked_at: null, answer: null, snooze_until: null, closed_at: null },
  };
  assertValid(decision, "urn:collie:decision:v1");
  return decision;
}

export async function coordinate(dispatch: Dispatch, options: CoordinateOptions): Promise<Json> {
  if (dispatch.kind !== "coordinator") throw new Error(`coordinate only accepts coordinator dispatches, got ${dispatch.kind}`);
  const { ledger, ruleset, decide } = options;
  const at = (options.now ?? (() => new Date()))().toISOString();
  const message = messageOf(dispatch);
  const candidates = message.space_candidates ?? [dispatch.space];
  const recent = ledger.decisions.filter((decision) => decision.space === dispatch.space).slice(-RECENT_DECISIONS_MAX).reverse().map((decision) => ({
    decision_id: decision.id, object_key: decision.occurrence.object_key, why: decision.why,
  }));
  const queue = ledger.waiting().slice(0, RECENT_DECISIONS_MAX).map((decision) => ({ key: decision.key, why: decision.why.slice(0, 40) }));
  let existing = options.decisionId
    ? ledger.decisions.find((decision) => decision.id === options.decisionId)
    : null;
  if (options.decisionId && !existing) throw new Error(`unknown decision: ${options.decisionId}`);
  if (existing?.state === "settled") throw new Error(`decision is already settled: ${existing.id}`);
  const origin = existing?.origin === "human" ? "human" : options.origin ?? "event";
  const baseFor = (caseRef: string | null): Json => existing ? {
    ...existing,
    case_ref: caseRef,
    state: "open",
    decided_by: options.decided_by ?? "coordinator",
    decided_at: at,
    card: null,
    settled: null,
    human_boundary: { form: "none", chat_injection: false },
  } : baseDecision(dispatch, at, caseRef, { origin, ...(options.playbook ? { playbook: options.playbook } : {}) });

  const budget = checkBudget(ledger.cases, at, {
    limit: ruleset.budget.per_hour, window_minutes: ruleset.budget.window_minutes,
  });
  if (origin === "event" && !budget.allowed && !options.ignoreBudget) {
    const fallback = budgetDecision(dispatch, at, `全局预算 ${budget.used}/${budget.limit}，本次不唤醒 coordinator`);
    const decision = existing ? {
      ...existing,
      state: "open",
      why: fallback.why,
      decided_by: "system",
      decided_at: at,
      case_ref: null,
      actions: [],
      human_boundary: fallback.human_boundary,
      card: null,
      settled: null,
    } : fallback;
    assertValid(decision, "urn:collie:decision:v1");
    return ledger.append("decision", decision);
  }

  const job: Json = {
    id: ledgerId("ca"), created_at: at, origin, playbook: options.playbook ?? null,
    ...(options.catalog ? { catalog: options.catalog } : {}),
    space: {
      primary: dispatch.space, candidates,
      resolution: candidates.length === 1 ? "single" : "remembered",
    },
    message: {
      ref: message.id, key: message.key, source: message.source, type: message.type, object: message.object,
      title: message.title, data_ref: message.data_ref, data_digest: message.data_digest,
      hops: message.hops ?? 0, received_at: message.received_at,
      lane_key: message.merge?.lane_key ?? `message:${message.id}`,
      object_key: message.merge?.object_key ?? `${message.object?.kind ?? "none"}:${message.object?.id ?? message.id}`,
      occurrences: message.merge?.occurrences ?? 1,
      ...(message.project ? { project: message.project } : {}),
      ...(message.space_candidates ? { space_candidates: message.space_candidates } : {}),
    },
    scope: { forbidden_expand: true, snapshot_bytes_max: SNAPSHOT_BYTES_MAX },
    snapshot: {
      bytes: 0, truncated: false, space_note: options.spaceNote ?? `${dispatch.space} · coordinator`,
      queue, running: options.running ?? [], recent, active: activeSnapshot(ledger, dispatch.space, options.activeTasks ?? []), rules_version: ruleset.version,
      policy: (options.policy ?? "").slice(0, 2000),
      budget: {
        scope: "global", limit: budget.limit, used: budget.used + (origin === "event" ? 1 : 0), remaining: budget.remaining - (origin === "event" ? 1 : 0),
        window_start: budget.window_start, reset_at: budget.reset_at,
      },
    },
    memory: { ledger_ref: ledger.path, recent_decisions: recent.length },
    instruction: {
      role_prompt_ref: options.rolePromptRef ?? resolve(new URL("../templates/coordinator.md", import.meta.url).pathname),
      output_contract: "urn:collie:decision:v1",
    },
  };
  const trimmed = JSON.stringify(job.snapshot);
  if (Buffer.byteLength(trimmed) > SNAPSHOT_BYTES_MAX) {
    job.snapshot.truncated = true;
    while (Buffer.byteLength(JSON.stringify(job.snapshot)) > SNAPSHOT_BYTES_MAX - 96) {
      if (job.snapshot.recent.length) job.snapshot.recent.pop();
      else if (job.snapshot.queue.length) job.snapshot.queue.pop();
      else if (job.snapshot.running.length) job.snapshot.running.pop();
      else if (job.snapshot.policy) job.snapshot.policy = job.snapshot.policy.slice(0, Math.max(0, job.snapshot.policy.length - 200));
      else if (job.snapshot.space_note) job.snapshot.space_note = job.snapshot.space_note.slice(0, Math.max(0, job.snapshot.space_note.length - 100));
      else if (job.snapshot.active.length) job.snapshot.active.pop();
      else break;
    }
  }
  job.snapshot.bytes = Buffer.byteLength(JSON.stringify(job.snapshot));
  if (job.snapshot.bytes > SNAPSHOT_BYTES_MAX) throw new Error("coordinator snapshot exceeds 4KB");
  assertValid(job, "urn:collie:case:v1");
  ledger.append("case", job);

  const output = await decide(structuredClone(job));
  if (output.decision_ref !== undefined && output.decision_ref !== null) {
    const target = typeof output.decision_ref === "string"
      ? ledger.decisions.find((decision) => decision.id === output.decision_ref)
      : null;
    if (!target || target.state === "settled") throw new Error(`unknown or settled decision_ref: ${String(output.decision_ref)}`);
    if (target.space !== dispatch.space) throw new Error("decision_ref must belong to the current space");
    if (existing && existing.id !== target.id) throw new Error("decision_ref conflicts with the current Decision");
    existing = target;
  }

  const thinking = {
    ...baseFor(job.id),
    state: "open",
    why: "Coordinator 正在分析输入并生成 Decision",
    actions: [],
  };
  ledger.append("decision", thinking);
  options.onDecision?.(thinking);

  const occurrenceKey = message.merge?.object_key ?? `${message.object?.kind ?? "none"}:${message.object?.id ?? message.id}`;
  const round = existing ? existing.occurrence.round + 1
    : ledger.decisions.filter((decision) => decision.id !== thinking.id && decision.occurrence.object_key === occurrenceKey).length + 1;
  const base = baseFor(job.id);
  const candidate = {
    ...base, ...output,
    // Identity comes from the Message and the kernel, never from the coordinator's JSON.
    id: thinking.id, key: base.key, space: base.space, space_candidates: base.space_candidates, event_ref: base.event_ref,
    case_ref: job.id, origin, decided_by: options.decided_by ?? "coordinator", decided_at: at,
    occurrence: { ...base.occurrence, round },
    run: { ...base.run, ...output.run, ...(existing ? { task_ref: existing.run?.task_ref ?? null } : {}) },
    human_boundary: { form: output.state === "waiting" ? "card" : "none", chat_injection: false },
    priority: base.priority ?? null,
    hold: base.hold ?? null,
    proposal: base.proposal ?? null,
  };
  if (!candidate.why || candidate.why.length > 140) throw new Error("coordinator decision requires why ≤ 140 chars");
  if (!Array.isArray(candidate.actions)) throw new Error("coordinator decision requires actions");
  if (candidate.decision_ref && candidate.actions.some((action: Json) => action.kind === "spawn_task")) {
    throw new Error("continuation cannot spawn_task; continue the existing Task");
  }

  // Project the non-spawn actions onto the Decision. Inbox reads these fields for ordering
  // and attention; task-internal priority is the driver's concern, not a second state machine.
  const priorityAction = candidate.actions.find((action: Json) => action.kind === "priority");
  if (priorityAction?.priority) {
    candidate.priority = { value: priorityAction.priority.value, set_at: at };
    const check = checkPriorityChange(ledger.decisions, candidate, at, {
      max_changes: ruleset.priority_changes_per_24h,
    });
    if (!check.allowed) {
      const question = check.reason.slice(0, 200);
      candidate.state = "waiting";
      candidate.human_boundary = { form: "card", chat_injection: false };
      candidate.actions = [{ kind: "ask", risk_tags: [], ask: { kind: "alert", question, options: ["accept", "drop"] } }];
      candidate.card = {
        kind: "approval", question, options: ["accept", "drop"], state: "open", created_at: at,
        acked_at: null, answer: null, snooze_until: null, closed_at: null,
      };
    }
  }
  const holdAction = candidate.actions.find((action: Json) => action.kind === "hold");
  if (holdAction?.hold) candidate.hold = { until: holdAction.hold.until ?? null, reason: holdAction.hold.reason };
  const proposalAction = candidate.actions.find((action: Json) => action.kind === "propose_policy");
  if (proposalAction?.rule) candidate.proposal = { ...proposalAction.rule };

  // Delegation is one hop deeper. The input Message's hops are the base; only a spawn
  // increments it. At the limit, do not dispatch: record the Decision as an alert Card.
  let hops = message.hops ?? 0;
  if (candidate.state === "open" && candidate.actions.some((action: Json) => action.kind === "spawn_task")) {
    const step = nextHops(candidate, { max_hops: ruleset.max_hops });
    hops = step.hops;
    candidate.occurrence = step.decision.occurrence;
    if (!step.dispatch) {
      const question = step.reason.slice(0, 200);
      candidate.state = "waiting";
      candidate.why = step.reason.slice(0, 140);
      candidate.human_boundary = { form: "card", chat_injection: false };
      candidate.actions = [{ kind: "ask", risk_tags: [], ask: { kind: "alert", question, options: ["drop"] } }];
      candidate.card = {
        kind: "alert", question, options: ["drop"], state: "open", created_at: at,
        acked_at: null, answer: null, snooze_until: null, closed_at: null,
      };
    }
  }
  const guarded = applyGuard(candidate, ruleset, { authoritative: { hops } }).decision;
  const finalized = guarded.state === "settled" && !guarded.settled
    ? settle(guarded, { at, by: "coordinator", outcome: "dropped" })
    : guarded;
  assertValid(finalized, "urn:collie:decision:v1");
  const committed = options.beforeCommit ? await options.beforeCommit(finalized) : finalized;
  assertValid(committed, "urn:collie:decision:v1");
  return ledger.append("decision", committed);
}
