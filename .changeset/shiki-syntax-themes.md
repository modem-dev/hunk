---
"hunkdiff": minor
---

Refresh Hunk's built-in theme system, default to `github-dark-default`, and simplify theme selection around one `theme` setting with `View -> Themes…` / `t` opening the selector. Custom themes can inherit from any built-in theme with `custom_theme.base` while keeping explicit syntax color overrides, and removed theme ids such as `graphite` and `paper` remain accepted as compatibility aliases.
