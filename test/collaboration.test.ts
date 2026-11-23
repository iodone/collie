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
      expect(registry.roles.get("driver")?.duties).toContain("读工作说明和 playbook");
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

describe("role and playbook layers", () => {
  const role = (id: string, title = id) => `---
kind: role
id: ${id}
title: ${title}
purpose: test
duties: [work]
prohibitions: []
---

# ${title}
`;
  const playbook = (id: string, text: string) => `---
kind: playbook
id: ${id}
title: ${id}
version: 1
---

${text}
`;

  test("user and project cannot override system roles", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-registry-"));
    try {
      mkdirSync(join(dir, "roles"), { recursive: true });
      writeFileSync(join(dir, "roles", "driver.md"), role("driver"));
      expect(() => new CollaborationRegistry(dir)).toThrow(/system role/);
      writeFileSync(join(dir, "roles", "driver.md"), role("security"));
      const registry = new CollaborationRegistry(dir);
      const project = join(dir, "project");
      mkdirSync(join(project, ".collie", "roles"), { recursive: true });
      writeFileSync(join(project, ".collie", "roles", "coordinator.md"), role("coordinator"));
      expect(() => registry.loadProject(project)).toThrow(/system role/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("project overrides defaults and playbooks, and isolates projects", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-registry-"));
    try {
      const registry = new CollaborationRegistry(join(dir, "user"));
      const one = join(dir, "one");
      mkdirSync(join(one, ".collie", "roles"), { recursive: true });
      mkdirSync(join(one, ".collie", "playbooks"), { recursive: true });
      writeFileSync(join(one, ".collie", "roles", "reviewer.md"), role("reviewer", "Project Reviewer"));
      writeFileSync(join(one, ".collie", "playbooks", "feature.md"), playbook("feature", "project feature prompt"));
      registry.loadProject(one);
      expect(registry.roles.get("reviewer")?.title).toBe("Project Reviewer");
      expect(registry.roles.get("reviewer")?.origin).toBe("project");
      expect(registry.playbook("feature").instructions).toContain("project feature prompt");
      expect(registry.playbook("feature").origin).toBe("project");

      const two = join(dir, "two");
      mkdirSync(two, { recursive: true });
      registry.loadProject(two);
      expect(registry.roles.get("reviewer")?.title).not.toBe("Project Reviewer");
      expect(registry.playbook("feature").instructions).not.toContain("project feature prompt");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("does not load .agents/skills/collie", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-registry-"));
    try {
      const registry = new CollaborationRegistry(join(dir, "user"));
      const project = join(dir, "project");
      mkdirSync(join(project, ".agents", "skills", "collie", "roles"), { recursive: true });
      writeFileSync(join(project, ".agents", "skills", "collie", "roles", "legacy.md"), role("legacy"));
      registry.loadProject(project);
      expect(registry.roles.has("legacy")).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
