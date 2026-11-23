import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CollaborationRole = {
  id: string;
  version?: number;
  title: string;
  purpose: string;
  duties: string[];
  prohibitions: string[];
  inputs?: string[];
  outputs?: string[];
  modes?: Record<string, { input?: string; output?: string; tools?: string[] }>;
  prompt?: string;
  source?: string;
  origin?: "builtin" | "user" | "project";
  file?: string;
};

export type CollaborationPlaybook = {
  id: string;
  title: string;
  version: number;
  source?: string;
  origin?: "builtin" | "user" | "project";
  file?: string;
  instructions?: string;
};

const sourceTemplates = (() => {
  try { return new URL("../templates", import.meta.url).pathname; } catch { return ""; }
})();

function defaultBuiltinDir(): string {
  const candidates = [
    sourceTemplates,
    process.env.COLLIE_TEMPLATES,
    join(process.env.HOME ?? "", ".config", "herdr-core", "templates"),
  ].filter(Boolean);
  return candidates.find((dir) => existsSync(join(dir, "roles")) && existsSync(join(dir, "playbooks"))) ?? candidates[0] ?? "templates";
}

const SYSTEM_ROLES = new Set(["coordinator", "driver"]);

const PLAYBOOK_ALIASES: Record<string, string> = {
  "dsx-playbook-feature": "feature",
  "dsx-playbook-bug-fix": "bug-fix",
  "dsx-playbook-review": "review",
  "dsx-playbook-investigation": "investigation",
  "dsx-playbook-refactoring": "refactoring",
  "dsx-playbook-prototype": "prototype",
  "dsx-playbook-ratchet": "ratchet",
  "dsx-playbook-hillclimb": "hillclimb",
  "dsx-playbook-eval": "eval",
  "dsx-playbook-orchestrate": "orchestrate",
};

type Definition<T> = { value: T; body: string; file: string };

function readDefinitions<T>(directory: string): Definition<T>[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => {
      const file = join(directory, name);
      const text = readFileSync(file, "utf8");
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
      if (!match) throw new Error(`${file} needs YAML frontmatter`);
      const yaml = (globalThis as any).Bun?.YAML;
      if (!yaml) throw new Error("Bun.YAML is required to read role/playbook templates");
      const value = yaml.parse(match[1]) as T;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file} frontmatter must be an object`);
      return { value, body: text.slice(match[0].length), file };
    });
}

export class CollaborationRegistry {
  readonly roles = new Map<string, CollaborationRole>();
  readonly playbooks = new Map<string, CollaborationPlaybook>();
  #baseRoles: Map<string, CollaborationRole> | null = null;
  #basePlaybooks: Map<string, CollaborationPlaybook> | null = null;

  constructor(readonly configDir: string, builtinDir = defaultBuiltinDir()) {
    this.loadDirectory(builtinDir, "builtin");
    this.loadDirectory(configDir, "user");
    this.#baseRoles = new Map(this.roles);
    this.#basePlaybooks = new Map(this.playbooks);
  }

  /** Load a layer; system roles keep their built-in definition. */
  loadDirectory(root: string, origin: "builtin" | "user" | "project" = "user"): void {
    for (const { value: role, body, file } of readDefinitions<CollaborationRole>(join(root, "roles"))) {
      if (!role.id || !role.title) throw new Error("role requires id and title");
      if (origin !== "builtin" && SYSTEM_ROLES.has(role.id)) {
        throw new Error(`${role.id} is a system role and cannot be overridden`);
      }
      this.roles.set(role.id, { ...role, origin, prompt: file, file });
    }
    for (const { value: playbook, body, file } of readDefinitions<CollaborationPlaybook>(join(root, "playbooks"))) {
      if (!playbook.id || !playbook.title || !Number.isInteger(playbook.version)) {
        throw new Error("playbook requires id, title and version");
      }
      this.playbooks.set(playbook.id, { ...playbook, origin, file, instructions: body.trim() });
    }
    if (origin === "user") {
      this.#baseRoles = new Map(this.roles);
      this.#basePlaybooks = new Map(this.playbooks);
    }
  }

  /** Project layer is .collie only; each load starts from the built-in + user base. */
  loadProject(folder: string): void {
    const root = join(folder, ".collie");
    this.roles.clear();
    this.playbooks.clear();
    if (this.#baseRoles) for (const [id, role] of this.#baseRoles) this.roles.set(id, role);
    if (this.#basePlaybooks) for (const [id, playbook] of this.#basePlaybooks) this.playbooks.set(id, playbook);
    this.loadDirectory(root, "project");
  }

  snapshot() {
    return {
      roles: [...this.roles.values()],
      playbooks: [...this.playbooks.values()],
    };
  }

  playbook(id: string): CollaborationPlaybook {
    const value = this.playbooks.get(PLAYBOOK_ALIASES[id] ?? id);
    if (!value) throw new Error(`unknown playbook: ${id}`);
    return value;
  }

  defaultPlaybook(kind: string): string {
    return kind === "review" ? "review" : "feature";
  }
}
