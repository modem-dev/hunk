---
"hunkdiff": patch
---

Make Hunk's saved state (`state.json`) durable: writes now land atomically through a temp file and rename, and an unreadable state file is preserved as `state.json.corrupt` instead of being silently overwritten, so update notices and extension trust decisions are no longer lost to a torn or damaged write.
