---
"hunkdiff": minor
---

Add a TypeScript extension system (phase 1). Hunk now loads user extensions from `~/.config/hunk/extensions/`, repo-local `.hunk/extensions/` (behind a trust prompt), `[extensions] paths` in config, and a repeatable `--extension` flag (`--no-extensions` disables loading). Extensions export a default factory receiving the `hunkdiff/extension` API and can register themes, file-language mappings, and VCS adapters, transform the loaded changeset, subscribe to lifecycle events (`startup`, `changeset_loaded`, `selection_changed`, `session_reload`, `shutdown`), read their own `[extension.<id>]` config table, and show toast notifications. Custom themes are also generalized from the single `[custom_theme]` slot to any number of named `[themes.<id>]` tables. See `docs/extensions.md` for the authoring guide.
