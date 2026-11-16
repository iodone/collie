import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Json = Record<string, any>;
export type DeliveryRunner = (args: string[]) => Promise<unknown>;

export interface DeliveryOptions {
  run?: DeliveryRunner;
}

export function cliRunner(command: string): DeliveryRunner {
  return async (args) => {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  };
}

/**
 * An answered card is the only capability accepted by delivery. In particular,
 * risk.tags/forced_waiting and action.risk_tags are never treated as approval.
 */
export function authorizedEmit(decision: Json, target: string): Json {
  const card = decision?.card;
  const answer = card?.answer;
  const accepted = decision?.state === "routed"
    && decision?.human_boundary?.form === "card"
    && decision?.human_boundary?.chat_injection === false
    && card?.state === "decided"
    && Array.isArray(card?.options)
    && card.options.includes("accept")
    && answer?.option === "accept"
    && typeof answer?.by === "string"
    && answer.by.trim().length > 0
    && typeof answer?.at === "string"
    && answer.at.length > 0;
  if (!accepted) throw new Error("emit requires a waiting card answered with human accept");

  const actions = (decision.actions ?? []).filter((action: Json) =>
    action.kind === "emit_command" && action.egress?.target === target,
  );
  if (actions.length !== 1) throw new Error(`expected exactly one ${target} emit_command, got ${actions.length}`);
  return actions[0].egress;
}

export async function payload(egress: Json): Promise<Json> {
  const ref = egress?.payload_ref;
  if (typeof ref !== "string" || !/^\/[^\s]+$/.test(ref)) {
    throw new Error("egress.payload_ref must be an absolute path");
  }
  const value = JSON.parse(await readFile(ref, "utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("delivery payload must be a JSON object");
  }
  return value;
}

export function repository(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /^\s*-|[\s\0\r\n]/.test(value)) {
    throw new Error("payload.repo must be a non-empty repository name");
  }
  return value;
}

export function objectId(value: unknown): string {
  const id = String(value ?? "");
  if (!/^[1-9]\d*$/.test(id)) throw new Error("payload.id must be a positive numeric object id");
  return id;
}

export function body(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("payload.body must be non-empty");
  return value;
}

export function objectKind(decision: Json): "mr" | "issue" {
  const kind = decision.occurrence?.kind;
  if (kind !== "mr" && kind !== "issue") throw new Error("code delivery requires an mr or issue occurrence");
  return kind;
}
