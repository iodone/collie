#!/bin/sh
# SessionStart hook (Claude Code's settings.json, Codex's hooks.json): inside Herdr only
# ($HC_TERMINAL_ID), tells the agent the chat's conventions (core/chat-log.js reads them) and, an
# Assistant, its "Your settings" block (collie-task _session-note, which notes on its terminal what
# it was told). Outside Herdr it says nothing.
[ -n "${HC_TERMINAL_ID:-}" ] || exit 0
extra=""
if command -v collie-task >/dev/null 2>&1; then
  extra=$(collie-task _session-note "$HC_TERMINAL_ID" 2>/dev/null)
fi
# The note goes straight out, never through $( ): macOS /bin/sh (bash 3.2) scans a here-doc inside $( )
# for quotes, and an apostrophe in the note breaks it. tr drops the here-doc's own newline.
tr -d '\n' <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Collie chat: a reply to one of your messages starts with <hc reply-to=\"first words of that message\"/>: those words name the message it answers. With nothing to answer (a turn that only looks, or nothing changed), reply only <hc no-reply/> and the chat shows no reply. A mention of a task (e.g. HAT-1) comes with a line <hc task=\"HAT-1\" title=… state=… folder=…>its prompt</hc>: that is the task they mean.
JSON
printf '%s"}}\n' "$extra"