---
"hunkdiff": patch
---

Improved diff alignment when a change block adds and removes different numbers of lines: the changed line now pairs with the line it actually resembles instead of whichever line happened to sit in the same position, so split view lines up correctly and the word-level highlight marks just the edited part instead of most of an unrelated line.
