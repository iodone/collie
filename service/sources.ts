import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceConfig } from "./ingress-config.ts";

type Json = Record<string, any>;
type Headers = Record<string, string | string[] | undefined>;

const header = (headers: Headers, name: string): string => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
};

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const eventId = (seed: string): string => `ev_${hash(seed).slice(0, 16)}`;
const now = (): string => new Date().toISOString();

function spaceFor(config: SourceConfig, repository: string): string {
  const mapped = config.space_map?.[repository];
  const value = mapped || config.space;
  if (!value) throw new Error(`source has no space mapping for ${repository || "unknown repository"}`);
  return value;
}

function bodyRef(stateDir: string, id: string, body: string): { data_ref: string; data_digest: string } {
  const directory = join(stateDir, "event-bodies");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${id}.md`);
  writeFileSync(path, body, { mode: 0o600 });
  return { data_ref: path, data_digest: `sha256:${hash(body)}` };
}

function compact(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** GitLab webhook payload -> one Collie Event. Adapter only normalizes; it never dispatches. */
export function gitlabEvent(config: SourceConfig, headers: Headers, body: string, stateDir: string): Json {
  const payload = JSON.parse(body);
  const kind = String(payload.object_kind ?? header(headers, "x-gitlab-event") ?? "").toLowerCase();
  const attrs = payload.object_attributes ?? {};
  const project = payload.project ?? {};
  const repo = String(project.path_with_namespace ?? project.name ?? "");
  const action = attrs.action ? `.${String(attrs.action).toLowerCase()}` : "";
  const type = `${kind || "gitlab.event"}${action}`.replace(/[^a-z0-9_.-]/g, "-");
  let objectKind = "none";
  let objectId = String(attrs.iid ?? attrs.id ?? project.id ?? "0");
  let url = String(attrs.url ?? project.web_url ?? "");
  if (kind === "merge_request") { objectKind = "mr"; objectId = `mr!${attrs.iid ?? attrs.id}`; }
  else if (kind === "issue") { objectKind = "issue"; objectId = `issue#${attrs.iid ?? attrs.id}`; }
  else if (kind === "pipeline") { objectKind = "pipeline"; objectId = `pipeline!${attrs.id}`; }
  const id = eventId(`${repo}:${kind}:${header(headers, "x-gitlab-event-uuid") || header(headers, "idempotency-key") || hash(body)}`);
  const received = now();
  const ref = bodyRef(stateDir, id, body);
  return {
    id, source: "gitlab",
    key: header(headers, "x-gitlab-event-uuid") || header(headers, "idempotency-key") || `body:${hash(body)}`,
    type,
    object: { kind: objectKind, id: objectId, ...(url ? { url } : {}) },
    title: compact(attrs.title ?? payload.commits?.[0]?.message ?? "", 200),
    ...ref,
    hops: 0,
    received_at: received,
    merge: { lane_key: "", object_key: `${objectKind}:${objectId}`, first_seen_at: received, occurrences: 1 },
    space_candidates: [spaceFor(config, repo)],
  };
}

/** GitHub webhook payload -> one Collie Event. */
export function githubEvent(config: SourceConfig, headers: Headers, body: string, stateDir: string): Json {
  const payload = JSON.parse(body);
  const event = header(headers, "x-github-event");
  const action = payload.action ? `.${String(payload.action).toLowerCase()}` : "";
  const type = `${event || "github.event"}${action}`.replace(/[^a-z0-9_.-]/g, "-");
  const repo = String(payload.repository?.full_name ?? payload.repository?.name ?? "");
  const object = payload.pull_request ?? payload.issue ?? payload.workflow_run ?? payload;
  const detail = object ?? {};
  let objectKind = "none";
  let objectId = String(detail.id ?? detail.number ?? payload.repository?.id ?? "0");
  let url = String(detail.html_url ?? payload.repository?.html_url ?? "");
  if (payload.pull_request) { objectKind = "mr"; objectId = `mr#${detail.number}`; }
  else if (payload.issue) { objectKind = "issue"; objectId = `issue#${detail.number}`; }
  else if (payload.workflow_run) { objectKind = "pipeline"; objectId = `pipeline#${detail.id}`; }
  const key = header(headers, "x-github-delivery") || `body:${hash(body)}`;
  const id = eventId(`${repo}:${event}:${key}`);
  const received = now();
  const ref = bodyRef(stateDir, id, body);
  return {
    id, source: "github", key, type,
    object: { kind: objectKind, id: objectId, ...(url ? { url } : {}) },
    title: compact(detail.title ?? detail.name ?? "", 200),
    ...ref,
    hops: 0,
    received_at: received,
    merge: { lane_key: "", object_key: `${objectKind}:${objectId}`, first_seen_at: received, occurrences: 1 },
    space_candidates: [spaceFor(config, repo)],
  };
}

export function verifySource(adapter: string, headers: Headers, body: string, secret: string): boolean {
  if (!secret) return true;
  if (adapter === "gitlab") {
    const given = Buffer.from(header(headers, "x-gitlab-token"));
    const wanted = Buffer.from(secret);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }
  if (adapter === "github") {
    const given = header(headers, "x-hub-signature-256");
    if (!given.startsWith("sha256=")) return false;
    const wanted = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const a = Buffer.from(given), b = Buffer.from(wanted);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return false;
}

export function sourceEvent(adapter: string, config: SourceConfig, headers: Headers, body: string, stateDir: string): Json {
  if (adapter === "gitlab") return gitlabEvent(config, headers, body, stateDir);
  if (adapter === "github") return githubEvent(config, headers, body, stateDir);
  throw new Error(`unknown source adapter ${adapter}`);
}
