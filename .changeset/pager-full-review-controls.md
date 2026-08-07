---
"hunkdiff": minor
---

Give pager mode the full review controls, so `git diff | hunk pager` supports everything `hunk diff` does: file and hunk navigation, file filter, layout switching, etc. Pager mode now only decides where the chrome starts — the menu bar and sidebar begin hidden, and `M` and `s` bring them back.
