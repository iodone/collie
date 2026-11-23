import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationRegistry } from "../service/collaboration.ts";

describe("collaboration registry", () => {
  test("ships coordinator/driver/reviewer/verifier roles and prompt-only playbooks", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-registry-"));
    try {
      const registry = new CollaborationRegistry(dir);
      expect(registry.roles.get("coordinator")?.inputs).toContain("human message");
      expect(registry.roles.get("driver")?.duties).toContain("读 task brief 和 playbook");
      expect(registry.roles.get("verifier")?.prohibitions).toContain("不改产品代码");
      expect(registry.playbook("feature").instructions).toContain("reviewer");
      expect(registry.playbook("dsx-playbook-feature").title).toBe("Feature");
      expect(registry.playbook("review").instructions).toContain("findings");
      expect(registry.defaultPlaybook("review")).toBe("review");
      expect(registry.defaultPlaybook("build")).toBe("feature");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("loads user roles and playbook prompt bodies", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-registry-"));
    try {
      mkdirSync(join(dir, "roles"), { recursive: true });
      writeFileSync(join(dir, "roles", "security.md"), `---
kind: role
id: security
title: Security
purpose: security review
duties: [review]
prohibitions: [write code]
---

# Security
`);
      mkdirSync(join(dir, "playbooks"), { recursive: true });
      writeFileSync(join(dir, "playbooks", "secure.md"), `---
kind: playbook
id: secure
title: Secure
version: 1
---

先做威胁建模，再让 security 角色复核。
`);
      const registry = new CollaborationRegistry(dir);
      registry.loadDirectory(dir);
      expect(registry.roles.get("security")?.title).toBe("Security");
      expect(registry.playbook("secure").instructions).toContain("威胁建模");
      writeFileSync(join(dir, "playbooks", "bad.md"), `---
kind: playbook
id: bad
title: Bad
---

missing version
`);
      expect(() => registry.loadDirectory(dir)).toThrow(/requires id, title and version/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
