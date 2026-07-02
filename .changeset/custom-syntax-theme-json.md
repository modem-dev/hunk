---
"hunkdiff": minor
---

Add `custom_theme.syntax_theme` to load a full VS Code / Shiki theme JSON for source-accurate syntax highlighting. The referenced theme is registered with the highlighter and drives code coloring, so any VS Code theme renders exactly as it would in the editor instead of being approximated by the nine `[custom_theme.syntax]` tokens.
