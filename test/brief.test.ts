import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBrief } from "../kernel/brief.ts";

const event = await Bun.file(new URL("../protocol/fixtures/event.json", import.meta.url)).json();

describe("task brief", () => {
  test("renders the playbook and driver instructions", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-brief-"));
    try {
      const path = renderBrief(
        { kind: "coordinator", laneKey: "lane", space: "collie", event } as any,
        dir,
        { id: "feature", title: "Feature", version: 1, instructions: "实现、review、verify，最后 ready。" },
        "---\nkind: role\n---\n你负责这个 task 的本地编排。",
      );
      const text = readFileSync(path, "utf8");
      expect(text).toContain("## Playbook: Feature (feature@1)");
      expect(text).toContain("实现、review、verify，最后 ready。");
      expect(text).toContain("## Driver");
      expect(text).toContain("你负责这个 task 的本地编排。");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
