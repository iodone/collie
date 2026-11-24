import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readme = () => readFileSync(new URL("../README.md", import.meta.url), "utf8");
const protocol = () => readFileSync(new URL("../protocol/README.md", import.meta.url), "utf8");

describe("README implementation claims", () => {
  test("keeps the receipt path, dependencies and Ledger objects accurate", () => {
    const text = readme();
    expect(text.includes("Decision + Task")).toBe(true);
    expect(text.includes("todo / running / ready / done")).toBe(true);
    expect(text.includes("Terminal 与 Artifacts")).toBe(true);
    expect(text.includes("Python 3.10+")).toBe(true);
    expect(text.includes("Message、Case、Decision、Receipt")).toBe(true);
    expect(text.includes("source` adapter 仍需写代码")).toBe(true);
    expect(text.includes("`Queued`")).toBe(false);
    expect(text.includes("`Merging`")).toBe(false);
  });

  test("protocol narrative includes the Task state machine and current delivery vocabulary", () => {
    const text = protocol();
    expect(text).toContain("Task");
    expect(text).toContain("todo / running / ready / done");
    expect(text).not.toContain("一个持久状态机");
    expect(text).not.toContain("build/review/merge");
    expect(text).not.toContain("summary/details/proof + 风险");
  });
});
