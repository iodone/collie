// mods/collie-chat's #20 composer parts, pure: attachment path shaping (core/attach.js), the "/" list (core/slash.js) and
// the "#" mentions (core/mentions.js). No herdr here, so these run anywhere (bun test).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { base, cover, fitThumbs, imagePaths, isImage, messageText, names, paths, THUMB, THUMB_GAP, THUMB_MANY, THUMB_ONE } from "../core/attach.js";
import { CLAUDE, CODEX, commandList, match as slashMatch, opensMenu, scanned, typing as slashTyping } from "../core/slash.js";
import { expand, hasMention, local, match as mentionMatch, parse, pickInto, plain, reachable, split, targetOf, token, typing as mentionTyping } from "../core/mentions.js";

const MOD = join(import.meta.dir, "..");

describe("core/attach.js: the files a message carries", () => {
  test("a picture is one by its extension", () => {
    for (const p of ["/tmp/a.png", "/tmp/a.JPG", "x.jpeg", "shot.heic", "scan.tif"]) expect(isImage(p)).toBe(true);
    for (const p of ["/tmp/a.txt", "/tmp/a.pdf", "a", "/tmp/png"]) expect(isImage(p)).toBe(false);
  });

  test("a path's name is its last part", () => {
    expect(base("/home/me/notes.txt")).toBe("notes.txt");
    expect(base("shot.png")).toBe("shot.png");
    expect(base("/a/b/")).toBe("b");
  });

  test("paths() names each file and knows the pictures among them", () => {
    expect(paths(["/tmp/shot.png", null, "/tmp/notes.md"])).toEqual([
      { path: "/tmp/shot.png", name: "shot.png", image: true, temp: false },
      { path: "/tmp/notes.md", name: "notes.md", image: false, temp: false },
    ]);
  });

  test("the message is the words, then a path on a line of its own each", () => {
    expect(messageText("look at this", ["/tmp/a.png"])).toBe("look at this\n\n/tmp/a.png");
    // A picture alone: no words, just its path (Claude Code makes it an image).
    expect(messageText("", ["/tmp/a.png"])).toBe("/tmp/a.png");
    expect(messageText("   ", ["/vm/shot.png", "/vm/b.txt"])).toBe("/vm/shot.png\n\n/vm/b.txt");
    expect(messageText("hi")).toBe("hi");
    expect(messageText("hi", [null, ""])).toBe("hi");
  });

  test("what the row shows: the files by name, the pictures by path", () => {
    const files = paths(["/tmp/shot.png", "/tmp/notes.md", "/vm/x.webp"]);
    expect(names(files)).toEqual(["notes.md"]);
    expect(imagePaths(files)).toEqual(["/tmp/shot.png", "/vm/x.webp"]);
    expect(names(null)).toEqual([]);
  });
});

describe("core/attach.js: the tiles and the thumbnails", () => {
  test("a tile shows the middle of an image", () => {
    expect(cover(400, 200, THUMB)).toEqual({ w: THUMB * 2, h: THUMB, left: -THUMB / 2, top: 0 });
    expect(cover(100, 100, THUMB)).toEqual({ w: THUMB, h: THUMB, left: 0, top: 0 });
    expect(cover(100, 400, THUMB)).toEqual({ w: THUMB, h: THUMB * 4, left: 0, top: -THUMB * 1.5 });
  });

  test("one image is fitted in THUMB_ONE, never above its own size", () => {
    const big = fitThumbs([{ w: 1000, h: 500 }]);
    expect(big.boxes[0]).toEqual({ w: THUMB_ONE[0], h: THUMB_ONE[0] / 2 });
    expect(big.h).toBe(THUMB_ONE[0] / 2);
    const small = fitThumbs([{ w: 80, h: 60 }]);
    expect(small.boxes[0]).toEqual({ w: 80, h: 60 });
  });

  test("several images fit THUMB_MANY each; a narrow column shrinks them together", () => {
    const two = fitThumbs([{ w: 1000, h: 1000 }, { w: 400, h: 400 }]);
    expect(two.boxes.map((b) => b.w)).toEqual([THUMB_MANY[1], THUMB_MANY[1]]);
    const narrow = fitThumbs([{ w: 1000, h: 500 }, { w: 1000, h: 500 }], 200);
    // Both 200 wide: shrunk to the 200 column, the gap counted (each floored, so a pixel or two over at worst).
    expect(narrow.boxes.every((b) => b.w < 200)).toBe(true);
    expect(narrow.boxes[0].w + narrow.boxes[1].w + THUMB_GAP).toBeLessThanOrEqual(204);
    expect(narrow.h).toBe(narrow.boxes[0].h);
  });

  test("an unread image is a quiet 4:3 box", () => {
    const fit = fitThumbs([null, null]);
    expect(fit.boxes[0]).toEqual({ w: Math.round((THUMB_MANY[1] * 4) / 3), h: THUMB_MANY[1] });
    expect(fit.h).toBe(THUMB_MANY[1]);
  });
});

