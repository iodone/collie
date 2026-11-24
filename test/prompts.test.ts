import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const prompt = (name: string) => readFileSync(new URL(`../templates/${name}.md`, import.meta.url), "utf8");

describe("role prompts", () => {
  test("Coordinator prompt leaves command details to the injected CLI skill", () => {
    const text = prompt("coordinator");
    expect(text).toContain("Collie CLI skill");
    expect(text).not.toContain("collie ticket create");
    expect(text).not.toContain("collie decision commit");
    expect(text).not.toContain("collie-task");
  });

  test("the CLI skill is the single command contract", () => {
    const text = readFileSync(new URL("../skills/cli/SKILL.md", import.meta.url), "utf8");
    expect(text).toContain("name: collie-cli");
    expect(text).toContain("collie roles list");
    expect(text).toContain("collie ticket create");
    expect(text).toContain("collie decision commit");
    expect(text).toContain("collie task ready");
    expect(text).not.toContain("/ticket");
    expect(text).not.toContain("/decision");
    expect(text).not.toContain("/v1/ingress");
  });

  test("Driver refers to task commands through the public interface", () => {
    const text = prompt("driver");
    expect(text).not.toContain("collie-task");
  });
});
