// The chat's code must not reach Shepherdr's runtime: secrets use collie-secret and Collie's
// vault, usage is off, and the voice/dictation/call stack is gone (files deleted, not hidden).
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { expect, test, describe } from "bun:test";

const ROOT = join(import.meta.dir, "..");
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|ts)$/.test(name)) files.push(p);
  }
}
walk(ROOT);

const text = (p) => readFileSync(p, "utf8");
const shown = (p) => relative(ROOT, p).replaceAll("\\", "/");
const active = files.filter((p) => !p.includes("/tests/"));

describe("collie chat runtime is decoupled from Shepherdr and has no voice stack", () => {
  test("secrets use collie-secret and Collie's vault", () => {
    const s = text(join(ROOT, "secrets.js"));
    expect(s).toContain("collie-secret");
    expect(s).toContain(".local/share/collie/secrets");
    expect(s).not.toContain("herdr-secret");
    expect(s).not.toContain(".herdr/vault");
  });

  test("no chat file names Shepherdr's secret, service, usage or sidebar stores", () => {
    const banned = ["herdr-secret", ".herdr/vault.json", ".herdr/shepherdr", "spaces-chat", "lib/addons.json"];
    const bad = [];
    for (const p of active) {
      const t = text(p);
      for (const word of banned) if (t.includes(word)) bad.push(`${shown(p)}: ${word}`);
    }
    expect(bad).toEqual([]);
  });

  test("the voice, dictation and call stack is deleted, not disabled", () => {
    const gone = [
      "dictate.js", "call-screen.js", "voice.ts", "key.ts", "record.ts", "audio.ts",
      "transcribe.ts", "mac-audio.swift", "core/audio.js", "core/voice.js", "core/screen.js",
    ];
    const left = gone.filter((f) => existsSync(join(ROOT, f)));
    expect(left).toEqual([]);
  });

  test("no chat file keeps voice, dictation or call code or words", () => {
    const banned = [
      "VOICE", "Dictation", "dictate", "dictation", "voice", "Voice",
      "CallScreen", "toggleCall", "callComposer", "liveRow", "herdr-audio",
    ];
    const bad = [];
    for (const p of active) {
      const t = text(p);
      for (const word of banned) if (t.includes(word)) bad.push(`${shown(p)}: ${word}`);
    }
    expect(bad).toEqual([]);
  });

});
