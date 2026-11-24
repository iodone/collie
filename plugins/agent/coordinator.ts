type Json = Record<string, any>;

export interface CoordinatorConfig {
  cli: "claude" | "codex";
  model?: string;
  effort?: string;
  /** Optional interactive argv for the persistent helper; defaults to the CLI's interactive mode. */
  helper_args?: string[];
}

export function coordinatorConfig(settings: Json, space: string): CoordinatorConfig {
  const everywhere = settings.everywhere?.coordinator ?? {};
  const local = settings.spaces?.[space]?.coordinator ?? {};
  const config = { ...everywhere, ...local };
  if (!["claude", "codex"].includes(config.cli)) {
    throw new Error(`space ${space} needs coordinator.cli = claude or codex`);
  }
  return config as CoordinatorConfig;
}
