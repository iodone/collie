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
      },
    },
  };
}