describe("core/slash.js: the agent's commands", () => {
  test("\"/\" alone lists everything; a word narrows it, names that start with it first", () => {
    expect(slashTyping("/")).toBe("");
    expect(slashTyping("/mo")).toBe("mo");
    expect(slashTyping("/add-dir")).toBe("add-dir");
    expect(slashTyping("/mo extra")).toBe(null);
    expect(slashTyping("hello /mo")).toBe(null);
    const list = slashMatch(commandList("claude"), "me");
    expect(list[0].name).toBe("memory");
    expect(list.map((c) => c.name)).toContain("resume");
    expect(slashMatch(commandList("claude"), "zzz")).toEqual([]);
    expect(slashMatch(commandList("claude"), "").length).toBe(8);
  });

  test("a kind's own list, plus the person's commands on Claude Code (never a duplicate)", () => {
    const mine = [{ name: "deploy", about: "Ship it" }, { name: "clear", about: "Mine" }];
    expect(commandList("codex", mine).map((c) => c.name)).toEqual(CODEX.map(([n]) => n));
    const claude = commandList("claude", mine);
    expect(claude.map((c) => c.name)).toEqual([...CLAUDE.map(([n]) => n), "deploy"]);
    expect(claude.find((c) => c.name === "deploy")).toEqual({ name: "deploy", about: "Ship it" });
  });

  test("a command that opens a menu in the CLI is told apart, its prefixes too", () => {
    expect(opensMenu("claude", "/model")).toBe("model");
    expect(opensMenu("claude", "  /usage ")).toBe("usage");
    expect(opensMenu("claude", "/mo")).toBe("model");
    expect(opensMenu("codex", "/appr")).toBe("approvals");
    expect(opensMenu("claude", "/help")).toBe(null);
    expect(opensMenu("claude", "/model fast")).toBe(null);
    expect(opensMenu(null, "/model")).toBe(null);
  });

  test("the scan's lines are commands, a missing description named", () => {
    expect(scanned("deploy\tShip it\nreview\n\n")).toEqual([
      { name: "deploy", about: "Ship it" },
      { name: "review", about: "Your command" },
    ]);
    expect(scanned("")).toEqual([]);
  });
});

// A reach map as herdr-task writes it: this machine, a herdr-core link, and an ssh hop.
const GRAPH = {
  core: { id: "here", name: "mac" },
  spaces: [{ id: "sp1", name: "shop", icon: "🛒" }],
  assistants: [{ space: "sp1" }],
  links: [
    { to: "vm-demo", how: "ssh", next: {
      core: { id: "vm", name: "vm-demo" },
      spaces: [{ id: "sp9", name: "demo" }, { id: "sp1", machine: "mac", name: "shop" }],
      links: [{ to: "lap", how: "herdr-core", next: { core: { id: "lap" }, host: "laptop", spaces: [{ id: "sp3", name: "docs" }], links: [] } }],
    } },
  ],
};

