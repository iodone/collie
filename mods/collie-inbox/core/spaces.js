// What the window needs to know about the spaces' chats: the core labels an agent and its chat pane
// are marked with (herdr.chat, herdr.chat.read, herdr.chat.slot), and which machine an address
// belongs to. The window gets the spaces themselves from Herdr (spaces()).
// Shared core: the source is core/spaces.js; bin/collie-sync copies it into the mods in lib/COPIES.

export const READ = "herdr.chat.read";
export const machineOf = (address) => (String(address).includes("/") ? String(address).split("/")[0] : null);

// The chat pane an agent is parked behind: its core label herdr.chat. Like every label, it holds the id its own
// machine gives the pane (no "<machine>/" in front), so every window and the service read the same pane whatever
// they call that machine. A window that wrote its own "<machine>/<pane>" made another window miss the pane and
// end the agent as one whose chat had closed (#761).
export const CHAT = "herdr.chat";
// What goes in herdr.chat for a chat pane (an app id: "<machine>/<pane>" for another machine's).
export const chatLabel = (pane) => (pane ? String(pane).split("/").pop() : "");
// The chat pane a terminal is parked behind, as this window's app id (null: none). Current
// labels hold a local pane id; the terminal's machine supplies the remote prefix.
export function chatPane(k) {
  const c = k?.labels?.[CHAT];
  if (!c) return null;
  const m = machineOf(k.address ?? "");
  return m ? `${m}/${c}` : c;
}

// The slot an agent was started for (a coordinator chat's, before it had an agent): herdr.chat.slot. The chat finds
// its agent again after a reload by it (mods/collie-chat slotAgent()). It holds the slot name as written.
export const SLOT = "herdr.chat.slot";
export const slotOf = (k) => k?.labels?.[SLOT] ?? null;
