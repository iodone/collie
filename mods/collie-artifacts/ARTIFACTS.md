# Artifacts: show the person something

An artifact is a recipe you write: a `recipe.json` (blocks of headings, text, tables, charts,
pictures, forms) and its pictures beside it, in one folder. Herdr draws it natively twice from
that one file: in the window, and in the web app on the person's phone. The person finds it in
the Artifacts tab of the right sidebar and in your chat.

```sh
collie-artifact new ./my-report          # writes a starting recipe.json
collie-artifact publish ./my-report --title "Coverage by package"     # prints its id
collie-artifact update <id> ./my-report --note "adds the API package" # a new version, same artifact
collie-artifact list                     # this folder's artifacts
collie-artifact rm <id>
collie-artifact open <id>                # show it to the person where they are, and print its link
collie-artifact link <id>                # only its link in the web app
collie-artifact export <id> --out ./dir  # copy its files out as ./dir/<id>-v<n>
```

- **Store**: artifacts live in `$COLLIE_ARTIFACTS_HOME` (default `~/.local/share/collie/artifacts`):
  `<slug>.json` per folder and `files/<id>/v<n>/` per version. The old Shepherdr stores
  (`~/.local/share/shepherdr/artifacts`, `~/.herdr/artifacts`) are read as a fallback; every write,
  and `export`'s source, comes from the collie store first. Removing an artifact that is only in a
  legacy store is refused (update it once to copy it over).
- **Download**: `export` copies a version's files to `DIR/<id>-v<n>` and prints the path (or
  `{"path": ...}` with `--json`); it never changes the store. `pack` (tar on stdout) stays internal.
- **Web link**: `open`/`link` use Shepherdr's web app when this machine is linked to one. Collie has
  no web app of its own yet, so with none they print a note and succeed: `export` is the local
  way to get the files.

- Change an artifact with `update` (a new version, the same card), not a second `publish`. The
  last 20 versions are kept; the person can step back through them. An open copy reloads by
  itself.
- It belongs to the folder you run in (the repo root), like tasks; `--folder` picks another.
  A task's agent gets its task in front of the title ("HAT-2: Coverage by package").
- Publish checks it first (every block, every picture there); a broken one is refused with why.
- Don't open it on the person's screen unasked; tell them it's there. Asked to show it: `open`, and give
  them the link it prints.

## The recipe

```json
{
  "recipe": 1,
  "blocks": [
    { "type": "text", "md": "**92%** of lines are covered, up from 81%." },
    { "type": "stats", "items": [{ "label": "Lines", "value": "92%", "note": "+11" }, { "label": "Files", "value": "148" }] },
    { "type": "table", "columns": ["Package", { "label": "Coverage", "align": "right" }], "rows": [["api", "88%"], ["web", "95%"]] },
    { "type": "image", "src": "after.png", "caption": "The new chart, in the window at 1440 px" },
    { "type": "choice", "question": "Ship it?", "options": [{ "label": "Ship", "description": "merge today" }, { "label": "Wait" }] }
  ]
}
```

Blocks, top to bottom (each may carry an `"id"`; the person's notes point at blocks):

| type | fields |
|---|---|
| `heading` | `text`, `level` 1-3 |
| `text` | `md` (Markdown: bold, links, `code`, lists) |
| `list` | `items` (Markdown each), `ordered` |
| `table` | `columns` (labels, or `{ label, align }`), `rows` (lists of cells) |
| `chart` | `kind` bar, line or pie, `labels`, `series` [{ `name`, `values` (numbers) }] |
| `stats` | `items` [{ `label`, `value`, `note` }]: a row of big numbers |
| `image` | `src` (a picture beside recipe.json), `caption`, `w`, `h` |
| `pair` | `before` and `after`, each { `src`, `caption` }: side by side, stacked on a phone |
| `code` | `text`, `lang`: command output, a diff, a log |
| `callout` | `tone` info, good, warn or bad, `title`, `md` |
| `columns` | `columns`: lists of blocks, side by side (stacked on a phone) |
| `tabs` | `tabs` [{ `label`, `blocks` }] |
| `details` | `summary`, `blocks`: folded until opened |
| `divider` | nothing |
| `choice` | `question`, `options` [{ `label`, `description` }]: the person picks one |
| `form` | `fields` [{ `name`, `label`, `kind` text, textarea, select or checkbox, `options` }], `submit` |
| `button` | `label`, `reply`: a press sends `reply` |

- **Pictures**: PNG, JPEG, GIF, WebP or SVG files in the folder, named in `src` (no paths up or
  out). Screenshots go in as they are; crop them to what matters first (`magick`).
- **Forms and answers**: a `choice`, a `form` or a `button` sends the person's words to you as
  `<hc from="artifact" id=… version=… title=…>Ship it?: Ship</hc>`, in the window and on the web
  alike.
- **Update**: change recipe.json (and pictures), then `collie-artifact update <id> <dir> --note
  "what changed"`. Each version is kept with its note.
- **Mark up**: the person can point at a block (or a spot) and write what should change. It
  reaches you as `<hc from="artifact" id=… version=… title=… on="the table “Coverage”">note</hc>`,
  sometimes with a path to a picture of it. Change it and `update`.
- Don't repeat the title inside it: the viewer shows it right above. Start with the content (a
  one-line summary, the numbers, the picture). No emojis. Data goes in the recipe; it isn't read
  live.
- Only `.json` and pictures (plus `.txt`, `.md`, `.csv`), at most 4 MB.

## A task's proof

A proof is a recipe, always (the person accepts tasks from their phone too): titled "<the task's
full title> · Proof"; a `text` block saying what changed in one to three plain lines; then each
proof as an `image`, `pair` or `code` block with a one-line `caption` (or a `text` line above it);
then a `heading` "Not proven" and a `list`. `collie-artifact publish` refuses a proof that isn't a
recipe.

## A custom panel, only when a recipe truly can't

A recipe covers reports, boards, proofs, plans, forms and choices. Only something that must run
code while the person looks (a game, a live terminal view, a drawing tool) is a custom panel: a
Herdr mod (`main.js` in GPUI) that only the window can run. The web app shows just a picture of
it, taken when the window last showed it, and "open it in the Herdr window". So:

```sh
collie-artifact new ./my-tool --custom   # a starting main.js
collie-artifact publish ./my-tool --title "Tic-tac-toe" --custom      # --custom on every publish and update
```

Read `~/.config/herdr-app/AGENTS.md` (Mods, UI, the `herdr` module) and the type files
`gpui-kit.d.ts` and `herdr.d.ts` there. `./artifact.js` is written for you (`id`, `version`,
`asset(name)`, `reply(text)`, from a click only). Colors from `theme()` only, text 12-15 px, fill
the panel (`size_full()`), scroll long content, work from 320 px wide, no timers
(`cx.timer.every` rarely), never keep a `cx`. Publish checks it with `herdr-app check` in light
and dark and at 320 px, and lists what to fix.
