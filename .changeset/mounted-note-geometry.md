---
"hunkdiff": patch
---

Fix a transient bottom-edge scroll clamp: mounted diff sections now always render their agent-note rows, so the review stream's painted height matches its measured layout height and over-scrolling at the bottom can no longer snap short by the height of an offscreen note.
