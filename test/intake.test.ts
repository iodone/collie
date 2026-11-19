import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intakeEvent } from "../service/intake.ts";

describe("generic intake", () => {
  test("keeps an open envelope as data and builds only the Event shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-intake-"));
    try {
      const event = intakeEvent({
        native_id: "evt-9",
        event: "note.created",
        occurred_at: "2026-11-19T10:00:00+00:00",
        source: "gitlab",
        subject: "olap/miergo",
        payload: { anything: "the agent reads this later" },
        space: "collie",
      }, dir);
      expect(event).toMatchObject({
        source: "gitlab", key: "evt-9", type: "note.created",
        object: { kind: "none", id: "olap/miergo" },
        space_candidates: ["collie"],
      });
      expect(event.data_ref).toMatch(/intake\/ev_[0-9a-z]+\.json$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("passes an already-formed Event through unchanged", () => {
    const event = { id: "ev_12345678", source: "cron", key: "tick", type: "cron.tick", data_ref: "/tmp/x", data_digest: "sha256:" + "0".repeat(64), merge: {} };
    const dir = mkdtempSync(join(tmpdir(), "collie-intake-"));
    try { expect(intakeEvent(event, dir)).toBe(event); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
