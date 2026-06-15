---
"hunkdiff": patch
---

Fix the diff body going blank when scrolling through a large changeset under the Solid renderer. A tall file mounted as off-screen overscan renders its row list empty until scrolled into; growing that list from empty mis-anchored the first rows after the section's bottom spacer (an @opentui/solid `reconcileArrays` quirk), pushing them off-screen so the file showed only its header over blank space until a full remount. The windowed rows now mount inside a dedicated container so they stay in place.
