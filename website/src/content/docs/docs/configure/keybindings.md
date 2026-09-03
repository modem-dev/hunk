---
title: Keybindings
description: Remap Hunk's named commands to your own keys with the user-config keybindings table.
---

Every keyboard shortcut is a named command. A `[keybindings]` table in your user config maps command ids to the chords you want them on:

```toml
[keybindings]
"hunk.app.quit" = "ctrl+x"               # one chord
"hunk.review.nextHunk" = ["]", "ctrl+n"] # several chords for one command
"hunk.review.focusFilter" = "f"          # takes "f" away from page-down
"hunk.view.toggleMenuBar" = false        # unbind it entirely
"myext.toggle" = "ctrl+g"                # extension commands too
```

Every id starts with the name of whoever owns the command: Hunk's own commands live under `hunk.`, and an extension's live under its extension id. `hunk` is a reserved extension id, so an extension can never shadow a built-in command.

## Rules

- **User bindings replace defaults.** The chords you list are the complete set of keys that command answers to.
- **A key you bind is yours.** Any command holding the same chord only as a default gives it up and keeps its other keys.
- **`false` (or `[]`) unbinds a command**, leaving its keys doing nothing.
- Two entries claiming one chord is a conflict: the first in the file wins and the session reports the other. Unknown ids and unusable chords are reported the same way, and the rest of the table still applies.

## Chord grammar

Chords join `ctrl`, `alt`/`option`, `cmd`/`meta`, and `shift` with `+` around a base key: a character (`"y"`, `"["`), an uppercase letter for its shifted form (`"G"`), or a named key (`"tab"`, `"pageup"`, `"left"`, `"f2"`). For shifted symbols or digits, write the resulting character (`"!"`, not `"shift+1"`). `ctrl+<letter>` also matches an unnamed bare control byte; named Tab and Enter events stay distinct.

## Find command ids

The menus and the in-app help (`?`) show the keys for the commands they present, so a remap changes what they advertise. The full table of built-in command ids and their default keys lives in [`docs/keybindings.md`](https://github.com/modem-dev/hunk/blob/main/docs/keybindings.md) in the repository. Commands listed without a default key remain callable by id and can be assigned a shortcut; some also appear in menus.

Keys owned by a dialog, menu, or focused text input — `Esc`, `Enter` — belong to those widgets and are not remappable. The note composer's save shortcut is the command `hunk.review.saveNote` (default `ctrl+s`) and is remappable; while the composer is focused it still wins over the command table, using the resolved chord.

`[keybindings]` is read from your user config only, never from a repository's `.hunk/config.toml`: which keys do what is a property of your keyboard and habits, so a checkout you review cannot rearrange them.
