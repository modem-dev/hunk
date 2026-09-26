---
"hunkdiff": patch
---

Fix `hunk patch` (and other review flows) under the Nix flake package by installing the `hunkdiff` alias next to `hunk`, mirroring the npm package's dual binaries. Without it the review flow fails with "unable to execute '…/bin/hunkdiff'".
