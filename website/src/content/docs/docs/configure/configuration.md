---
title: Configuration
description: Set personal preferences, override them for a command or project, and save interactive changes.
---

Configure Hunk with TOML. Include only the settings you want to change; Hunk supplies the rest.

## Create your config

Use your user config for personal preferences:

- `$XDG_CONFIG_HOME/hunk/config.toml` if `XDG_CONFIG_HOME` is set.
- Otherwise, `$HOME/.config/hunk/config.toml` (or `%USERPROFILE%/.config/hunk/config.toml` when `HOME` is unavailable).

Create the parent directory and file if they don't exist. Start with:

```toml
theme = "terminal"
mode = "auto"
line_numbers = true
wrap_lines = false
```

`mode = "auto"` uses split layout on wide terminals and unified layout on narrow ones.

For project-specific settings, use `.hunk/config.toml` at the project root. Hunk searches upward from the working directory for the nearest `.hunk` directory or recognized repository root.

See the [config reference](/docs/reference/config/) for every setting and default, or the [theme guide](/docs/configure/themes/) for colors.

## Override settings for a command

Add a command table to the same file. Its settings override that file's shared settings for the matching command; settings you omit are inherited.

```toml
# Shared settings go before any table headers
mode = "auto"

# Repository diffs
[vcs]
mode = "split"
watch = true

# Commit reviews
[show]
mode = "unified"

# Two-file comparisons
[diff]
wrap_lines = true
```

With this config and no repository overrides:

| Run                                    | Result                             |
| -------------------------------------- | ---------------------------------- |
| `hunk diff`                            | Split layout, watch enabled        |
| `hunk show`                            | Unified layout                     |
| `hunk diff --files before.ts after.ts` | Automatic layout, wrapping enabled |
| `hunk show --mode split`               | Split layout; the CLI flag wins    |

**Repository `hunk diff` uses `[vcs]`, not `[diff]`.** `[diff]` only applies to two-file comparisons. The [command table reference](/docs/reference/config/#command-tables) lists all supported tables, including `[open]`, `[patch]`, `[stash-show]`, and `[difftool]`.

Tables change preferences, not command implementations or keyboard shortcuts. Keep shared settings above all tables: a key written below `[show]` belongs to `[show]`, not to the whole file.

## Which setting wins?

Hunk applies these layers in order, with later values winning:

1. Built-in defaults.
2. User config: shared settings, then the matching command table, then applicable `[pager]` settings.
3. Repository config: the same sequence.
4. Explicit CLI flags.

A repository's shared setting can therefore override a user command-specific setting:

```toml
# User config
[show]
mode = "unified"
```

```toml
# Repository .hunk/config.toml
mode = "split"
```

Here, `hunk show` uses split. Run `hunk show --mode unified` to override it once. Boolean flags work too: `hunk diff --no-wrap` overrides `wrap_lines = true`.

Some settings are user-only, such as keyboard bindings and `wheel_scroll_lines`. See [resolution and scope](/docs/reference/config/#resolution-and-scope) for restrictions.

## Set pager preferences

For diff reviews opened through `hunk pager` or with `--pager`, add:

```toml
[pager]
mode = "unified"
wrap_lines = true
```

Try it without changing your Git configuration:

```bash
git -c core.pager="hunk pager" diff
```

`hunk pager` reviews resolve like `hunk patch` reviews: Hunk applies the `[patch]` table, then `[pager]` on top of it, within each config file. `[pager]` doesn't apply to ordinary interactive reviews. Pager reviews start with the files pane closed and, unless a config layer sets `menu_bar`, the menu bar hidden; non-diff input uses a separate plain-text pager.

See [Git pager and difftool](/docs/workflows/git-pager-and-difftool/) for permanent setup and fallback behavior.

## Change keyboard shortcuts

Use `[keybindings]` in your **user config**, not repository config:

```toml
[keybindings]
"hunk.review.nextHunk" = ["]", "ctrl+n"]
"hunk.app.quit" = "ctrl+x"
```

These replace the command's default keys. See [Keybindings](/docs/configure/keybindings/) for command ids, unbinding, and conflicts.

## Save interactive changes

When you change view preferences and quit, Hunk can offer to persist them. It writes to an existing repository config when one exists; otherwise it keeps personal view choices in the user config. Set `prompt_save_view_preferences = false` to disable that prompt.

## Themes and extensions

Theme definitions and extension settings belong in root tables, not inside command tables:

- [Themes](/docs/configure/themes/): select built-in themes or define your own colors.
- [Extensions](/docs/extend/extensions/): load extensions and configure `[extension.<id>]` settings.
- [Troubleshooting](/docs/reference/config/#troubleshooting): check table names, precedence, and TOML placement when a setting has no effect.
