import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CollaborationRole = {
  name: string;
  description: string;
  command?: string;
  prompt?: string;
  origin?: "system" | "config" | "defaults";
  file?: string;
};

export type CollaborationPlaybook = {
  name: string;
  description: string;
  version: number;
  origin?: "config" | "defaults";
  file?: string;
  instructions?: string;
};

const SYSTEM_ROLES = new Set(["coordinator", "driver"]);

const sourceTemplates = (() => {
  try { return new URL("../templates", import.meta.url).pathname; } catch { return ""; }
})();
const sourceDefaults = (() => {
  try { return new URL("../defaults", import.meta.url).pathname; } catch { return ""; }
})();

function systemDir(): string {
  const installed = join(homedir(), ".config", "herdr-core", "templates");
  return existsSync(join(sourceTemplates, "coordinator.md")) ? sourceTemplates
    : existsSync(join(installed, "coordinator.md")) ? installed
    : sourceTemplates;
}

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

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

/** Skill-style frontmatter: only the current name/description contract is accepted. */
function normalizeRole(value: any, file: string): CollaborationRole {
  const name = text(value?.name);
  const description = text(value?.description);
  if (!name || !description) throw new Error(`${file} needs name and description`);
  const command = text(value?.command);
  return { name, description, ...(command ? { command } : {}) };
}

function normalizePlaybook(value: any, file: string): CollaborationPlaybook {
  const name = text(value?.name);
  const description = text(value?.description);
  if (!name || !description || !Number.isInteger(value?.version)) {
    throw new Error(`${file} needs name, description and version`);
  }
  return { name, description, version: value.version };
}

function readRoleFile(file: string): CollaborationRole {
  const { value, file: path } = readDefinitions<any>(join(file, "..")).find((item) => item.file === file) ?? { value: null, file };
  if (!value) throw new Error(`${file} needs a valid role definition`);
  return { ...normalizeRole(value, file), origin: "system", prompt: path, file: path };
}

export class CollaborationRegistry {
  readonly roles = new Map<string, CollaborationRole>();
  readonly playbooks = new Map<string, CollaborationPlaybook>();
  readonly directives: { system: string; config: string; defaults: string };

  constructor(readonly configDir: string) {
    this.directives = { system: systemDir(), config: configDir, defaults: sourceDefaults };
    this.loadSystem();
    this.loadConfig();
    if (!this.roles.size || !this.playbooks.size) this.loadDefaults();
  }

  #addRole(value: any, file: string, origin: "system" | "config" | "defaults"): void {
    const role = normalizeRole(value, file);
    if (origin === "config" && SYSTEM_ROLES.has(role.name)) {
      throw new Error(`${role.name} is a system role and cannot be overridden`);
    }
    this.roles.set(role.name, { ...role, origin, prompt: file, file });
  }

  #addPlaybook(value: any, body: string, file: string, origin: "config" | "defaults" = "config"): void {
    const book = normalizePlaybook(value, file);
    this.playbooks.set(book.name, { ...book, origin, file, instructions: body.trim() });
  }

  loadSystem(): void {
    for (const name of SYSTEM_ROLES) {
      const file = join(this.directives.system, `${name}.md`);
      if (existsSync(file)) this.#addRole(readRoleFile(file), file, "system");
    }
  }

  #loadRoot(root: string, allowSystem: boolean): void {
    for (const { value, file } of readDefinitions<any>(join(root, "roles"))) {
      const name = text(value?.name);
      if (!allowSystem && SYSTEM_ROLES.has(name)) throw new Error(`${name} is a system role and cannot be overridden`);
      this.#addRole(value, file, "config");
    }
    for (const { value, body, file } of readDefinitions<any>(join(root, "playbooks"))) {
      this.#addPlaybook(value, body, file);
    }
  }

  loadConfig(): void {
    this.#loadRoot(this.directives.config, false);
  }

  /** Source defaults are a development/install fallback only when the config layer has no files. */
  loadDefaults(): void {
    for (const { value, file } of readDefinitions<any>(join(this.directives.defaults, "roles"))) {
      const name = text(value?.name);
      if (!this.roles.has(name)) this.#addRole(value, file, "defaults");
    }
    for (const { value, body, file } of readDefinitions<any>(join(this.directives.defaults, "playbooks"))) {
      const name = text(value?.name);
      if (!this.playbooks.has(name)) this.#addPlaybook(value, body, file, "defaults");
    }
  }

  /** Rebuild the catalog after a settings edit; a bad file leaves the old catalog in place. */
  reload(): void {
    const next = new CollaborationRegistry(this.configDir);
    this.roles.clear();
    this.playbooks.clear();
    for (const [name, role] of next.roles) this.roles.set(name, role);
    for (const [name, book] of next.playbooks) this.playbooks.set(name, book);
  }

  /** What Coordinator may choose from: metadata only, never role prompts or playbook bodies. */
  catalog() {
    return {
      playbooks: [...this.playbooks.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ name, description, version }) => ({ name, description, version })),
    };
  }

  /** What Driver needs to start helper roles: names, descriptions and the prompt file. */
  roleCatalog() {
    return {
      roles: [...this.roles.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ name, description, file, origin }) => ({ name, description, file, origin })),
    };
  }

  snapshot() {
    return {
      roles: [...this.roles.values()],
      playbooks: [...this.playbooks.values()],
      directives: this.directives,
    };
  }

  playbook(name: string): CollaborationPlaybook {
    const value = this.playbooks.get(name);
    if (!value) throw new Error(`unknown playbook: ${name}`);
    return value;
  }

  defaultPlaybook(kind: string): string {
    return kind === "review" ? "review" : kind === "verify" ? "investigation" : "feature";
  }
}
