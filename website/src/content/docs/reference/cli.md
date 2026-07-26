---
title: CLI reference
description: A curated map of Hunk entry points before the exhaustive generated command reference lands.
---

This page is intentionally an overview, not a second exhaustive command schema. The installed binary is authoritative in this phase:

```bash
hunk --help
hunk <command> --help
```

## Review entry points

| Command                               | Purpose                                                 |
| ------------------------------------- | ------------------------------------------------------- |
| `hunk diff [target] [-- pathspec...]` | Review working-copy changes or compare against a target |
| `hunk diff <left> <right>`            | Compare two concrete files                              |
| `hunk show [target] [-- pathspec...]` | Review the latest commit or a target                    |
| `hunk stash show [ref]`               | Review a Git stash                                      |
| `hunk patch [file]`                   | Review a patch file or stdin                            |
| `hunk pager`                          | Handle Git pager input with diff detection              |
| `hunk difftool <left> <right> [path]` | Review a Git difftool file pair                         |

Common review controls include `--mode`, `--theme`, `--watch`, `--agent-context`, `--pager`, line and wrapping flags, `--tab-width`, agent-note visibility, and terminal background behavior.

## Agent and utility entry points

| Command family                 | Purpose                                |
| ------------------------------ | -------------------------------------- |
| `hunk session <subcommand>`    | Inspect or control a live Hunk session |
| `hunk skill path`              | Print the bundled review skill path    |
| `hunk markup guide` / `render` | Author or preview experimental STML    |
| `hunk daemon serve`            | Run the local session daemon manually  |

Phase 2 will replace this curated page with exhaustive generated command and option metadata derived from the implementation.
