---
title: Configuration
description: Layer user and repository TOML settings, then override them per command or from the CLI.
---

Hunk reads TOML preferences from a user file and an optional repository file:

- `~/.config/hunk/config.toml` (or the platform/XDG config location)
- `.hunk/config.toml` at the repository root

Repository settings override user settings. Command sections then override their layer's top-level values, pager sections apply to pager-style sessions, and explicit CLI flags win last.

## Start with useful defaults

```toml
theme = "github-dark-default"
mode = "auto"
vcs = "git"
watch = false
exclude_untracked = false
line_numbers = true
tab_width = 4
wrap_lines = false
hunk_headers = true
menu_bar = true
agent_notes = false
transparent_background = false
```

Use only the keys you want to change; built-in defaults fill the rest.

## Scope a command

```toml
mode = "auto"

[diff]
watch = true

[pager]
menu_bar = false
wrap_lines = true
```

A command-specific section such as `[diff]`, `[show]`, or `[patch]` changes only that input mode. `[pager]` applies when the invocation uses pager-style behavior.

## Save interactive changes

When you change view preferences and quit, Hunk can offer to persist them. It writes to an existing repository config when one exists; otherwise it keeps personal view choices in the user config. Set `prompt_save_view_preferences = false` to disable that prompt.

The [config reference](/docs/reference/config/) is curated in this phase; exhaustive generated key metadata arrives in the generated reference phase.
