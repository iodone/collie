// mods/collie-chat's rows (core/rows.js): the action band's places on either side, which part a press hit, how a long
// reply folds and which of its lines show, and the even rhythm the list places rows by. Ported from shepherdr's
// mods/chat/main.js (barLayout / bandOrder / spaced / foldOf / shownLines), pure: these run anywhere (bun test).
import { describe, expect, test } from "bun:test";

import {
  ACT, ACT_ROW, GAP, LINE_H, PILL, PILL_EDGE, PILL_GAP, bandActs, bandOrder, barLayout, edges, foldOf, guess,
  hitPart, parts, shownLines, sizesOf, spaced, wrapLines,
} from "../core/rows.js";

// Today at 10:00, so a band's time is "10:00" (five characters: the short width) whenever this runs.
const at = new Date();
at.setHours(10, 0, 0, 0);
const T = at.getTime();

describe("core/rows.js: the band's order, each side the other's mirror", () => {
  test("yours: time, actions, smiley, pills furthest right", () => {
    expect(bandOrder("user", ["reply", "copy", "rewind"])).toEqual(["time", "reply", "copy", "rewind", "react", "pills"]);
  });
  test("the agent's: pills furthest left, the actions reversed, the time at the inner end", () => {
    expect(bandOrder("agent", ["reply", "copy", "fork"])).toEqual(["pills", "react", "fork", "copy", "reply", "time"]);
  });
  test("no time, no smiley: what the narrow pane and a read-only chat leave", () => {
    expect(bandOrder("user", ["copy"], { time: false, react: false })).toEqual(["copy", "pills"]);
  });
  test("a message's actions: the person's words, and a prompt can be rewound to", () => {
    expect(bandActs("user", "hello")).toEqual(["reply", "copy", "rewind"]);
    expect(bandActs("user", "/clear")).toEqual(["reply", "copy"]);
    expect(bandActs("agent", "done", { fork: true })).toEqual(["reply", "copy", "fork"]);
    expect(bandActs("agent", "done", { fork: false })).toEqual(["reply", "copy"]);
  });
});

describe("core/rows.js: barLayout places every part, hitPart reads the same places", () => {
  const user = { side: "user", at: T, acts: ["reply", "copy", "rewind"], pills: [{ emoji: "👍", you: true, agent: false, count: 1 }] };
  const agent = { side: "agent", at: T, acts: ["reply", "copy", "fork"], pills: [{ emoji: "👍", count: 2 }, { emoji: "🎉", count: 1 }] };

  test("the column's edges, 18 px in from a centered 760 px column", () => {
    expect(edges(600, 760)).toEqual({ left: 18, right: 582 });
    expect(edges(1000, 760)).toEqual({ left: 120, right: 880 });
  });

  test("yours sit at the right edge, the pill flush against it", () => {
    const { x, w, parts: ps } = barLayout(user, { width: 600, column: 760 });
    expect(ps.map((p) => p.what)).toEqual(["time", "reply", "copy", "rewind", "react", "pill:👍"]);
    expect(ps[0]).toMatchObject({ x: 396, w: 38, text: "10:00", hover: true });
    expect(ps[1]).toMatchObject({ x: 396 + 38 + 2, w: ACT, hover: true });
    const pill = ps[5];
    expect(pill.w).toBe(PILL);
    expect(pill.pill).toMatchObject({ emoji: "👍" });
    expect(pill.hover).toBe(undefined);
    expect(pill.x + pill.w).toBe(582);
    // The pill PILL_EDGE from the smiley, and nothing past the column's right edge.
    expect(pill.x).toBe(ps[4].x + ACT + PILL_EDGE);
    expect(x).toBe(396);
    expect(w).toBe(582 - 396);
  });

  test("the agent's sit at the left edge: pills first, the time last at the inner end", () => {
    const { parts: ps } = barLayout(agent, { width: 600, column: 760 });
    expect(ps.map((p) => p.what)).toEqual(["pill:👍", "pill:🎉", "react", "fork", "copy", "reply", "time"]);
    expect(ps[0]).toMatchObject({ x: 18, w: PILL });
    // Pills PILL_GAP apart; the smiley PILL_EDGE from the last pill; the icons ACT_GAP apart.
    expect(ps[1].x).toBe(18 + PILL + PILL_GAP);
    expect(ps[2].x).toBe(ps[1].x + PILL + PILL_EDGE);
    expect(ps[3].x).toBe(ps[2].x + ACT + 2);
    expect(ps[6]).toMatchObject({ what: "time", text: "10:00" });
    // Every part has its room, and nothing overlaps.
    for (let i = 1; i < ps.length; i++) expect(ps[i].x).toBeGreaterThan(ps[i - 1].x + ps[i - 1].w - 0.001);
  });

  test("a press names its part; the time is no button; outside the band nothing", () => {
    const { parts: ps } = barLayout(user, { width: 600, column: 760 });
    const pill = ps[5];
    expect(hitPart(ps, pill.x + 2)?.what).toBe("pill:👍");
    expect(hitPart(ps, ps[0].x + 2)).toBeNull();
    expect(hitPart(ps, 5)).toBeNull();
    expect(hitPart(ps, undefined)).toBeNull();
  });

  test("many pills in a narrow pane: the time goes, so the row stays inside the column", () => {
    const many = { ...user, pills: Array.from({ length: 8 }, (_, i) => ({ emoji: `e${i}`, count: 1 })) };
    const { parts: ps } = barLayout(many, { width: 420, column: 760 });
    expect(ps.some((p) => p.what === "time")).toBe(false);
  });

  test("a read-only chat has no smiley; the pills already there still show", () => {
    const { parts: ps } = barLayout(user, { width: 600, column: 760, react: false });
    expect(ps.map((p) => p.what)).toEqual(["time", "reply", "copy", "rewind", "pill:👍"]);
  });
});

