---
---

Add unit coverage for the CLI argument parser: per-command and per-session-subcommand help text, layout/positive-integer validation, unknown-command and unsupported-subcommand errors, session selector and reload-target validation, and the full `session comment apply` stdin-payload validation surface. Lifts `src/core/cli.ts` line coverage from 82% to ~99%. Test-only; no user-visible change.
