import { describe, expect, test } from "bun:test";
import { blankPlaybookText, blankRoleText, configDirectory, definitionFile, definitionId } from "../lib/definition-files.js";

describe("definition files", () => {
  test("makes file names only from safe ids", () => {
    expect(definitionId("reviewer")).toBe(true);
    expect(definitionId("../x")).toBe(false);
    expect(definitionId("Reviewer")).toBe(false);
    expect(() => definitionFile("/home/x", "roles", "../x")).toThrow(/id must/);
    expect(definitionFile("/home/x", "roles", "reviewer")).toBe("/home/x/.config/collie/roles/reviewer.md");
    expect(configDirectory("/home/x/", "playbooks")).toBe("/home/x/.config/collie/playbooks");
  });

  test("new files are complete role/playbook documents", () => {
    expect(blankRoleText("role-1")).toContain('name: "role-1"');
    expect(blankRoleText("role-1")).toContain('description: "role-1"');
    expect(blankRoleText("role-1")).toContain("# role-1");
    expect(blankPlaybookText("book-1")).toContain('name: "book-1"');
    expect(blankPlaybookText("book-1")).toContain("# book-1");
  });
});
