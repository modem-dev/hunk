---
---

Add unit coverage for the VCS adapter layer: registry error paths, Git numstat parsing, large-file skip heuristics, diff-endpoint source-spec mapping, stat signatures, and Git watch signatures, plus binary-free detection and unsupported-operation branches for the Jujutsu and Sapling adapters. Several pure Git helpers are now exported for direct testing. Test-only; no user-visible change.
