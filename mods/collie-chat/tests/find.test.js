// mods/collie-chat's find (core/find.js): which loaded rows hold the words typed, the match the bar is on, and how a
// row's words are marked. No herdr here, so these run anywhere (bun test).
import { describe, expect, test } from "bun:test";

import { countWord, mark, matches, rowAt, step, totalOf } from "../core/find.js";

// The rows mods/collie-chat/main.js rows() makes, as far as Find cares: a day label and a card are no words of their
// own, and a message's words are its text.
const rows = [
  { kind: "day", id: "day-1", text: "Yesterday" },
  { kind: "user", id: "u1", text: "Port the find bar to the coordinator chat" },
  { kind: "agent", id: "a1", text: "Ported the find bar. The find bar closes on Esc." },
  { kind: "tools", id: "t1", text: "Read mods/chat/main.js" },
  { kind: "card", id: "card-1", strips: [] },
  { kind: "brief", id: "b1", text: "Find it: find the rows" },
];

describe("core/find.js: every match in the loaded rows", () => {
  test("a row counts each of its words, case-blind, in row order", () => {
    const found = matches(rows, "find bar");
    expect(found).toEqual([
      { index: 1, id: "u1", n: 1 },
      { index: 2, id: "a1", n: 2 },
    ]);
    expect(totalOf(found)).toBe(3);
  });

  test("an empty or blank query matches nothing, and a day label or a card is never searched", () => {
    expect(matches(rows, "")).toEqual([]);
    expect(matches(rows, "   ")).toEqual([]);
    expect(matches(rows, "Yesterday")).toEqual([]);
    expect(matches(rows, null)).toEqual([]);
  });

  test("a query no row holds matches nothing", () => {
    expect(matches(rows, "voice call")).toEqual([]);
    expect(totalOf([])).toBe(0);
  });

  test("a row without words (an artifact still publishing) is skipped", () => {
    expect(matches([{ kind: "artifact", id: "x", text: "" }], "x")).toEqual([]);
  });
});

describe("core/find.js: the match the bar is on", () => {
  test("a global count maps to its row and that row's place in it", () => {
    const found = matches(rows, "find");
    // u1 "find" once, a1 "find" twice ("find bar" twice), b1 "Find it: find" twice.
    expect(found.map((m) => [m.id, m.n])).toEqual([["u1", 1], ["a1", 2], ["b1", 2]]);
    expect(rowAt(found, 0).id).toBe("u1");
    expect(rowAt(found, 1).id).toBe("a1");
    expect(rowAt(found, 2).id).toBe("a1");
    expect(rowAt(found, 3).id).toBe("b1");
    expect(rowAt(found, 4).id).toBe("b1");
    // Past the end is the last match, as shepherdr's findRow had it.
    expect(rowAt(found, 99).id).toBe("b1");
  });

  test("no match at all is no row", () => {
    expect(rowAt([], 0)).toBe(null);
  });

  test("stepping wraps both ways over the words, not the rows", () => {
    expect(step(0, 3, 1)).toBe(1);
    expect(step(1, 3, 1)).toBe(2);
    expect(step(2, 3, 1)).toBe(0);
    expect(step(0, 3, -1)).toBe(2);
    expect(step(0, 0, 1)).toBe(0);
    expect(step(0, 3, 3)).toBe(0);
  });

  test("how many: the place is one-based, and never past the count", () => {
    expect(countWord(0, 3)).toBe("1 of 3");
    expect(countWord(2, 3)).toBe("3 of 3");
    expect(countWord(7, 3)).toBe("3 of 3");
  });

  test("a long conversation: stepping visits every matching row in order and wraps to the first", () => {
    const long = Array.from({ length: 300 }, (_, i) => i % 2
      ? { kind: "agent", id: `a${i}`, text: `step ${i}: nothing to see here` }
      : { kind: "user", id: `u${i}`, text: `the needle is in message ${i}` });
    const found = matches(long, "needle");
    const total = totalOf(found);
    expect(found.length).toBe(150);
    expect(total).toBe(150);
    // The row each step lands on exists, holds the query, and is one of the matching rows.
    let idx = 0;
    const seen = new Set();
    for (let n = 0; n < total; n++) {
      const row = rowAt(found, idx);
      expect(row.index).toBeLessThan(long.length);
      expect(long[row.index].text.toLowerCase()).toContain("needle");
      expect(seen.has(row.id)).toBe(false);
      seen.add(row.id);
      idx = step(idx, total, 1);
    }
    expect(idx).toBe(0);
    expect(seen.size).toBe(150);
  });
});

describe("core/find.js: the words it bolds", () => {
  test("each match is bold, every one of them, case kept", () => {
    expect(mark("the find bar finds", "find")).toBe("the **find** bar **find**s");
    expect(mark("Find and find", "find")).toBe("**Find** and **find**");
  });

  test("code, fenced or inline, is left as it is", () => {
    expect(mark("run `find .` now", "find")).toBe("run `find .` now");
    expect(mark("a\n```\nfind .\n```\nb find", "find")).toBe("a\n```\nfind .\n```\nb **find**");
  });

  test("a query that holds markdown's own marks is not marked (it would break the words)", () => {
    for (const q of ["*", "a_b", "`find`", "[x]", "a\\b"]) expect(mark("look for it", q)).toBe("look for it");
  });

  test("no query, or a query no word has, leaves the words untouched", () => {
    expect(mark("plain words", "")).toBe("plain words");
    expect(mark("plain words", "   ")).toBe("plain words");
    expect(mark("plain words", "nothing")).toBe("plain words");
  });
});