import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, any>;

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const now = (): string => new Date().toISOString();

/**
 * One generic intake for open-ended external envelopes. Collie does not know
 * flume or any vendor schema here: it persists the envelope as data and only
 * derives the small durable Event shell. The coordinator/agent interprets it.
 */
export function intakeEvent(input: Json, stateDir: string): Json {
  if (input.id && input.data_ref && input.data_digest && input.merge) return input;

  const body = JSON.stringify(input);
  const sourceText = String(input.source ?? "external").trim().toLowerCase();
  const source = /^[a-z][a-z0-9_-]{0,63}$/.test(sourceText) ? sourceText : "external";
  const key = String(input.native_id ?? input.key ?? `sha256:${hash(body)}`).slice(0, 200);
  const typeText = String(input.event ?? input.type ?? "external.event");
  const type = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(typeText) && typeText.length <= 80
    ? typeText
    : "external.event";
  const subject = String(input.subject ?? `${source}:${key}`).trim().slice(0, 200) || `${source}:${key}`;
  const candidates = Array.isArray(input.space_candidates)
    ? input.space_candidates
    : input.space ? [input.space] : [];
  if (!candidates.length) throw new Error("generic intake requires space or space_candidates");
  const spaces = [...new Set(candidates.map((space: unknown) => String(space)))];
  if (spaces.some((space) => !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(space))) throw new Error("invalid space");

  const id = `ev_${hash(`${source}:${type}:${key}`).slice(0, 16)}`;
  const directory = join(stateDir, "intake");
  mkdirSync(directory, { recursive: true });
  const dataRef = join(directory, `${id}.json`);
  writeFileSync(dataRef, body, { mode: 0o600 });
  const received = now();
  return {
    id, source, key, type,
    object: { kind: "none", id: subject },
    title: `${type} ${subject}`.slice(0, 200),
    data_ref: dataRef,
    data_digest: `sha256:${hash(body)}`,
    hops: 0,
    received_at: received,
    merge: { lane_key: "", object_key: `none:${subject}`, first_seen_at: received, occurrences: 1 },
    space_candidates: spaces,
  };
}
