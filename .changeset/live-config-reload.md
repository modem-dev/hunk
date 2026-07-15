---
"hunkdiff": minor
---

Live-reload the theme and chrome whenever Hunk's config changes — no `--watch` required. The viewer always polls the global (`~/.config/hunk/config.toml`) and repo-local (`.hunk/config.toml`) config files and reloads through the existing reload path on change, the way VS Code / Cursor apply settings on save — so edits to `[custom_theme]`, layout, and other view options take effect without restarting the viewer. In `--watch` mode the same loop additionally tracks the diff input.
