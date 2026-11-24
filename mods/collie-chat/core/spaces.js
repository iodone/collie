// Spaces as the chat needs them: the core labels an agent and its chat pane carry, the Assistant of
// a space, and whether it has something new (herdr.chat.read). Herdr supplies the spaces themselves.
// Shared core: the source is core/spaces.js; bin/collie-sync copies it into the mods in lib/COPIES.

export const READ = "herdr.chat.read";
export const machineOf = (address) => (String(address).includes("/") ? String(address).split("/")[0] : null);

// A space's Assistant: the live coordinator terminal labelled for it, on the space's machine.
export function assistantOf(space, ts) {
  const id = String(space.id).split("/").pop();
  return ts.find((k) => k.state === "live" && k.labels?.["herdr.role"] === "coordinator"
    && k.labels?.["herdr.coordinator.space"] === id && machineOf(k.address) === (space.machine ?? null)) ?? null;
}

// The turn last read. Before any mark: the turn the window last saw it done at (its "collie-chat.seen").
export function readTurn(k, seen = {}) {
  const mark = Number(k.labels?.[READ]);
  return Number.isFinite(mark) ? mark : seen[k.address] ?? 0;
}

// Unread, as Slack has it: only an Assistant counts; task chats never make a row bold.
export function isUnread(k, seen = {}, asked = 0) {
  if (!k || k.labels?.["herdr.role"] !== "coordinator") return false;
  return (k.turn ?? 0) > Math.max(readTurn(k, seen), asked);
}
