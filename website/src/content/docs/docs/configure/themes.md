---
title: Themes
description: Choose a built-in Shiki-backed theme, detect terminal background, or define precise color overrides.
---

Press `t` in Hunk or choose **View → Themes…** to preview and select a theme. Persist it in TOML:

```toml
theme = "github-dark-default"
```

Use `theme = "auto"` to query the terminal background at startup. Hunk chooses `github-light-default` for light terminals, `github-dark-default` for dark terminals, and falls back to dark if the terminal does not answer.

## Follow the terminal between two themes you chose

Write `theme` as a table to name the theme for each background yourself:

```toml
[theme]
dark = "catppuccin-mocha"
light = "catppuccin-latte"
fallback = "github-dark-default"
```

`dark` and `light` are required. Hunk queries the terminal background the way `auto` does, then draws the matching side. The optional `fallback` covers sessions where Hunk never gets an answer: terminals that ignore the query, and captured pager hosts such as LazyGit, where Hunk never asks. Without it those sessions use `dark`. Both sides accept built-in ids, custom theme ids, and the compatibility aliases.

A `--theme <id>` flag overrides the table for one run. Picking a theme in the app replaces the pair with that single id, and the save-on-quit prompt shows the change before writing it.

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

## Name several themes

`[custom_theme]` is the single theme named `custom`. To keep more than one of your own themes around, declare `[themes.<id>]` tables instead and select one by id:

```toml
theme = "midnight-ink"

[themes.midnight-ink]
base = "catppuccin-mocha"
label = "Midnight Ink"
accent = "#7fd1ff"

[themes.paper-trail]
base = "github-light-default"
label = "Paper Trail"
```

Every `[themes.<id>]` table accepts exactly the keys `[custom_theme]` accepts, and each theme appears in the theme picker. Ids are lowercase words separated by `-` or `_`; ids already taken by a built-in theme, by `auto`, or by `[custom_theme]` are skipped with a startup notice. A repository config can refine a user theme with the same id field by field.

See the [config reference](/docs/reference/config/#named-themes) for the full rules.
