import { resolve } from "node:path";
import { Ledger, ledgerId } from "./ledger.ts";
import type { Dispatch } from "./ingress.ts";
import { admitCase, applyGuard, checkBudget } from "../protocol/invariants.mjs";
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
  rolePromptRef?: string;
  policy?: string;
  stream?: "job_turn" | "chat_turn";
  origin?: "event" | "human";
  decided_by?: "system" | "coordinator" | "human";
  playbook?: { id: string; version: number };
  onDecision?: (decision: Json) => void;
}

const baseDecision = (dispatch: Dispatch, at: string, caseRef: string | null, meta: Json = {}): Json => ({
  id: ledgerId("dc"),
  key: `${dispatch.event.source}:${dispatch.event.key}`,
  space: dispatch.space,
  ...(dispatch.event.project ? { project: dispatch.event.project } : {}),
  space_candidates: dispatch.event.space_candidates ?? [dispatch.space],
  event_ref: dispatch.event.id,
  case_ref: caseRef,
  state: "open",
  decided_by: "coordinator",
  decided_at: at,
  occurrence: {
    object_key: dispatch.event.merge.object_key,
    kind: dispatch.event.object.kind,
    round: 1,
    hops: dispatch.event.hops,
  },
  risk: { tags: [], forced_waiting: false },
  run: { claimed_until: null, unknown_policy: "normal", task_ref: null, coordinator_ref: null },
  human_boundary: { form: "none", chat_injection: false },
  priority: null,
  hold: null,
  card: null,
  receipt_ref: null,
  proposal: null,
  ack: null,
  settled: null,
  ...meta,
});

function budgetDecision(dispatch: Dispatch, at: string, reason: string): Json {
  return {
    ...baseDecision(dispatch, at, null),
    state: "waiting",
    why: reason,
    decided_by: "system",
    actions: [{
      kind: "ask", risk_tags: [],
      ask: { kind: "question", question: "本小时判断预算已用完，要现在处理这条事件吗？", options: ["accept", "later", "drop"] },
    }],
    human_boundary: { form: "card", chat_injection: false },
    card: {
      kind: "question", question: "本小时判断预算已用完，要现在处理这条事件吗？", options: ["accept", "later", "drop"],
      state: "open", created_at: at, acked_at: null, answer: null, snooze_until: null, closed_at: null,
    },
  };
}

