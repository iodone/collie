// The chat's active code must not reach Shepherdr's runtime: secrets use collie-secret and
// Collie's vault, usage is off, and voice/dictation/call is disabled. Voice implementation files
// stay vendored but are not reachable while VOICE is false.
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { expect, test, describe } from "bun:test";

const ROOT = join(import.meta.dir, "..");
const DISABLED = new Set([
  "dictate.js", "call-screen.js", "voice.ts", "key.ts", "record.ts", "audio.ts",
  "core/audio.js", "core/voice.js", "mac-audio.swift",
]);
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|ts)$/.test(name)) files.push(p);
  }
}
walk(ROOT);

const active = files.filter((p) => !DISABLED.has(relative(ROOT, p).replaceAll("\\", "/")) && !p.includes("/tests/"));

describe("collie chat runtime is decoupled from Shepherdr", () => {
  test("secrets use collie-secret and Collie's vault", () => {
    const s = readFileSync(join(ROOT, "secrets.js"), "utf8");
    expect(s).toContain("collie-secret");
    expect(s).toContain(".local/share/collie/secrets");
    expect(s).not.toContain("herdr-secret");
    expect(s).not.toContain(".herdr/vault");
  });

  test("no active file reads Shepherdr's secret, service, usage or sidebar stores", () => {
    const banned = ["herdr-secret", ".herdr/vault.json", ".herdr/shepherdr", "spaces-chat", "lib/addons.json"];
    const bad = [];
    for (const p of active) {
      const text = readFileSync(p, "utf8");
      for (const word of banned) if (text.includes(word)) bad.push(`${relative(ROOT, p)}: ${word}`);
    }
    expect(bad).toEqual([]);
  });

  test("voice, dictation and calls stay disabled and hidden", () => {
    const main = readFileSync(join(ROOT, "main.js"), "utf8");
    expect(main).toContain("const VOICE = false");
    expect(main).toContain("if (!VOICE) return;");
    expect(main).not.toContain('addonOn("voice")');
  });

  test("usage is a no-op, not a Shepherdr log", () => {
    const s = readFileSync(join(ROOT, "usage.js"), "utf8");
    expect(s).toContain("export function note");
    expect(s).not.toContain("exec(");
    expect(s).not.toContain(".herdr");
  });
});
