---
"hunkdiff": patch
---

Resolve bundled skills from the closest matching layout instead of the first shape found while walking to the filesystem root. A source install stages its skills under `hunkdiff/` beside the executable, so an unrelated `skills/` directory anywhere above the bin directory no longer shadows the installed skill.
