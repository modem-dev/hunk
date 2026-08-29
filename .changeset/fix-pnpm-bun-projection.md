---
"hunkdiff": patch
---

Stop installing Bun beside prebuilt Hunk packages so pnpm global updates cannot corrupt Bun's shared platform-package projection. Standalone platform binaries continue to work without a separate Bun installation.
