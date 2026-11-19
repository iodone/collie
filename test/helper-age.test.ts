import { describe, expect, test } from "bun:test";
import { subagentsOf } from "../mods/collie-chat/core/chat-view.js";

describe("helper activity age", () => {
  test("a live helper reports time since its last status, not terminal creation", () => {
    const now = Date.parse("2026-11-19T14:51:00Z");
    const created = now - 20 * 60 * 60 * 1000;
    const status = now - 5 * 60 * 1000;
    const [helper] = subagentsOf([
      {
        address: "t9t", parent: "t9s", state: "live",
        labels: { "herdr.role": "helper" },
        created_ms: created, status_ms: status,
        status: { state: "done" },
      },
    ], "t9s", now);
    expect(helper.at).toBe(created);
    expect(helper.since).toBe(status);
  });
});
