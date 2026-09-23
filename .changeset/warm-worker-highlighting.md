---
"hunkdiff": minor
---

Syntax highlighting now runs in the worker by default, and the worker starts compiling the review's grammars during startup, so the first key after the review appears is no longer blocked by highlighting. `--fast` is accepted as a no-op and will be removed in a later release; Windows compiled binaries and custom themes with `syntax_scopes` keep highlighting inline.
