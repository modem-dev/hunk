---
title: Config reference
description: Curated config scopes and key families before the generated exhaustive reference lands.
---

Hunk's runtime parser in `src/core/config.ts` is authoritative. This page groups the supported behavior without duplicating every accepted field by hand.

## Resolution order

From lowest to highest precedence:

1. built-in defaults
2. user TOML: top-level keys, then the matching command section, then `[pager]` for pager-style input
3. repository `.hunk/config.toml`: top-level keys, then the matching command section, then `[pager]`
4. explicit CLI options

## Key families

| Family | Representative keys                                                           |
| ------ | ----------------------------------------------------------------------------- |
| Input  | `vcs`, `watch`, `exclude_untracked`                                           |
| Layout | `mode`, `line_numbers`, `tab_width`, `wrap_lines`, `hunk_headers`             |
| Chrome | `menu_bar`, `agent_notes`, `copy_decorations`, `prompt_save_view_preferences` |
| Color  | `theme`, `transparent_background`, `color_moved`, `custom_theme`              |

`mode` accepts `auto`, `split`, or `stack`; `vcs` accepts `git`, `jj`, or `sl`; `tab_width` accepts integers from 1 through 16. Most display keys are booleans.

`transparentBackground` remains accepted as an alias for `transparent_background`. Older theme IDs and the deprecated custom syntax role table are compatibility paths, not preferred new configuration.

Run the current binary and consult [Configuration](/docs/configure/configuration/) for layering examples. Phase 2 will generate exact keys, defaults, value constraints, aliases, and deprecations from authoritative implementation data.
