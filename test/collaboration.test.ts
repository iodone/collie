import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationRegistry } from "../service/collaboration.ts";

describe("collaboration registry", () => {
  test("ships the coordinator/worker/reviewer/verifier roles and core playbooks", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-registry-"));
    try {
      const registry = new CollaborationRegistry(dir);
      expect(registry.roles.get("coordinator")?.modes?.chat).toBeDefined();
      expect(registry.roles.get("verifier")?.prohibitions).toContain("不改产品代码");
      expect(registry.playbook("feature").stages.map((stage) => stage.id)).toEqual(["explore", "design", "implement", "review", "verify", "accept"]);
      expect(registry.playbook("dsx-playbook-feature").stages.map((stage) => stage.role)).toContain("verifier");
      expect(registry.defaultPlaybook("review")).toBe("review");
      expect(registry.defaultPlaybook("build")).toBe("feature");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("loads user and project definitions, rejecting unknown role references", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-registry-"));
    try {
      mkdirSync(join(dir, "roles"), { recursive: true });
      writeFileSync(join(dir, "roles", "security.json"), JSON.stringify({
        id: "security", title: "Security", purpose: "security review",
        duties: ["review"], prohibitions: ["write code"],
      }));
      const registry = new CollaborationRegistry(dir);
      expect(registry.roles.get("security")?.title).toBe("Security");
      mkdirSync(join(dir, "playbooks"), { recursive: true });
      writeFileSync(join(dir, "playbooks", "secure.json"), JSON.stringify({
        id: "secure", title: "Secure", version: 1,
        stages: [{ id: "review", role: "security" }],
      }));
      registry.loadDirectory(dir);
      expect(registry.playbook("secure").stages[0].role).toBe("security");
      writeFileSync(join(dir, "playbooks", "bad.json"), JSON.stringify({
        id: "bad", title: "Bad", version: 1, stages: [{ id: "x", role: "missing" }],
      }));
      expect(() => registry.loadDirectory(dir)).toThrow(/unknown role missing/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
