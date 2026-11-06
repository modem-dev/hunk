---
"hunkdiff": patch
---

Upgrade `shell-quote` to 1.12.0 and `zod` to 4.6.x. This clears GHSA-pqg4-j6r4-53mv (critical, command injection through `quote()` when a line terminator follows a `{ comment }` token, fixed in 1.11.0) and GHSA-mrhx-c7xc-m3w5 (high, memory exhaustion while validating oversized constrained collections, fixed in 4.6.6). Both advisories reach every `hunkdiff` install through the published dependencies.
