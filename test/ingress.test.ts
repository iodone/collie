import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceEvent, verifySource } from "../service/sources.ts";

const body = JSON.stringify({
  object_kind: "merge_request",
  project: { path_with_namespace: "olap/miergo", web_url: "https://git.n.xiaomi.com/olap/miergo" },
  object_attributes: { iid: 169, title: "ALTER operator/clientId", url: "https://git.n.xiaomi.com/olap/miergo/-/merge_requests/169", action: "update" },
});

describe("source adapters", () => {
  test("GitLab webhook becomes a Collie Event with one mapped space", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-source-"));
    try {
      const event = sourceEvent("gitlab", { space_map: { "olap/miergo": "spf57" } }, { "x-gitlab-event-uuid": "uuid-1" }, body, dir);
      expect(event.source).toBe("gitlab");
      expect(event.object).toMatchObject({ kind: "mr", id: "mr!169" });
      expect(event.space_candidates).toEqual(["spf57"]);
      expect(event.key).toBe("uuid-1");
      expect(event.data_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("GitLab token and GitHub HMAC are checked by the adapter boundary", () => {
    expect(verifySource("gitlab", { "x-gitlab-token": "secret" }, body, "secret")).toBe(true);
    expect(verifySource("gitlab", { "x-gitlab-token": "wrong" }, body, "secret")).toBe(false);
    expect(verifySource("github", { "x-hub-signature-256": "sha256=bad" }, body, "secret")).toBe(false);
  });
});