export async function coordinate(dispatch: Dispatch, options: CoordinateOptions): Promise<Json> {
  if (dispatch.kind !== "coordinator") throw new Error(`coordinate only accepts coordinator dispatches, got ${dispatch.kind}`);
  const { ledger, ruleset, decide } = options;
  const at = (options.now ?? (() => new Date()))().toISOString();
  const candidates = dispatch.event.space_candidates ?? [dispatch.space];
  const recent = ledger.decisions.filter((decision) => decision.space === dispatch.space).slice(-10).reverse().map((decision) => ({
    decision_id: decision.id, object_key: decision.occurrence.object_key, why: decision.why,
  }));
  const queue = ledger.waiting().slice(0, 10).map((decision) => ({ key: decision.key, why: decision.why.slice(0, 40) }));
  const stream = options.stream ?? "job_turn";
  const origin = options.origin ?? (stream === "chat_turn" ? "human" : "event");
  const budget = checkBudget(ledger.cases, at, {
    limit: ruleset.budget.per_hour, window_minutes: ruleset.budget.window_minutes,
  });
  if (stream === "job_turn" && !budget.allowed) {
    const decision = budgetDecision(dispatch, at, `全局预算 ${budget.used}/${budget.limit}，本次不唤醒 coordinator`);
    assertValid(decision, "urn:collie:decision:v1");
    return ledger.append("decision", decision);
  }

  const job: Json = {
    id: ledgerId("ca"), created_at: at, stream, origin, playbook: options.playbook ?? null, wake: stream === "job_turn", visibility: stream === "job_turn" ? "ledger_only" : "chat",
    space: {
      primary: dispatch.space, candidates,
      resolution: candidates.length === 1 ? "single" : "remembered",
    },
    event: {
      ref: dispatch.event.id, key: dispatch.event.key, type: dispatch.event.type, hops: dispatch.event.hops,
      lane_key: dispatch.event.merge.lane_key, object_key: dispatch.event.merge.object_key,
      occurrences: dispatch.event.merge.occurrences,
    },
    scope: { forbidden_expand: true, snapshot_bytes_max: 4096 },
    snapshot: {
      bytes: 0, truncated: false, space_note: options.spaceNote ?? `${dispatch.space} · coordinator`,
      queue, running: options.running ?? [], recent, rules_version: ruleset.version,
      policy: (options.policy ?? "").slice(0, 2000),
      budget: {
        scope: "global", limit: budget.limit, used: budget.used + (stream === "job_turn" ? 1 : 0), remaining: budget.remaining - (stream === "job_turn" ? 1 : 0),
        window_start: budget.window_start, reset_at: budget.reset_at,
      },
    },
    memory: { ledger_ref: ledger.path, recent_decisions: recent.length },
    instruction: {
      role_prompt_ref: options.rolePromptRef ?? resolve(new URL("../templates/collie-coordinator.md", import.meta.url).pathname),
      output_contract: "urn:collie:decision:v1",
    },
  };
  const trimmed = JSON.stringify(job.snapshot);
  if (Buffer.byteLength(trimmed) > 4096) {
    job.snapshot.truncated = true;
    while (Buffer.byteLength(JSON.stringify(job.snapshot)) > 4000) {
      if (job.snapshot.recent.length) job.snapshot.recent.pop();
      else if (job.snapshot.queue.length) job.snapshot.queue.pop();
      else if (job.snapshot.running.length) job.snapshot.running.pop();
      else if (job.snapshot.policy) job.snapshot.policy = job.snapshot.policy.slice(0, Math.max(0, job.snapshot.policy.length - 200));
      else job.snapshot.space_note = job.snapshot.space_note.slice(0, Math.max(0, job.snapshot.space_note.length - 100));
      if (!job.snapshot.space_note && !job.snapshot.policy) break;
    }
  }
  job.snapshot.bytes = Buffer.byteLength(JSON.stringify(job.snapshot));
  if (job.snapshot.bytes > 4096) throw new Error("coordinator snapshot exceeds 4KB");
  assertValid(job, "urn:collie:case:v1");
  ledger.append("case", job);

  const thinking = {
    ...baseDecision(dispatch, at, job.id, { origin, ...(options.playbook ? { playbook: options.playbook } : {}) }),
    state: "open",
    why: "Coordinator 正在分析输入并生成 Decision",
    actions: [],
  };
  ledger.append("decision", thinking);
  options.onDecision?.(thinking);

  const output = await decide(structuredClone(job));
  const round = ledger.decisions.filter((decision) => decision.occurrence.object_key === dispatch.event.merge.object_key).length + 1;
  const candidate = {
    ...baseDecision(dispatch, at, job.id, { origin, ...(options.playbook ? { playbook: options.playbook } : {}) }), ...output,
    id: thinking.id, case_ref: job.id, decided_by: options.decided_by ?? "coordinator", decided_at: at,
    occurrence: { ...baseDecision(dispatch, at, job.id).occurrence, round },
    run: { ...baseDecision(dispatch, at, job.id).run, ...output.run },
    human_boundary: { form: output.state === "waiting" ? "card" : "none", chat_injection: false },
  };
  if (!candidate.why || candidate.why.length > 140) throw new Error("coordinator decision requires why ≤ 140 chars");
  if (!Array.isArray(candidate.actions)) throw new Error("coordinator decision requires actions");
  const guarded = applyGuard(candidate, ruleset, { authoritative: { hops: dispatch.event.hops } }).decision;
  if (guarded.state === "settled" && !guarded.settled) {
    guarded.settled = { at, by: "coordinator", outcome: "dropped" };
  }
  assertValid(guarded, "urn:collie:decision:v1");
  return ledger.append("decision", guarded);
}
