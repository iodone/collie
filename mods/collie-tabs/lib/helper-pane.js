// Where the Coordinator helper goes: the right panel's stack gets one block whose content is the
// helper terminal, and the panel selects it. No terminal gets its own pane, so Hidden leaves no
// trace and Visible reuses the same kept helper.

export const TERM = "collie-helper-term";
export const PANEL = "panel";
export const STACK = "panel-body";
export const FALLBACK = "collie";

export function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

/** Hidden is the default; space settings win over Everywhere. There is no Off. */
export function helperVisibility(value, space) {
  const current = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const local = current.spaces?.[space]?.coordinator?.helper ?? current.spaces?.[space]?.helper;
  const everywhere = current.everywhere?.coordinator?.helper ?? current.everywhere?.helper;
  return (local ?? everywhere) === "visible" ? "visible" : "hidden";
}

/** The active space's persistent helper, by the labels the service writes. */
export function helperTerminal(terms, space) {
  const id = String(space ?? "").split("/").pop();
  if (!id) return null;
  return (terms ?? []).find((term) =>
    term.state === "live"
    && term.labels?.["herdr.role"] === "helper"
    && term.labels?.["herdr.job.space"] === id) ?? null;
}

/** Add or update the terminal block in the panel-body stack. */
export function pointHelper(tree, address) {
  const body = find(tree, STACK);
  if (!body || !Array.isArray(body.children)) return { tree, changed: false, body: null };
  const node = { id: TERM, type: "block", content: { terminal: address } };
  const at = body.children.findIndex((child) => child.id === TERM);
  if (at >= 0 && body.children[at].content?.terminal === address) return { tree, changed: false, body };
  if (at >= 0) body.children[at] = node;
  else body.children.push(node);
  return { tree, changed: true, body };
}
