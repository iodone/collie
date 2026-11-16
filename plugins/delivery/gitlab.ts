import {
  authorizedEmit,
  body,
  cliRunner,
  objectId,
  objectKind,
  payload,
  repository,
  type DeliveryOptions,
  type Json,
} from "./common.ts";

const runGlab = cliRunner("glab");

/** Payload: { repo, id, body?, sha?, merge_method?: "merge"|"squash"|"rebase" }. */
export async function deliverGitlab(decision: Json, options: DeliveryOptions = {}): Promise<unknown> {
  const egress = authorizedEmit(decision, "gitlab");
  if (egress.op === "notify") throw new Error("gitlab delivery does not support notify");
  const data = await payload(egress);
  const repo = repository(data.repo);
  const id = objectId(data.id);
  const kind = objectKind(decision);
  const resource = kind === "mr" ? "mr" : "issue";
  if (egress.op === "merge" && kind !== "mr") throw new Error("only merge requests can be merged");

  let args: string[];
  if (egress.op === "comment") {
    args = [resource, "note", id, "--repo", repo, "--message", body(data.body)];
  } else if (egress.op === "close") {
    args = [resource, "close", id, "--repo", repo];
  } else if (egress.op === "merge") {
    args = ["mr", "merge", id, "--repo", repo, "--yes"];
    if (data.merge_method === "squash") args.push("--squash");
    else if (data.merge_method === "rebase") args.push("--rebase");
    else if (data.merge_method !== undefined && data.merge_method !== "merge") {
      throw new Error("payload.merge_method must be merge, squash, or rebase");
    }
    if (data.sha !== undefined) {
      if (typeof data.sha !== "string" || !/^[0-9a-f]{40}$/i.test(data.sha)) {
        throw new Error("payload.sha must be a full commit sha");
      }
      args.push("--sha", data.sha);
    }
  } else {
    throw new Error(`unsupported gitlab operation: ${String(egress.op)}`);
  }

  return (options.run ?? runGlab)(args);
}

export const deliverGitLab = deliverGitlab;
