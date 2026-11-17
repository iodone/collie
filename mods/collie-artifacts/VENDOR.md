# Vendored: collie-artifacts

Source: Shepherdr's `artifacts` mod, <https://github.com/eliasstravik/shepherdr>, path `mods/artifacts/`,
commit `7d183cf76986b679be79561993c5cb32778e824e` (SHEP-133).

License: MIT, Copyright (c) 2026 Elias Stravik (see `LICENSE`).

## Files

| here | upstream |
|---|---|
| `bin/collie-artifact` | `bin/herdr-artifact` (Python source, no binary) |
| `ARTIFACTS.md` | `ARTIFACTS.md` |
| `markup.js` | `markup.js` |
| `recipe-view.js` | `recipe-view.js` |
| `core/recipe.js` | `core/recipe.js` |
| `main.js` | `mods/task-artifacts/main.js` (the ticket's list), with the viewer's toolbar mode added |
| `bar.js` | `mods/chat-image/artifact-bar.js` (the viewer's toolbar; the sidebar button removed) |
| `mod.json` | `{ "place": "none" }`, as both upstream mods |
| `artifacts.svg`, `check.svg`, `markup.svg`, `send.svg` | same |
| `chevron-left.svg`, `chevron-right.svg`, `x.svg` | `mods/chat-image/` same |

`lib/artview.js`, `lib/ui.js` and `core/task-artifacts.js` are not vendored copies: they are
generated from the checkout's `lib/` and `core/` by `bin/collie-sync` (see `lib/COPIES`). Not
ported: the Artifacts sidebar (`sidebar.js`, `addons.js`, `usage.js`) and the chat-image mod's
image viewer; collie has no artifacts sidebar.

## Local changes (Slice 1)

- CLI renamed to `collie-artifact`; relative paths to `../ARTIFACTS.md`, `../markup.js`,
  `../recipe-view.js` and `../core/recipe.js` are unchanged.
- Store: `$COLLIE_ARTIFACTS_HOME`, else `~/.local/share/collie/artifacts`. Shepherdr's
  `~/.local/share/shepherdr/artifacts` and `~/.herdr/artifacts` are read-only fallbacks; writes always
  land in the collie store. Version lookup and `find_anywhere` read all stores.
- `markup.js`: notes/screenshots and the CLI path point at the collie mod and store.
- `sync-hold`: the shepherdr installer hold is a no-op; `~/.herdr/sync-hold` is never read or written.
- `open`/`link`: keep Shepherdr's web app when one is linked, but a missing link is a message, not a
  failure. `open` exits 0 when the artifact exists.
- New `export <id> [--version] [--out DIR]`: copies a version's files to `DIR/<id>-v<n>`, prints
  `{path}` with `--json`, and never changes the store. `pack` stays internal.
- Remote installs target `~/.local/bin/collie-artifact` (never Shepherdr's `herdr-artifact`).
- `tests/artifact-cli.test.sh`: temp-HOME CLI test, no Shepherdr mod required.
