import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SourceConfig = {
  adapter?: string;
  enabled?: boolean;
  secret_env?: string;
  secret?: string;
  space_map?: Record<string, string>;
  space?: string;
};

export type ClientConfig = {
  enabled?: boolean;
  token_env?: string;
  token?: string;
  space?: string;
};

export type IngressConfig = {
  sources?: Record<string, SourceConfig>;
  clients?: Record<string, ClientConfig>;
};

export const configPath = (configDir: string): string => join(configDir, "sources.json");

export function loadIngressConfig(configDir: string): IngressConfig {
  const path = configPath(configDir);
  if (!existsSync(path)) return { sources: {}, clients: {} };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("sources.json must be an object");
  return {
    sources: raw.sources && typeof raw.sources === "object" ? raw.sources : {},
    clients: raw.clients && typeof raw.clients === "object" ? raw.clients : {},
  };
}

export function secretOf(value: { secret?: string; secret_env?: string; token?: string; token_env?: string }): string {
  if (value.secret_env && process.env[value.secret_env]) return process.env[value.secret_env]!;
  if (value.token_env && process.env[value.token_env]) return process.env[value.token_env]!;
  return value.secret ?? value.token ?? "";
}

export function clientAuth(config: IngressConfig, authorization: string | undefined): { ok: boolean; client?: string } {
  const value = String(authorization ?? "");
  if (!value.startsWith("Bearer ")) return { ok: false };
  const token = value.slice(7).trim();
  if (!token) return { ok: false };
  for (const [name, client] of Object.entries(config.clients ?? {})) {
    if (client.enabled === false) continue;
    if (secretOf(client) && token === secretOf(client)) return { ok: true, client: name };
  }
  return { ok: false };
}
