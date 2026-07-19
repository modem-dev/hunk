---
"hunkdiff": patch
---

Stop leaking one extracted native library per launch from compiled binaries. Bun single-file executables extract their embedded OpenTUI library to the OS temp directory under a fresh random name on every run and never remove it (oven-sh/bun#30962, #556), which could fill a tmpfs under repeated invocation (git pager loops, agent polling). The compiled binary now writes the embedded library once to a stable content-addressed path under the user cache directory (`~/.cache/hunk/native` on Linux, `~/Library/Caches/hunk/native` on macOS, `%LOCALAPPDATA%\hunk\native` on Windows) and reuses it across runs. If the cache is unavailable, hunk falls back to the previous behavior rather than failing to start.
