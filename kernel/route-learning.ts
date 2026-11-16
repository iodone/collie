import { Ledger, ledgerId } from "./ledger.ts";
import type { Dispatch } from "./ingress.ts";

type Json = Record<string, any>;

export function proposeRule(ledger: Ledger, decisionId: string, target: Json): Json {
  const decision = ledger.decisions.find((item) => item.id === decisionId);
  if (!decision || decision.decided_by !== "coordinator") throw new Error("only coordinator decisions can be learned");
  const event = ledger.events.find((item) => item.id === decision.event_ref);
  if (!event) throw new Error("decision event is missing from ledger");
  const spawns = decision.actions.filter((action: Json) => action.kind === "spawn_task");
  if (spawns.length !== 1 || decision.risk.tags.length) throw new Error("only one unguarded spawn can become a route");
  const typePart = event.type.replaceAll(".", "-").replaceAll("_", "-");
  return {
    id: target.id ?? `learned-${event.source}-${typePart}`,
    enabled: true,
    when: { sources: [event.source], types: [event.type], object_kinds: [event.object.kind] },
    to: { kind: "herdr_task", space: decision.space, cwd: target.cwd },
    agent: { access: spawns[0].spawn.access, tells: spawns[0].spawn.tells, ...(target.cli ? { cli: target.cli } : {}) },
    limits: { parallel: 1, max_running: target.max_running ?? 3 },
    paused: { paused: false },
  };
}

/** Human approval is an explicit input; observing a repeated decision never mutates live rules. */
export function approveRule(ruleset: Json, draft: Json, approval: { approvedBy: string }): Json {
  if (approval.approvedBy !== "human") throw new Error("route rules require human approval");
  if (ruleset.rules.some((rule: Json) => rule.id === draft.id)) throw new Error(`duplicate rule id: ${draft.id}`);
  const sameMatch = (rule: Json) =>
    JSON.stringify(rule.when.sources) === JSON.stringify(draft.when.sources) &&
    JSON.stringify(rule.when.types) === JSON.stringify(draft.when.types) &&
    JSON.stringify(rule.when.object_kinds ?? null) === JSON.stringify(draft.when.object_kinds ?? null);
  // An approved concrete route supersedes the equivalent coordinator fallback; keeping both would fan out twice.
  const rules = ruleset.rules.filter((rule: Json) => rule.to.kind !== "coordinator" || !sameMatch(rule));
  return { ...ruleset, version: ruleset.version + 1, rules: [...rules, structuredClone(draft)] };
}

export function decisionFromRule(dispatch: Dispatch, briefRef: string, at = new Date().toISOString()): Json {
  if (dispatch.kind !== "herdr_task" || !dispatch.rule) throw new Error("not a direct herdr_task dispatch");
  const event = dispatch.event;
  const title = event.title ?? `${event.type} ${event.object.id}`;
  return {
    id: ledgerId("dc"), key: `${event.source}:${event.key}`, space: dispatch.space,
    space_candidates: event.space_candidates ?? [dispatch.space], event_ref: event.id, case_ref: null,
    state: "routed", why: `命中人工批准的路由 ${dispatch.ruleId}，跳过 coordinator`, decided_by: "rule_table", decided_at: at,
    occurrence: { object_key: event.merge.object_key, kind: event.object.kind, round: 1, hops: event.hops },
    actions: [{ kind: "spawn_task", risk_tags: [], spawn: {
      title, brief_ref: briefRef, base: "current", review: true, merge: false,
      access: dispatch.rule.agent.access, tells: dispatch.rule.agent.tells, parallel: 1,
    } }],
    risk: { tags: [], forced_waiting: false }, run: { claimed_until: null, unknown_policy: "normal", task_ref: null, coordinator_ref: null },
    human_boundary: { form: "none", chat_injection: false }, priority: null, hold: null, card: null,
    receipt_ref: null, proposal: null, ack: null, settled: null,
  };
}

export function coordinatorBypassRate(decisions: Json[]): number {
  const direct = (decision: Json) => decision.decided_by === "rule_table" && decision.case_ref === null
    && decision.actions?.some((action: Json) => action.kind === "spawn_task");
  const judged = decisions.filter((decision) => decision.decided_by === "coordinator" || direct(decision));
  if (!judged.length) return 0;
  return judged.filter(direct).length / judged.length;
}
