const root = (home) => String(home ?? "").replace(/\/+$/, "");
export const coordinatorPath = (home) => `${root(home)}/.local/state/collie/coordinator.json`;

export function mergeCoordinator(value, patch) {
  if (patch.cli !== undefined && !["claude", "codex"].includes(patch.cli)) throw new Error("CLI must be claude or codex");
  if (patch.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(patch.effort)) throw new Error("invalid effort");
  const current = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const coordinator = current.everywhere?.coordinator ?? {};
  return {
    ...current,
    everywhere: {
      ...current.everywhere,
      coordinator: {
        ...coordinator,
        ...(patch.cli !== undefined ? { cli: patch.cli } : {}),
        ...(patch.model !== undefined ? { model: String(patch.model || "default").trim() || "default" } : {}),
        ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
        ...(patch.perm !== undefined ? { perm: patch.perm } : {}),
      },
    },
  };
}

export const taskSettingsPath = (home) => `${root(home)}/.config/collie/settings.json`;

/** Merge one role profile without dropping unrelated worker/reviewer/task settings. */
export function mergeRole(value, role, patch) {
  const current = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const profile = current[role] && typeof current[role] === "object" ? current[role] : {};
  const next = { ...profile };
  for (const [key, item] of Object.entries(patch)) {
    if (item === "" || item === null || item === undefined) delete next[key];
    else next[key] = item;
  }
  return { ...current, [role]: next };
}

export function mergeTaskSetting(value, patch) {
  const current = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const tasks = current.tasks && typeof current.tasks === "object" ? current.tasks : {};
  const next = { ...tasks };
  for (const [key, item] of Object.entries(patch)) {
    if (item === "" || item === null || item === undefined) delete next[key];
    else next[key] = item;
  }
  return { ...current, tasks: next };
}