describe("core/mentions.js: #spaces", () => {
  test("the reach map gives every machine's own spaces once, nearest first", () => {
    const all = reachable(GRAPH);
    expect(all.map((s) => s.name)).toEqual(["shop", "demo", "docs"]);
    expect(all[0]).toEqual({ id: "sp1", name: "shop", route: "", machine: "mac", target: "sp1", emoji: "🛒", assistant: true });
    expect(all[1].route).toBe("vm-demo");
    expect(all[1].target).toBe("vm-demo/sp9");
    expect(all[2].route).toBe("vm-demo>lap");
    expect(all[2].machine).toBe("lap");
    expect(reachable(null)).toEqual([]);
  });

  test("with no reach map, this machine's own spaces", () => {
    const list = [{ id: "sp1", name: "shop", machine: null }, { id: "vm/sp2", name: "far", machine: "vm" }];
    expect(local(list, null)).toEqual([{ id: "sp1", name: "shop", route: "", machine: "", target: "sp1", assistant: false }]);
    expect(local(list, "vm")[0]).toMatchObject({ id: "sp2", target: "sp2", machine: "vm" });
    expect(targetOf("", "sp1")).toBe("sp1");
    expect(targetOf("vm-demo", "sp9")).toBe("vm-demo/sp9");
  });

  test("\"#\" at the end of the box is what is being picked (never inside a word)", () => {
    expect(mentionTyping("#")).toBe("");
    expect(mentionTyping("hi #sh")).toBe("sh");
    expect(mentionTyping("line\n#shop\n")).toBe("shop");
    expect(mentionTyping("a#b")).toBe(null);
    expect(mentionTyping("#a-b.c")).toBe("a-b.c");
    expect(mentionTyping("no mention")).toBe(null);
  });

  test("matching: names that start with the word first, then names or machines that contain it", () => {
    const all = reachable(GRAPH);
    expect(mentionMatch(all, "do").map((s) => s.name)).toEqual(["docs"]);
    // A name or a machine that contains the word comes after those that start with it.
    expect(mentionMatch(all, "sh").map((s) => s.name)).toEqual(["shop"]);
    expect(mentionMatch(all, "demo").map((s) => s.name)).toEqual(["demo"]);
    // "vm" is a machine's name: the spaces it holds come up too.
    const byMachine = mentionMatch(all, "vm");
    expect(byMachine.map((s) => s.name)).toEqual(["demo"]);
    expect(mentionMatch([], "shop")).toEqual([]);
  });

  test("a pick's token, short form and expansion at send", () => {
    const shop = reachable(GRAPH)[1];
    expect(token(shop)).toBe("[#demo](space:vm-demo/sp9)");
    expect(pickInto("look at #de", shop)).toBe("look at #demo ");
    expect(pickInto("look at #de\n", shop)).toBe("look at #demo ");
    const picked = [{ name: "demo", target: "vm-demo/sp9" }];
    expect(expand("look at #demo now", picked)).toBe("look at [#demo](space:vm-demo/sp9) now");
    // A name not picked, or already a token, is left as typed.
    expect(expand("#other", picked)).toBe("#other");
    expect(expand("[#demo](space:vm-demo/sp9)", picked)).toBe("[#demo](space:vm-demo/sp9)");
    expect(expand("x", [])).toBe("x");
  });

  test("a message splits into words and mentions; a mention's target reads back", () => {
    const text = "ask [#demo](space:vm-demo/sp9) about it";
    expect(hasMention(text)).toBe(true);
    expect(hasMention("#demo")).toBe(false);
    expect(split(text)).toEqual([
      { text: "ask " },
      { mention: { name: "demo", target: "vm-demo/sp9", id: "sp9", route: "vm-demo" } },
      { text: " about it" },
    ]);
    expect(parse("demo", "vm-demo/sp9")).toEqual({ name: "demo", target: "vm-demo/sp9", id: "sp9", route: "vm-demo" });
    expect(parse("shop", "sp1")).toEqual({ name: "shop", target: "sp1", id: "sp1", route: "" });
    expect(split("plain words")).toEqual([{ text: "plain words" }]);
  });

  test("plain markdown says a space's machine, and when the agent can't reach it", () => {
    const text = "ask [#demo](space:vm-demo/sp9) and [#shop](space:sp1)";
    const all = reachable(GRAPH);
    const by = new Map(all.map((s) => [s.id, s.machine]));
    expect(plain(text, new Set(["sp1"]), (m) => by.get(m.id)))
      .toBe("ask `#demo · vm-demo · out of reach` and `#shop · mac`");
    // Unknown reach: nothing says locked.
    expect(plain(text, null, (m) => by.get(m.id))).toBe("ask `#demo · vm-demo` and `#shop · mac`");
    expect(plain("no mentions", null, () => "")).toBe("no mentions");
  });
});

describe("mods/collie-chat: the port's own files", () => {
  const source = readFileSync(join(MOD, "main.js"), "utf8");

  test("draws its own icons and the viewer, never another mod's chat files", () => {
    expect(source).not.toContain("mods/" + "chat/");
    for (const icon of ["plus.svg", "x.svg", "file.svg"]) expect(source).toContain(`mods/collie-chat/${icon}`);
    const viewer = readFileSync(join(MOD, "viewer.js"), "utf8");
    expect(viewer).toContain("mods/collie-chat/${icon}.svg");
    expect(viewer).toContain('"chevron-left", -1');
  });

  test("imports only its own files and the runtime", () => {
    for (const m of ["attach.js", "core/attach.js", "core/slash.js", "core/mentions.js", "viewer.js"]) expect(source).toContain(`from "./${m}"`);
    for (const spec of [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1])) {
      expect(["gpui-kit", "gpui-base", "herdr"].includes(spec) || spec.startsWith("./")).toBe(true);
    }
  });

  test("ships the picker script and the files the chat refers to", () => {
    const picker = readFileSync(join(MOD, "pick-files.py"), "utf8");
    expect(picker).toContain("xdg-desktop-portal");
    expect(picker).toContain("choose file with prompt");
  });
});
