---
"hunkdiff": patch
---

The browser review page now follows three more config options: `tab_width` sets its tab stops (it drew tabs two columns wide before, whatever the config said, and now starts at the terminal's default of 4), `auto_split_min_width` sets where `auto` layout switches between split and unified, and `sidebar` opens or closes the files sidebar when a browser first opens the review. A choice made in the page still wins in that browser. A running daemon from an older Hunk build must be restarted (`hunk daemon restart`) before a review from this build can register with it.
