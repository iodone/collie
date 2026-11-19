// The pure half of the Files panel's preview: which files are Markdown, which view opens first,
// the read cap, and front matter. No herdr or gpui imports, so the tests run anywhere.
const MARKDOWN = /\.(md|markdown|mdx)$/i;

export const MAX_TEXT = 400000;

export const isMarkdown = (path) => typeof path === "string" && MARKDOWN.test(path);

// Markdown opens formatted; every other text file opens as code.
export const initialMode = (path) => (isMarkdown(path) ? "preview" : "code");

export function clipText(text, limit = MAX_TEXT) {
  return text.length > limit ? text.slice(0, limit) + "\n… (file truncated)" : text;
}

// Front matter is data, not a rule and a paragraph: show it as a YAML block.
export function previewText(text, limit = MAX_TEXT) {
  const m = /^-{3}\r?\n([\s\S]*?)\r?\n-{3}[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return clipText(text, limit);
  return clipText("```yaml\n" + m[1] + "\n```\n" + text.slice(m[0].length), limit);
}