describe("core/rows.js: spaced, one even rhythm", () => {
  const bar = { id: "b:u1", of: "u1", side: "user", at: T, text: "hi", acts: ["reply", "copy"], pills: [] };

  test("a message's last row is flush on its band, and a band is always ACT_ROW", () => {
    const rows = spaced([
      { kind: "user", id: "u1", text: "hi", bar, blk: "u1" },
      { kind: "band", id: "ab:u1", bar, blk: "u1" },
      { kind: "agent", id: "a1", text: "hello", blk: "a1" },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "band", "gap", "agent"]);
    expect(rows[0]).toMatchObject({ top0: true, bot0: true });
    expect(rows[1].h).toBe(ACT_ROW);
    expect(rows[1].bar.box).toEqual({ top: 4, h: ACT });
    expect(rows[2]).toMatchObject({ kind: "gap", h: GAP });
    expect(rows[3]).toMatchObject({ top0: true, bot0: true });
  });

  test("quiet lines sit tight together: no gap inside a run", () => {
    const rows = spaced([
      { kind: "tools", id: "t1", text: "Read a" },
      { kind: "tools", id: "t2", text: "Read b" },
      { kind: "news", id: "n1", text: "TASK-1 started" },
      { kind: "user", id: "u1", text: "hi" },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["tools", "tools", "news", "gap", "user"]);
    expect("top0" in rows[1]).toBe(false);
    expect("bot0" in rows[1]).toBe(false);
    // Their words' ink sits a little inside the row, so the gap is that much shorter.
    // The quiet line's ink stops 6 px short of its bottom edge; the message above starts at its own.
    expect(rows[3].h).toBe(GAP - 6);
  });

  test("bands and gaps are their own height, and guess() takes it as it is", () => {
    const rows = spaced([
      { kind: "user", id: "u1", text: "hi", bar, blk: "u1" },
      { kind: "band", id: "ab:u1", bar, blk: "u1" },
      { kind: "agent", id: "a1", text: "hello", blk: "a1" },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "band", "gap", "agent"]);
    expect(guess(rows[1], { width: 600, column: 760 })).toBe(ACT_ROW);
    expect(guess(rows[2], { width: 600, column: 760 })).toBe(GAP);
  });
});

describe("core/rows.js: a long reply folds", () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i} of a long reply that keeps going and going`).join("\n");

  test("short replies don't fold", () => {
    expect(foldOf({ text: "short", ps: parts("short") })).toBeNull();
  });

  test("a long one keeps its first FOLD lines worth, and the rest is not laid out", () => {
    const ps = parts(long);
    const fold = foldOf({ text: long, ps, width: 600, column: 760 });
    expect(fold.open).toBe(false);
    expect(fold.last).toBe(0);
    expect(fold.clips.get(0)).toBeGreaterThanOrEqual(3 * LINE_H);
    expect(fold.clips.get(0)).toBeLessThan(40 * LINE_H);
  });

  test("unfolded (Show less), every part shows whole", () => {
    const ps = parts(long);
    const fold = foldOf({ text: long, ps, width: 600, column: 760, unfolded: true });
    expect(fold).toMatchObject({ open: true, last: ps.length - 1 });
    expect(fold.clips.size).toBe(0);
  });

  test("shownLines keeps the lines that fill the clip, and a few under the fade", () => {
    const shown = shownLines(long, 5 * LINE_H, 456);
    const lines = shown.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.length).toBeLessThanOrEqual(5 + 3);
    // A single paragraph longer than the room is cut where its lines end, not drawn whole.
    const one = "word ".repeat(400);
    const cut = shownLines(one, 3 * LINE_H, 320);
    expect(cut.length).toBeLessThan(one.length);
    expect(cut.length).toBeGreaterThan(0);
  });

  test("wrapLines counts a line's lines at a width", () => {
    expect(wrapLines("abc", 456)).toBe(1);
    expect(wrapLines(`${"x".repeat(100)}\n${"y".repeat(10)}`, 200)).toBe(4 + 1);
    expect(wrapLines("", 200)).toBe(1);
  });
});

describe("core/rows.js: an agent message's parts", () => {
  test("markdown around fenced code, each fence its own copy bar", () => {
    const ps = parts("before\n```js\nconst a = 1;\n```\nafter");
    expect(ps.map((p) => p.type)).toEqual(["md", "code", "md"]);
    expect(ps[1]).toMatchObject({ lang: "js", code: "const a = 1;" });
  });
  test("no fence: one markdown part", () => {
    expect(parts("just words")).toEqual([{ type: "md", text: "just words" }]);
  });
});

describe("core/rows.js: sizes the list can place", () => {
  test("measured heights win; a guess stands in until then", () => {
    const rows = [{ kind: "agent", id: "a1", text: "hi" }, { kind: "band", id: "ab:a1", h: ACT_ROW }];
    const keys = ["a1", "ab:a1"];
    const guessOf = (x) => (x.kind === "band" ? x.h : 99);
    expect(sizesOf(rows, new Map([["a1", 40]]), keys, guessOf)).toEqual([40, ACT_ROW]);
  });
  test("a NaN, zero or runaway height never leaves the list blank", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const guessOf = () => 60;
    expect(sizesOf(rows, new Map([["a", NaN], ["b", 0], ["c", 1e9]]), ["a", "b", "c"], guessOf)).toEqual([60, 60, 40000]);
  });
});