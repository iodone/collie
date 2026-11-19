import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CollaborationRole = {
  id: string;
  title: string;
  purpose: string;
  duties: string[];
  prohibitions: string[];
  inputs?: string[];
  outputs?: string[];
  modes?: Record<string, { input?: string; output?: string; tools?: string[] }>;
  prompt?: string;
  source?: string;
};

export type PlaybookStage = {
  id: string;
  role: string;
  needs?: string[];
  parallel_with?: string;
  outputs?: string[];
  gate?: string;
};

export type CollaborationPlaybook = {
  id: string;
  title: string;
  version: number;
  when?: string[];
  stages: PlaybookStage[];
  gates?: Array<{ id: string; predicate: string }>;
  allowed_next?: string[];
  requires?: string[];
  discloses?: string[];
  source?: string;
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

function readDefinitions<T>(directory: string): T[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} must contain an object`);
      return parsed as T;
    });
}

export class CollaborationRegistry {
  readonly roles = new Map<string, CollaborationRole>();
  readonly playbooks = new Map<string, CollaborationPlaybook>();

  constructor(readonly configDir: string, builtinDir = defaultBuiltinDir()) {
    this.loadDirectory(builtinDir);
    this.loadDirectory(configDir);
  }

  /** User config first; a project may add or override by id under .collie/. */
  loadDirectory(root: string): void {
    for (const role of readDefinitions<CollaborationRole>(join(root, "roles"))) {
      if (!role.id || !role.title) throw new Error("role requires id and title");
      this.roles.set(role.id, role);
    }
    for (const playbook of readDefinitions<CollaborationPlaybook>(join(root, "playbooks"))) {
      if (!playbook.id || !Array.isArray(playbook.stages) || !Number.isInteger(playbook.version)) {
        throw new Error("playbook requires id, version and stages");
      }
      for (const stage of playbook.stages) {
        if (!stage.id || !stage.role) throw new Error(`playbook ${playbook.id} has an invalid stage`);
        if (!this.roles.has(stage.role) && stage.role !== "human") {
          throw new Error(`playbook ${playbook.id} references unknown role ${stage.role}`);
        }
      }
      this.playbooks.set(playbook.id, playbook);
    }
  }

  loadProject(folder: string): void {
    this.loadDirectory(join(folder, ".collie"));
    this.loadDirectory(join(folder, ".agents", "skills", "collie"));
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
