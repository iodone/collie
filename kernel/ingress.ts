import { checkEventAcceptable } from "../protocol/invariants.mjs";

type Json = Record<string, any>;

export interface Dispatch {
  kind: "coordinator" | "record_only";
  laneKey: string;
  space: string | null;
  event: Json;
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

function spaceFor(event: Json): string {
  const candidates = event.space_candidates ?? [];
  if (candidates.length !== 1) {
    throw new Error(`event ${event.id} has unresolved spaces: ${candidates.join(", ") || "none"}`);
  }
  return candidates[0];
}

/**
 * Sources connect in; Ingress verifies, dedupes and merges. It never decides:
 * every event goes to the space's coordinator. There is no rule table.
 */
export class Ingress {
  readonly #events = new Map<string, Json>();
  readonly #lanes = new Map<string, Lane>();

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

    const kind = objectKey(input);
    const laneKey = `coordinator:${kind}`;
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
    this.#events.set(dedupeKey, event);

    if (acceptable.record_only) {
      const dispatch: Dispatch = {
        kind: "record_only", laneKey, space: spaceFor(input), event, cardRequired: true,
      };
      this.#lanes.set(laneKey, { event, open: old?.open ?? false, dispatch });
      return { status: "recorded", event, dispatches: [dispatch] };
    }

    if (old?.open) {
      this.#lanes.set(laneKey, { ...old, event });
      return { status: "merged", event, dispatches: [] };
    }

    const dispatch: Dispatch = { kind: "coordinator", laneKey, space: spaceFor(input), event };
    this.#lanes.set(laneKey, { event, open: true, dispatch });
    return { status: "accepted", event, dispatches: [dispatch] };
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