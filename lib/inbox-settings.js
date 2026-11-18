const root = (home) => String(home ?? "").replace(/\/+$/, "");
export const coordinatorPath = (home) => `${root(home)}/.local/state/collie/coordinator.json`;

export const HELPER_VALUES = ["hidden", "visible"];

export function mergeCoordinator(value, patch) {
  if (patch.cli !== undefined && !["claude", "codex"].includes(patch.cli)) throw new Error("CLI must be claude or codex");
  if (patch.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(patch.effort)) throw new Error("invalid effort");
  if (patch.helper !== undefined && !HELPER_VALUES.includes(patch.helper)) throw new Error("helper must be hidden or visible");
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
        helper: patch.helper ?? coordinator.helper ?? "hidden",
      },
    },
  };
}

/** Hidden is the default; there is no Off. Space settings win over Everywhere. */
export function helperVisibility(value, space) {
  const current = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const local = current.spaces?.[space]?.coordinator?.helper ?? current.spaces?.[space]?.helper;
  const everywhere = current.everywhere?.coordinator?.helper ?? current.everywhere?.helper;
  return (local ?? everywhere) === "visible" ? "visible" : "hidden";
}
