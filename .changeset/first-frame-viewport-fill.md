---
"hunkdiff": patch
---

Fill the bottom of the first review frame under Solid. The scrollbox viewport height is computed during the first layout pass, which could land after the diff pane began listening for layout changes, so the initial frame planned against a zero height and left the bottom rows blank until the first scroll. The pane now seeds the real height as soon as it is available, so the start of the next file section renders on the first frame without any input.
