---
"hunkdiff": minor
---

Add an `auto_width_threshold` config setting for the terminal width at which `auto` mode switches from unified to split diffs, and raise its default from 120 to 200 columns so each side of a split diff gets roughly 100 columns instead of 60.
