// The pure preview helpers: no herdr, no gpui, no window.
import { describe, expect, test } from "bun:test";
import { clipText, initialMode, isMarkdown, previewText } from "../preview.js";

describe("mods/collie-files: markdown detection", () => {
  test("accepts the three previewable extensions, case-insensitively", () => {
    for (const path of ["README.md", "notes.MARKDOWN", "page.mdx", "docs/guide.md", ".md"]) {
      expect(isMarkdown(path)).toBe(true);
    }
  });

  test("rejects other files, suffixes and non-strings", () => {
    for (const path of ["main.js", "md", "readme.md.txt", "docs.md/file", "", null, undefined, 42]) {
      expect(isMarkdown(path)).toBe(false);
    }
  });

  test("opens Markdown formatted and everything else as code", () => {
    expect(initialMode("README.md")).toBe("preview");
    expect(initialMode("page.mdx")).toBe("preview");
    expect(initialMode("main.js")).toBe("code");
    expect(initialMode(null)).toBe("code");
  });
});

describe("mods/collie-files: preview text", () => {
  test("leaves ordinary Markdown alone", () => {
    expect(previewText("# Title\n\nBody")).toBe("# Title\n\nBody");
  });

  test("shows front matter as a YAML block", () => {
    expect(previewText("---\ntitle: x\ncount: 1\n---\n\n# H"))
      .toBe("```yaml\ntitle: x\ncount: 1\n```\n\n# H");
  });

  test("handles CRLF front matter", () => {
    const out = previewText("---\r\ntitle: x\r\n---\r\n\r\n# H");
    expect(out).toContain("```yaml\ntitle: x\n```");
    expect(out.endsWith("# H")).toBe(true);
  });

  test("does not treat an unclosed or later --- as front matter", () => {
    expect(previewText("---\ntitle: x")).toBe("---\ntitle: x");
    expect(previewText("# H\n\n---\nnot front matter")).toBe("# H\n\n---\nnot front matter");
  });

  test("clips at the limit and says so", () => {
    expect(clipText("abcd", 3)).toBe("abc\n… (file truncated)");
    expect(clipText("abc", 3)).toBe("abc");
    expect(previewText("# heading", 4).endsWith("\n… (file truncated)")).toBe(true);
    expect(previewText("---\na: 1\n---\n\nbody", 10).endsWith("\n… (file truncated)")).toBe(true);
  });
});
