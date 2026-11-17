// A role template's file (~/.config/herdr-core/templates/<name>.md): its front matter ({ name, description, command })
// and its words, which a Coordinator chat is started with. The same shape herdr-core's templates have:
//   ---
//   name: collie-coordinator
//   command: claude
//   ---
//   # Coordinator
//   ...
// Plain JS, so tests can read a template without herdr.

export function parseTemplate(src) {
  const text = String(src ?? "");
  const head = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return {
    head: head?.[1] ?? "",
    body: (head ? text.slice(head[0].length) : text).trim(),
    command: /^command:[ \t]*(.+)$/m.exec(head?.[1] ?? "")?.[1]?.trim() || null,
    name: /^name:[ \t]*(.+)$/m.exec(head?.[1] ?? "")?.[1]?.trim() || null,
  };
}