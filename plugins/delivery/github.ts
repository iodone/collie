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

const runGh = cliRunner("gh");

/** Payload: { repo, id, body?, sha?, merge_method?: "merge"|"squash"|"rebase" }. */
export async function deliverGithub(decision: Json, options: DeliveryOptions = {}): Promise<unknown> {
  const egress = authorizedEmit(decision, "github");
  if (egress.op === "notify") throw new Error("github delivery does not support notify");
  const data = await payload(egress);
  const repo = repository(data.repo);
  const id = objectId(data.id);
  const kind = objectKind(decision);
  const resource = kind === "mr" ? "pr" : "issue";
  if (egress.op === "merge" && kind !== "mr") throw new Error("only pull requests can be merged");

  let args: string[];
  if (egress.op === "comment") {
    args = [resource, "comment", id, "--repo", repo, "--body", body(data.body)];
  } else if (egress.op === "close") {
    args = [resource, "close", id, "--repo", repo];
  } else if (egress.op === "merge") {
    const method = data.merge_method ?? "merge";
    if (!["merge", "squash", "rebase"].includes(method)) {
      throw new Error("payload.merge_method must be merge, squash, or rebase");
    }
    args = ["pr", "merge", id, "--repo", repo, `--${method}`];
    if (data.sha !== undefined) {
      if (typeof data.sha !== "string" || !/^[0-9a-f]{40}$/i.test(data.sha)) {
        throw new Error("payload.sha must be a full commit sha");
      }
      args.push("--match-head-commit", data.sha);
    }
  } else {
    throw new Error(`unsupported github operation: ${String(egress.op)}`);
  }

  return (options.run ?? runGh)(args);
}
