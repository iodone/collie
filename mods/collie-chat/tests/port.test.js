// mods/collie-chat is shepherdr's mods/chat ported (#26): the same tree, with Collie's identifiers.
// No herdr and no gpui here (bun test can't load them), so this checks what a load would trip
// over: every file parses, every local import names a file and a name it exports, the mods are
// named as Collie's (mod.json, addons.json), and every asset they draw exists on disk.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MODS = resolve(ROOT, "..");
const TREE = ["collie-chat", "collie-chat-models", "collie-chat-react", "collie-chat-image"].map((m) => join(MODS, m));

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = TREE.flatMap(walk);
// The test names what it forbids: it never checks itself.
const js = files.filter((f) => f.endsWith(".js") && !f.includes("/tests/"));
const source = (f) => readFileSync(f, "utf8");
const transpiler = new Bun.Transpiler({ loader: "js" });
const shown = (f) => f.slice(MODS.length + 1);

describe("the ported tree is every file shepherdr's chat has, adapted, and it loads", () => {
  test("every .js file parses as a module", () => {
    expect(js.length).toBeGreaterThan(40);
    const broken = [];
    for (const f of js) { try { transpiler.transformSync(source(f)); } catch (e) { broken.push(`${shown(f)}: ${e.message}`); } }
    expect(broken).toEqual([]);
  });

  test("every relative import names a file that exists", () => {
    const missing = [];
    for (const f of js) {
      for (const m of source(f).matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
        const target = resolve(dirname(f), m[1]);
        if (!existsSync(target)) missing.push(`${shown(f)} -> ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every name a local import asks for is exported by that file", () => {
    // The names a file exports: declarations (`export const a = 1, b = 2`), clauses (`export { a as b }`), default.
    const exportsOf = (text) => {
      const names = new Set();
      for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([\w$]+)/g)) names.add(m[1]);
      for (const m of text.matchAll(/export\s+(?:const|let|var)\s+([^;]+)/g)) {
        for (const d of m[1].split(",")) { const n = d.trim().match(/^([\w$]+)\s*=/); if (n) names.add(n[1]); }
      }
      for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const raw of m[1].split(",")) { const n = raw.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
      }
      return names;
    };
    const missing = [];
    for (const f of js) {
      for (const m of source(f).matchAll(/import\s+(?:\*\s+as\s+[\w$]+|\{([^}]*)\}|([\w$]+))\s+from\s+["'](\.[^"']+)["']/g)) {
        if (!m[1] || m[3].endsWith(".json")) continue;
        const target = resolve(dirname(f), m[3]);
        if (!existsSync(target) || !target.endsWith(".js")) continue;
        const text = source(target), names = exportsOf(text), star = text.includes("export *");
        for (const raw of m[1].split(",")) {
          const name = raw.trim().split(/\s+as\s+/)[0].trim();
          if (name && !names.has(name) && !star) missing.push(`${shown(f)}: ${name} from ${m[3]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("the mods are named as Collie's, and loaded", () => {
    for (const [dir, title] of [["collie-chat", "Coordinator"], ["collie-chat-models", "Model menu"], ["collie-chat-react", "Reactions"], ["collie-chat-image", "Image"]]) {
      const mod = JSON.parse(readFileSync(join(MODS, dir, "mod.json"), "utf8"));
      expect([dir, mod.place, mod.title]).toEqual([dir, "none", title]);
    }
    const addons = JSON.parse(readFileSync(join(MODS, "..", "addons.json"), "utf8"));
    for (const dir of TREE.map(shown)) expect([dir, addons.mods.includes(dir)]).toEqual([dir, true]);
  });

  test("no shepherdr identifier is left: mods, shared keys, CLIs and the restart script are Collie's", () => {
    const banned = [
      "mods/chat", "\"chat-models\"", "\"chat-react\"", "\"chat-image\"",
      "shared(\"chat.", "setShared(\"chat.", "mod: \"chat\"", ".mod === \"chat\"",
      "mods/coordinator/restart.sh", "herdr-task", "herdr-artifact", "herdr-agent-state",
      "mods/workspace-chrome", "mods/tasks/", "shepherdr-settings",
    ];
    for (const f of js) {
      const text = source(f);
      for (const word of banned) expect([shown(f), word, text.includes(word)]).toEqual([shown(f), word, false]);
    }
  });

  // The chat's task links and cards are Collie's: the Inbox's queue and ticket (mods/collie,
  // mods/collie-tabs), its own artifacts (mods/collie-artifacts). Shepherdr's Tasks panel and
  // its Accept card are not ported: the shared cores in core/ (task data, read-only) are not UI.
  test("no Tasks panel is left in the chat's views: no panel.js, no accept card, no mods/tasks", () => {
    const ui = js.filter((f) => !f.includes("/core/"));
    const banned = ["accept-card", "\"./panel.js\"", "mods/tasks", "mods/task-artifacts", "PanelHost", "openTaskThread", "backToTasks", "requestWorkerTerminal", "TASKS_STACK"];
    for (const f of ui) {
      const text = source(f);
      for (const word of banned) expect([shown(f), word, text.includes(word)]).toEqual([shown(f), word, false]);
    }
    expect(existsSync(join(ROOT, "panel.js"))).toBe(false);
  });

  test("every asset a mod draws is on disk", () => {
    const missing = [];
    for (const f of js) {
      for (const m of source(f).matchAll(/(?:^|["'`(])mods\/([\w./-]+\.(?:svg|png|json|sh|py|ts|swift))/g)) {
        const p = join(MODS, "..", "mods", m[1]);
        if (!existsSync(p) && !m[1].startsWith("collie-chat")) missing.push(`${shown(f)}: mods/${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the pure cores load: chat-view, chat-log, secrets, asks, screens, agents, slash, mentions", async () => {
    const cores = ["chat-view", "chat-log", "secrets", "asks", "screens", "agents", "slash", "mentions", "person", "bg-jobs", "clean-env", "task-artifacts", "usage"];
    for (const name of cores) {
      const mod = await import(join(ROOT, "core", `${name}.js`));
      expect([name, Object.keys(mod).length > 0]).toEqual([name, true]);
    }
  });
});
