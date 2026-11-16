import { checkEventAcceptable } from "../protocol/invariants.mjs";

type Json = Record<string, any>;

export interface Dispatch {
  kind: "herdr_task" | "coordinator" | "record_only";
  laneKey: string;
  space: string | null;
  ruleId: string | null;
  event: Json;
  rule?: Json;
  cardRequired?: boolean;
}

interface Lane {
  event: Json;
  open: boolean;
  dispatch: Dispatch | null;
  decisionIds?: string[];
}

const objectKey = (event: Json): string => {
  if (!event.object || typeof event.object.kind !== "string" || typeof event.object.id !== "string") {
    throw new Error("event.object requires kind and id");
  }
  return `${event.object.kind}:${event.object.id}`;
};

const matches = (rule: Json, event: Json): boolean =>
  rule.enabled === true &&
  rule.when.sources.includes(event.source) &&
  rule.when.types.includes(event.type) &&
  (!rule.when.object_kinds || rule.when.object_kinds.includes(event.object.kind));

function spaceFor(rule: Json | null, event: Json): string {
  if (rule?.to.space) return rule.to.space;
  const candidates = event.space_candidates ?? [];
  if (candidates.length !== 1) {
    throw new Error(`event ${event.id} has unresolved spaces: ${candidates.join(", ") || "none"}`);
  }
  return candidates[0];
}

export class Ingress {
  readonly #events = new Map<string, Json>();
  readonly #lanes = new Map<string, Lane>();

  constructor(readonly ruleset: Json) {
    if (!Array.isArray(ruleset.rules)) throw new Error("ruleset.rules must be an array");
  }

  ingest(input: Json): { status: "accepted" | "merged" | "recorded" | "duplicate"; event: Json; dispatches: Dispatch[] } {
    const acceptable = checkEventAcceptable(input);
    if (!acceptable.ok) throw new Error(acceptable.reasons.join("; "));
    const dedupeKey = `${input.source}:${input.key}`;
    const previous = this.#events.get(dedupeKey);
    if (previous) {
      if (previous.id !== input.id || previous.data_digest !== input.data_digest || previous.object.id !== input.object.id) {
        throw new Error(`duplicate event key ${dedupeKey} has different immutable content`);
      }
      return { status: "duplicate", event: previous, dispatches: [] };
    }

    const matchedRules = this.ruleset.rules.filter((rule: Json) => matches(rule, input));
    const targets: Array<Json | null> = matchedRules.length ? matchedRules : [null];
    const dispatches: Dispatch[] = [];
    let representative: Json | null = null;
    let merged = false;

    for (const rule of targets) {
      const kind = objectKey(input);
      const laneKey = `${rule?.id ?? "coordinator"}:${kind}`;
      const old = this.#lanes.get(laneKey);
      const occurrences = (old?.event.merge.occurrences ?? 0) + 1;
      const event: Json = {
        ...input,
        merge: {
          lane_key: laneKey,
          object_key: kind,
          first_seen_at: old?.event.merge.first_seen_at ?? input.received_at,
          occurrences,
        },
      };
      representative = event;

      if (acceptable.record_only) {
        const dispatch: Dispatch = {
          kind: "record_only", laneKey, space: spaceFor(rule, input), ruleId: rule?.id ?? null,
          event, cardRequired: true,
        };
        this.#lanes.set(laneKey, { event, open: old?.open ?? false, dispatch });
        dispatches.push(dispatch);
        continue;
      }
      if (rule?.paused.paused === true || rule?.to.kind === "drop") {
        this.#lanes.set(laneKey, { event, open: old?.open ?? false, dispatch: old?.dispatch ?? null });
        continue;
      }
      if (old?.open) {
        this.#lanes.set(laneKey, { ...old, event });
        merged = true;
        continue;
      }

      const dispatch: Dispatch = {
        kind: rule?.to.kind ?? "coordinator",
        laneKey,
        space: spaceFor(rule, input),
        ruleId: rule?.id ?? null,
        event,
        ...(rule ? { rule } : {}),
      };
      this.#lanes.set(laneKey, { event, open: true, dispatch });
      dispatches.push(dispatch);
    }

    this.#events.set(dedupeKey, representative!);
    return {
      status: dispatches.length ? "accepted" : merged ? "merged" : "recorded",
      event: representative!,
      dispatches,
    };
  }

  snapshot(): Json {
    return {
      version: 1,
      events: [...this.#events.entries()],
      lanes: [...this.#lanes.entries()],
    };
  }

  restore(snapshot: Json): void {
    if (snapshot.version !== 1 || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.lanes)) {
      throw new Error("invalid ingress snapshot");
    }
    this.#events.clear();
    this.#lanes.clear();
    for (const [key, event] of snapshot.events) this.#events.set(key, event);
    for (const [key, lane] of snapshot.lanes) this.#lanes.set(key, lane);
  }

  /** The latest representative is what a queued/running judgment should consume. */
  eventForLane(laneKey: string): Json {
    const lane = this.#lanes.get(laneKey);
    if (!lane) throw new Error(`unknown lane: ${laneKey}`);
    return lane.event;
  }

  bindDecision(laneKey: string, decisionId: string): void {
    const lane = this.#lanes.get(laneKey);
    if (!lane) throw new Error(`unknown lane: ${laneKey}`);
    lane.decisionIds = [...new Set([...(lane.decisionIds ?? []), decisionId])];
  }

  laneForDecision(decisionId: string): string | null {
    return [...this.#lanes.entries()].find(([, lane]) => lane.decisionIds?.includes(decisionId))?.[0] ?? null;
  }

  /** Completion closes only this lane; the next event starts a new judgment with history intact. */
  completeLane(laneKey: string): void {
    const lane = this.#lanes.get(laneKey);
    if (!lane) throw new Error(`unknown lane: ${laneKey}`);
    lane.open = false;
  }
}
