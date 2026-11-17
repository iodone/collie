// The artifact viewer: a ticket's Artifacts list opens one here. The shell: mods/collie-artifacts'
// toolbar (props.artifact, its bar.js) over the artifact's own mod, on a backdrop in the theme's
// colors. From a ticket it covers the whole window. From a dialog it opens as a modal of a fitting
// size over that dialog instead (artifact.modal), and
// closing it returns there.
// Shared: the source is lib/artview.js; bin/collie-sync copies it into each mod in lib/COPIES.
// Edit lib/artview.js, never a mod's copy, then run bin/collie-sync.

import { exec, appHome, openOverlay, theme, settings } from "herdr";
import { toast, plainError } from "./ui.js";

const CLI = () => `${appHome()}/mods/collie-artifacts/bin/collie-artifact`;

// The artifact helper (collie-artifact, --json); a failure throws its own words.
export async function artifactCli(machine, args) {
  const r = await exec(CLI(), [...(machine ? ["--on", machine] : []), ...args, "--json"]);
  let out = null;
  try { out = JSON.parse(r.stdout.trim().split("\n").pop() || "null"); } catch {}
  if (r.code !== 0 || !out || out.error) throw new Error(out?.error || r.stderr?.trim() || "");
  return out;
}

// The latest version's mod name, from any version's (art-<id>--v<n>).
export const baseMod = (mod) => String(mod).replace(/--v\d+$/, "");

// The viewer's layout: the toolbar over the artifact's own mod, on the backdrop.
export function viewerLayout(artifact) {
  return {
    type: "column", background: `${theme().background}f2`, children: [
      { type: "block", size: { px: 48 }, content: { mod: "collie-artifacts", props: { artifact } } },
      { type: "column", padding: [8, 24], children: [
        { type: "block", radius: 8, background: "background", border: { width: 1, color: "border" }, content: { mod: artifact.mod } }] }],
  };
}

// The modal's size: up to 900×700, and always 40 px clear of the window's edges (the viewport is
// in pixels at this zoom; an overlay's size is at zoom 1).
const MODAL = { width: 900, height: 700 };
function modalSize() {
  let v = null;
  try { v = globalThis.window?.viewport_size?.(); } catch {}
  const zoom = Number(settings()?.zoom) || 1;
  const room = (px, max) => (px > 0 ? Math.max(320, Math.min(max, Math.round(px / zoom) - 80)) : max);
  return { width: room(v?.width, MODAL.width), height: room(v?.height, MODAL.height) };
}

// An artifact opened from a dialog: a modal over it, its toolbar (title, version, X) over the
// artifact's own mod, which scrolls inside. Esc, the X or a click beside it closes it, back to
// the dialog as it was.
function showModal(artifact) {
  openOverlay({ kind: "dialog", ...modalSize(), layout: {
    type: "column", background: "popover", divider: { width: 1, color: "border" }, children: [
      { type: "block", size: { px: 48 }, content: { mod: "collie-artifacts", props: { artifact } } },
      { type: "block", background: "background", content: { mod: artifact.mod } }] } });
}

// Shows an artifact whose mod is already in this app: over artifact.area ({ x, y, width, height }
// in the window: a chat pane, as the image viewer opens) when it has one, else the whole window;
// a modal when artifact.modal. The area and modal stay in the toolbar's props, so stepping
// versions reopens it in the same place.
export function showViewer(artifact) {
  if (artifact.modal) return showModal(artifact);
  const a = artifact.area;
  const at = a ? { x: Math.round(a.x), y: Math.round(a.y) } : { x: 0, y: 0 };
  const size = a ? { width: Math.round(a.width), height: Math.round(a.height) } : { width: 1, height: 1 };
  openOverlay({ kind: "popup", frame: "none", ...size, at, layout: viewerLayout(artifact) });
}

// Opens a: { id, title, version, latest?, machine, modal? }: its mod made in this app first (pulled
// from its machine), that version when it's older than the latest. modal: a fitting modal instead
// (from a dialog); show: what shows it once pulled (default the viewer).
export function openViewer(a, show = showViewer) {
  const machine = a.machine ?? null;
  const older = a.latest && a.version && a.version < a.latest;
  return artifactCli(null, ["pull", a.id, ...(machine ? ["--from", machine] : []), ...(older ? ["--version", String(a.version)] : [])])
    .then((out) => show({ mod: out.mod, base: baseMod(out.mod), id: a.id, title: a.title, version: a.version, latest: a.latest ?? a.version, machine, ...(a.modal ? { modal: true } : {}) }))
    .catch((e) => { toast({ title: "Artifact didn't open", body: plainError(e), level: "error" }); });
}
