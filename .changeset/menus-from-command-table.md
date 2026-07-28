---
"hunkdiff": minor
---

Menus and the controls help dialog now show the keys your commands are actually on. Both are built from the same command table the keyboard dispatches through, so a shortcut remapped in `[keybindings]` is advertised under its new key everywhere instead of only in the config file, and a command you unbind stops claiming a key it no longer answers to.

Extensions get a menu of their own: registered commands are listed in a new **Extensions** menu with their titles and current keys, grouped per extension. A command whose chord was already taken — or that never declared one — is still reachable there with the mouse. The menu appears only when an extension registered a command.

Four actions that were previously menu-only are now named commands, so they can be bound to keys: `hunk.view.toggleCopyDecorations`, `hunk.app.openAgentSkill`, `hunk.review.nextAnnotatedFile`, and `hunk.review.previousAnnotatedFile`.
