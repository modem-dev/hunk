# Themes

Hunk follows your terminal's own colors by default. You can instead choose a
built-in theme, let Hunk select one from your terminal background, or create a
custom theme in `~/.config/hunk/config.toml` or `.hunk/config.toml`.

```toml
theme = "github-dark-default"
```

You can also change themes while reviewing: press `t` or choose
`View -> Themes…`.

## Terminal theme

`theme = "terminal"` is the default. At startup Hunk asks the terminal for its
foreground, background, and 16-color ANSI palette, then draws diffs, chrome,
and syntax highlighting from those colors: green for additions and strings, red
for removals, blue for functions and accents, magenta for keywords, and so on.
Hunk therefore matches whatever color scheme your terminal already uses.

Hunk keeps following the terminal while it runs. When the terminal reports a
color-scheme change (mode 2031, sent by Ghostty, kitty, herdr, and others) or
Hunk receives `SIGWINCH` (what tmux-aware theme tools send after rewriting a
pane's colors), Hunk probes the palette again and repaints if it changed.

Terminals that do not answer palette queries get a standard xterm-style palette
for their light or dark background.

## Automatic theme selection

`theme = "auto"` and `--theme auto` query the terminal background at startup.
Hunk chooses `github-light-default` for light backgrounds and
`github-dark-default` for dark backgrounds, falling back to
`github-dark-default` when the terminal does not answer.

Older theme ids such as `graphite` and `paper` remain accepted as compatibility
aliases.

## Custom themes

Custom themes inherit from a built-in theme and only need to override the
colors you care about:

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
"entity.name.function" = "#8ed4ff"
```

Define as many themes as you like by giving each one its own
`[themes.<id>]` table, using the same keys. The table id is the name you select
with `theme = "<id>"` or `--theme <id>`:

```toml
theme = "ocean"

[themes.ocean]
base = "nord"
label = "Ocean"
accent = "#7fd1ff"

[themes.ocean.syntax_scopes]
"keyword.operator" = "#7fd1ff"

[themes.paper-review]
base = "github-light-default"
accent = "#0969da"
```

Theme ids must be lowercase words separated by `-` or `_`, and cannot reuse a
built-in theme id. Hunk skips invalid ids with a startup notice instead of
failing the session. `[custom_theme]` is the theme with id `custom`, so it
takes precedence over a `[themes.custom]` table.

Custom themes appear in the selector after the built-in themes, in the order
you declare them. A repo `.hunk/config.toml` overrides a user config table by
table for the same id.

## Syntax scopes

`syntax_scopes` uses [Shiki/TextMate scope selectors](https://shiki.style/guide/themes#token-colors)
directly, so matching and precedence follow Shiki's theme rules without a
Hunk-specific translation layer. Quote selectors containing dots. Declaration
order is preserved: later rules win when matching selectors have equal
specificity, while a more-specific base-theme selector beats a broader override.
Add the grammar-specific selector when that happens. All custom theme colors
must use `#rrggbb` hex values.

## Migrating the legacy syntax table

The former `[custom_theme.syntax]` role table is deprecated but temporarily
translated into approximate scopes for compatibility. Both tables can coexist
while migrating, and an exact `syntax_scopes` entry overrides a translated entry
with the same selector.

Because semantic roles have no one-to-one TextMate mapping, migrate when
practical. For example, replace `comment = "#ffffff"` with both
`"comment" = "#ffffff"` and `"punctuation.definition.comment" = "#ffffff"`
under `[custom_theme.syntax_scopes]`, adding language-specific selectors when a
grammar uses more specific scopes. The compatibility table will be removed in
the next major release.
