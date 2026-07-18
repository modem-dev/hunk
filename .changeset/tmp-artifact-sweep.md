---
"hunkdiff": patch
---

Sweep stale Bun-extracted native libraries from the OS temp directory at startup. Bun single-file executables currently leak one extracted native library per launch (oven-sh/bun#30962), which can fill a tmpfs under high-frequency invocation. Hunk now removes its own stale leaked copies (same user, older than one hour, at most one scan per hour) until the upstream Bun fix ships. Set `HUNK_DISABLE_TMP_SWEEP=1` to opt out.
