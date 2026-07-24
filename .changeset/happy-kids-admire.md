---
"hunkdiff": patch
---

Avoid loading OpenTUI's embedded native library for headless commands. Help, version, session polling, daemon serving, markup rendering, and non-interactive pager paths now stay behind a lightweight CLI entrypoint, preventing Bun from leaking a native temp file for commands that never open the review UI.
