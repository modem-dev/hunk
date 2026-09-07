---
"hunkdiff": minor
---

Accept a `[theme]` table that names one theme per terminal background, so `dark` and `light` terminals each get a theme you chose instead of only Hunk's GitHub defaults. `fallback` covers terminals that never report a background.

Saving view preferences from the app now rewrites only the keys you changed, keeps the comments around them, writes a key back into the `[pager]` or command table that defined it, and refuses to touch `config.toml` at all if the result would not read back as the same file with just those keys changed.
