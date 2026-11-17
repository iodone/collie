// Files for the Coordinator's message box: pasted (a clipboard image, or copied files) or dropped. They go to the agent
// the way its CLI reads them: as file paths in the message (Claude Code turns an image path into an image). An agent on
// another machine gets a copy there first (`hc put`). Pasted images are kept in data/chat-attach until the person sends
// or removes them.
// Ported from shepherdr's chat attach.js, without its Wayland-only assumptions: the clipboard image comes from
// osascript on macOS, from wl-paste on Wayland (see fromClipboard()). The pure part — what an image is, the path lines a
// message carries, the tiles' and thumbnails' fitting — is core/attach.js (tested there without herdr).

import { exec, hc, appHome } from "herdr";
import * as fs from "fs/promises";
import { base, isImage, paths, cover, fitThumbs, THUMB, THUMB_GAP, THUMB_ONE, THUMB_MANY } from "./core/attach.js";

export { base, isImage, paths, cover, fitThumbs, THUMB, THUMB_GAP, THUMB_ONE, THUMB_MANY };
export const ATTACH = () => `${appHome()}/data/chat-attach`;
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");

// The clipboard's image, here: [{ path, name, image, temp }] or []. macOS: the PNG flavor, written where the agent can
// read it. Wayland: copies of files first (text/uri-list), else an image. Elsewhere (X11, no clipboard tool): none.
export async function fromClipboard() {
  const os = (await exec("uname", ["-s"]).catch(() => null))?.stdout?.trim() ?? "";
  if (os === "Darwin") return fromMacClipboard();
  return fromWaylandClipboard();
}

async function fromMacClipboard() {
  const dir = ATTACH();
  const name = `pasted-${stamp()}.png`;
  const path = `${dir}/${name}`;
  const lines = [
    `do shell script "mkdir -p " & quoted form of ${JSON.stringify(dir)}`,
    "try",
    "set png to (the clipboard as «class PNGf»)",
    "on error",
    'return ""',
    "end try",
    `set f to open for access POSIX file ${JSON.stringify(path)} with write permission`,
    "set eof of f to 0",
    "write png to f",
    "close access f",
    'return "ok"',
  ];
  const r = await exec("osascript", lines.flatMap((l) => ["-e", l])).catch(() => null);
  if (r?.stdout?.trim() !== "ok") return [];
  const st = await fs.stat(path).catch(() => null);
  return st?.size ? [{ path, name, image: true, temp: true }] : [];
}

async function fromWaylandClipboard() {
  const types = (await exec("sh", ["-c", "wl-paste --list-types 2>/dev/null"]).catch(() => null))?.stdout?.split("\n") ?? [];
  if (types.includes("text/uri-list")) {
    const r = await exec("sh", ["-c", "wl-paste -n -t text/uri-list 2>/dev/null"]).catch(() => null);
    return paths(String(r?.stdout ?? "").split(/\r?\n/).filter((l) => l.startsWith("file://")).map((l) => decodeURIComponent(l.slice(7))));
  }
  const type = types.find((t) => /^image\/(png|jpeg|gif|webp|bmp)$/.test(t));
  if (!type) return [];
  const dir = ATTACH();
  const ext = type.split("/")[1].replace("jpeg", "jpg");
  const name = `pasted-${stamp()}.${ext}`;
  const r = await exec("sh", ["-c", 'mkdir -p "$1" && wl-paste -n -t "$2" > "$1/$3" && [ -s "$1/$3" ] && echo ok', "x", dir, type, name]).catch(() => null);
  return r?.stdout?.trim() === "ok" ? [{ path: `${dir}/${name}`, name, image: true, temp: true }] : [];
}

// The message's file lines: each file's path where the agent is. For another machine, a copy lands beside the agent's
// terminal (hc put). -> the paths, in order; throws (naming the file) when a copy doesn't land.
export async function deliver(files, addr, machine) {
  const out = [];
  for (const f of files ?? []) {
    if (!machine) { out.push(f.path); continue; }
    const r = await hc(["put", addr, f.path, "--json"]);
    let landed = null;
    try { landed = JSON.parse(r.stdout || "{}").path ?? null; } catch { landed = r.stdout.trim() || null; }
    if (r.code !== 0 || !landed) throw new Error(`${f.name} didn't reach ${machine}: ${(r.stderr || r.stdout).trim()}`);
    out.push(landed);
  }
  return out;
}

// A pasted image removed before sending goes. Sent ones stay a day (the agent may read them later), then go.
export function drop(f) {
  if (f?.temp && String(f.path).startsWith(`${ATTACH()}/`)) exec("rm", ["-f", f.path]);
}
export function prune() {
  exec("sh", ["-c", 'find "$1" -name "pasted-*" -mmin +1440 -delete 2>/dev/null; true', "x", ATTACH()]);
}

// Images shown in the chat (thumbnails, the viewer): image() loads from the app's folder, so each one is linked (or
// copied) into data/chat-attach/view, with its pixel size for fitting. Resolves { <path>: { rel, w, h } } for the ones
// that exist here and are images.
const VIEW = `
d="$1"; shift; mkdir -p "$d"
for p in "$@"; do
  [ -f "$p" ] || continue
  s=$(magick identify -format '%w %h' "$p[0]" 2>/dev/null) || s=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=' ' "$p" 2>/dev/null) \\
    || s=$(sips -g pixelWidth -g pixelHeight "$p" 2>/dev/null | awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END { if (w && h) print w " " h }')
  [ -n "$s" ] || continue
  n=$(printf '%s' "$p" | cksum | cut -d' ' -f1)-$(printf '%s' "\${p##*/}" | tr -c 'A-Za-z0-9._-' '_')
  [ -f "$d/$n" ] || ln -f "$p" "$d/$n" 2>/dev/null || cp "$p" "$d/$n" 2>/dev/null || continue
  printf '%s\\t%s\\t%s\\n' "$p" "$n" "$s"
done
true`;
export async function viewable(list) {
  const dir = `${ATTACH()}/view`;
  const r = await exec("sh", ["-c", VIEW, "view", dir, ...list]).catch(() => null);
  const out = {};
  for (const line of (r?.stdout ?? "").split("\n")) {
    const [p, n, size] = line.split("\t");
    const [w, h] = (size ?? "").split(" ").map(Number);
    if (p && n && w && h) out[p] = { rel: `data/chat-attach/view/${n}`, w, h };
  }
  return out;
}

// A big paste kept as a text file (sent by path like other files): data/chat-attach, named after its first line.
export async function textFile(text) {
  const first = String(text).split("\n").find((l) => l.trim())?.trim() ?? "pasted text";
  const slug = first.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "pasted-text";
  const name = `pasted-${Date.now().toString(36)}-${slug}.txt`;
  const path = `${ATTACH()}/${name}`;
  try {
    await exec("mkdir", ["-p", ATTACH()]);
    await fs.writeFile(path, text);
  } catch { return null; }
  return { path, name: first.length > 40 ? first.slice(0, 39) + "…" : first, image: false, text: true, temp: true };
}
