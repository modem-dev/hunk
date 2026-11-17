---
"hunkdiff": patch
---

A `[keybindings]` entry for one of the browser review page's own commands (`hunk.web.*`, such as `"hunk.web.toggleViewed" = "x"`) now reaches the page: its hints, command palette, and help overlay show the new key, the new key runs the command, and the default it replaced no longer does. Page commands that ship without a key, such as `hunk.web.toggleHideViewed`, can be given one the same way. The terminal accepts these entries without reporting an unknown command and binds nothing for them. The page's Ctrl/Cmd+K and Ctrl/Cmd+P shortcuts stay fixed, and an entry for either is reported as not remappable.
