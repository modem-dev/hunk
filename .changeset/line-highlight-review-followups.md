---
"hunkdiff": patch
---

Fix extension line highlights: marks now paint per file as they resolve instead of waiting for every file, never paint a previous review's offsets onto a reloaded file, stay visible on transparent line backgrounds, keep every active file's result retained however large the review is, and paint a row carrying thousands of ranges in milliseconds instead of seconds. Marks still resolve their tint against an assumed background on transparent cells, and a range covering only zero-width characters paints nothing.
