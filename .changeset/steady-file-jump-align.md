---
"hunkdiff": patch
---

Keep file navigation from losing the file it just jumped to. On a loaded machine the scroll that aligns the new file to the top could land after the viewport-follow window closed, so the review stream adopted the file under the cursor again and the next "previous file" press did nothing.
