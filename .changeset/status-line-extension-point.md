---
"hunkdiff": minor
---

The bottom status row is now a host-owned status line that Hunk's own file filter, `hunk log`
search, and extensions all drive through one primitive. The file filter and `hunk log` search
are real inline inputs with a cursor, and `hunk log` keeps the retained query visible after a
search. Extension API 26 adds `ctx.statusLine.set()` / `clear()` for persistent status items
(commands, events, and keyboard modes) and `ctx.prompts.line()` for inline, `less`-style
prompts in command handlers.
