---
"hunkdiff": patch
---

Record repo-extension trust decisions under a canonical repo root, so granting trust actually loads that repository's extensions when Hunk was launched through a symlinked path (or a Windows 8.3 short path). Previously the reload that follows the grant canonicalized its working directory and looked the decision up under a different spelling of the same directory, leaving the extensions skipped and the prompt ready to ask again. Decisions recorded by earlier versions are still honored.
