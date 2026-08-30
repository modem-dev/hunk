---
"hunkdiff": minor
---

Support `hunk diff <from> <to>` as a two-revision review across Git, Jujutsu, and Sapling. Two-revision reviews use backend-native comparison syntax, keep source expansion pinned to both revisions, and exclude working-copy untracked files. Concrete file comparisons now use the explicit `hunk diff --files <left> <right>` form; two positional arguments always mean revisions.
