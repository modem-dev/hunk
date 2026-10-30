---
title: Hunk review skill
description: Install the versioned skill that teaches coding agents Hunk's live review commands.
---

Every Hunk installation bundles a `hunk-review` skill. It teaches agents how to find a live session, inspect the review efficiently, navigate, reload, and leave notes, and it tells them not to launch the interactive TUI themselves.

## Install it

Install the skill with the `skills` CLI:

```bash
npx skills add modem-dev/hunk -g --skill hunk-review
```

`-g` installs the skill for your user instead of one project. Add `-a <agent>` (for example `-a claude-code`) to install it for a single agent.

The installed file is a pointer: it tells the agent to run `hunk skill show hunk-review` and follow the output. Hunk versions before 0.24 lack `hunk skill show`, so the pointer falls back to reading the file printed by `hunk skill path hunk-review`. The instructions therefore come from the Hunk binary on your `PATH` and stay in step with it after every upgrade; you don't need to reinstall the skill.

## Load it without the skills CLI

| Agent setup                             | Command                                               |
| --------------------------------------- | ----------------------------------------------------- |
| Loads instructions on demand            | `hunk skill show` prints the skill to stdout.         |
| Loads or symlinks skill files from disk | `hunk skill path` prints the bundled file's path.     |
| Can only fetch URLs                     | Use the [published copy](/docs/hunk-review-skill.md). |

The published copy tracks the newest Hunk release, so prefer `hunk skill show` when your installed Hunk might be older.

## Other bundled skills

`hunk-extensions` teaches agents to build [extensions](/docs/extend/extensions/) against the `hunkdiff/extension` API:

```bash
npx skills add modem-dev/hunk -g --skill hunk-extensions
hunk skill show hunk-extensions
```

For the human side of the workflow, start with [Review with an agent](/docs/agents/review-with-an-agent/).
