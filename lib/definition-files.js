// User-level role/playbook files under ~/.config/collie. Settings edits each file as a whole:
// the YAML frontmatter and the prompt body live in one text area, exactly as stored on disk.
export const definitionId = (value) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(value ?? ""));

export const configDirectory = (home, kind) => `${String(home ?? "").replace(/\/+$/, "")}/.config/collie/${kind}`;

export function definitionFile(home, kind, id) {
  if (!definitionId(id)) throw new Error("id must be lowercase letters, numbers, '-' or '_'");
  return `${configDirectory(home, kind)}/${id}.md`;
}

export const blankRoleText = (id) => `---
name: "${id}"
description: "${id}"
version: 1
---

# ${id}
`;

export const blankPlaybookText = (id) => `---
name: "${id}"
description: "${id}"
version: 1
verify: false
---

# ${id}
`;
