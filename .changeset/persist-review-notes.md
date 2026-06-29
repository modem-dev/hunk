---
"hunkdiff": minor
---

Add an opt-in `--store-notes <path>` flag that persists human review notes to a JSON sidecar (cwd-relative). Notes survive closing the TUI and can be read back off disk by an agent. Omitting the flag keeps notes in-memory only, preserving current behavior.
