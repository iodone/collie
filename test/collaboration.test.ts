import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationRegistry } from "../service/collaboration.ts";

const role = (name: string, description = name) => `---
name: ${name}
description: ${description}
version: 1
---

# ${description}
`;
const playbook = (name: string, text: string) => `---
name: ${name}
description: ${name}
version: 1
---

${text}
`;

describe("collaboration registry", () => {
  test("loads system roles and falls back to defaults only when config is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-registry-"));
    try {
      const registry = new CollaborationRegistry(dir);
      expect(registry.roles.get("coordinator")?.origin).toBe("system");
      expect(registry.roles.get("driver")?.origin).toBe("system");
      expect(registry.roles.get("verifier")?.origin).toBe("defaults");
      expect(registry.playbook("feature").instructions).toContain("reviewer");
      expect(registry.catalog().playbooks.some((book) => book.name === "feature")).toBe(true);
      expect(registry.catalog()).not.toHaveProperty("roles");
      expect(registry.roleCatalog().roles.some((role) => role.name === "reviewer")).toBe(true);
      expect(registry.defaultPlaybook("review")).toBe("review");
      expect(registry.defaultPlaybook("build")).toBe("feature");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("loads config roles and playbooks", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-registry-"));
    try {
      mkdirSync(join(dir, "roles"), { recursive: true });
      mkdirSync(join(dir, "playbooks"), { recursive: true });
      writeFileSync(join(dir, "roles", "security.md"), role("security"));
      writeFileSync(join(dir, "playbooks", "secure.md"), playbook("secure", "先做威胁建模。"));
      const registry = new CollaborationRegistry(dir);
      expect(registry.roles.get("security")?.description).toBe("security");
      expect(registry.roles.get("security")?.origin).toBe("config");
      expect(registry.playbook("secure").instructions).toContain("威胁建模");
      writeFileSync(join(dir, "playbooks", "bad.md"), `---\nname: bad\ndescription: Bad\n---\n\nmissing version\n`);
      expect(() => new CollaborationRegistry(dir)).toThrow(/needs name, description and version/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("rejects system role overrides in config", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-registry-"));
    try {
      mkdirSync(join(dir, "roles"), { recursive: true });
      writeFileSync(join(dir, "roles", "driver.md"), role("driver"));
      expect(() => new CollaborationRegistry(dir)).toThrow(/system role/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("reloads the config layer after an edit", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-registry-"));
    try {
      mkdirSync(join(dir, "roles"), { recursive: true });
      writeFileSync(join(dir, "roles", "security.md"), role("security"));
      const registry = new CollaborationRegistry(dir);
      expect(registry.roles.get("security")?.description).toBe("security");
      writeFileSync(join(dir, "roles", "security.md"), role("security", "Security"));
      writeFileSync(join(dir, "roles", "audit.md"), role("audit"));
      registry.reload();
      expect(registry.roles.get("security")?.description).toBe("Security");
      expect(registry.roles.get("audit")?.origin).toBe("config");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("rejects legacy id/title/purpose frontmatter and drops unused role metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-registry-"));
    try {
      mkdirSync(join(dir, "roles"), { recursive: true });
      writeFileSync(join(dir, "roles", "legacy.md"), `---\nid: legacy\ntitle: Legacy\npurpose: Old role\n---\nold\n`);
      expect(() => new CollaborationRegistry(dir)).toThrow(/needs name and description/);

      writeFileSync(join(dir, "roles", "legacy.md"), role("current"));
      const registry = new CollaborationRegistry(dir);
      expect(registry.roles.get("current")).not.toHaveProperty("version");
      expect(registry.roles.get("coordinator")?.command).toBe("claude");
      expect(registry.playbook("feature")).not.toHaveProperty("verify");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
