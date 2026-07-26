---
title: Themes
description: Choose a built-in Shiki-backed theme, detect terminal background, or define precise color overrides.
---

Press `t` in Hunk or choose **View → Themes…** to preview and select a theme. Persist it in TOML:

```toml
theme = "github-dark-default"
```

Use `theme = "auto"` to query the terminal background at startup. Hunk chooses `github-light-default` for light terminals, `github-dark-default` for dark terminals, and falls back to dark if the terminal does not answer.

## Create a custom theme

```toml
theme = "custom"

[custom_theme]
base = "catppuccin-mocha"
label = "My Theme"
accent = "#7fd1ff"
panel = "#10161d"
noteBorder = "#c49bff"

[custom_theme.syntax_scopes]
"comment" = "#6e85a7"
"punctuation.definition.comment" = "#6e85a7"
"keyword.operator" = "#7fd1ff"
```

A custom theme inherits from a built-in base, then overlays semantic Hunk colors and exact Shiki/TextMate scopes. Colors must be six-digit hex values.

Quote scope selectors containing dots. Later equal-specificity declarations win, but a more-specific base selector can beat a broad override, so add grammar-specific selectors when needed.

The old `[custom_theme.syntax]` role table is deprecated and temporarily translated. Prefer `syntax_scopes` for new themes.
