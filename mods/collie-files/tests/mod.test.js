// mods/collie-files' port of herdr's shipped files mod: the manifest, its icons, its paths, and that it
// parses and bundles. No herdr here: the runtime specifiers are external, so these run anywhere.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MOD = join(import.meta.dir, "..");
const SRC = join(MOD, "main.js");
const source = readFileSync(SRC, "utf8");

describe("mods/collie-files: manifest and assets", () => {
  test("is a place: none mod, like herdr's files", () => {
    expect(JSON.parse(readFileSync(join(MOD, "mod.json"), "utf8"))).toEqual({ place: "none" });
  });

  test("ships the four icons main.js draws", () => {
    for (const name of ["chevron-down.svg", "chevron-right.svg", "file.svg", "folder.svg"]) {
      const path = join(MOD, name);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain("<svg");
    }
  });
});

describe("mods/collie-files: the port", () => {
  test("draws its own icons, never the upstream mod's folder", () => {
    expect(source).not.toContain("mods/" + "files/");
    expect(source).toContain("mods/collie-files/chevron-");
    expect(source).toContain("mods/collie-files/${entry.dir ? \"folder\" : \"file\"}.svg");
  });

  test("keeps the features the issue names", () => {
    // Folder tree, lazy load, git letters, read-only preview, back to list, watch, machines.
    for (const feature of ["toggle(", "loadFolder(", "marks", "readonly: true", 'id("files-back")', "watchFolder(", "{ on }"]) {
      expect(source).toContain(feature);
    }
    expect(source).toContain("export default class Files extends View");
  });

  test("imports only the runtime, never shep", () => {
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["gpui-base", "gpui-kit", "herdr"]);
    expect(source).not.toMatch(/shep|mods\/tasks/);
  });

  test("parses and bundles with the runtime specifiers external", () => {
    const check = Bun.spawnSync(["node", "--check", SRC], { stdout: "pipe", stderr: "pipe" });
    expect(check.stderr.toString()).toBe("");
    expect(check.exitCode).toBe(0);
    const out = join(import.meta.dir, "..", ".build-test.js");
    const build = Bun.spawnSync(["bun", "build", SRC, "--external", "gpui-kit", "--external", "gpui-base",
      "--external", "herdr", "--outfile", out], { stdout: "pipe", stderr: "pipe" });
    expect(build.stderr.toString()).toBe("");
    expect(build.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    Bun.spawnSync(["rm", "-f", out]);
  });
});
