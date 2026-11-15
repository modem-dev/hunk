---
title: Browser review
description: Review a changeset in a browser page served by Hunk on your machine, with or without a terminal UI.
---

Hunk can serve a review to a browser page on your own machine. The page shows the same review stream as the terminal, with the same keys, commands, and themes, and adds tools that need a mouse or more room than a terminal has.

## Start a browser review

Add `--web` to a review command:

```bash
hunk diff --web
hunk show HEAD~1 --web
hunk diff --staged --web
```

`--web` works on `diff`, `show`, `stash show`, `patch`, and `difftool`. Hunk starts the review without a terminal UI, prints the review URL once the session daemon has accepted the review, opens it in your default browser, and stays in the foreground until you press Ctrl+C. Ctrl+C ends the review; an open page then says the session has ended.

Standard output is exactly the URL, so a script can capture it. At a terminal, one line follows on standard error: `hunk: review ready in your browser. Press Ctrl+C to stop.`, or `hunk: open the URL above in a browser. Press Ctrl+C to stop.` with `--no-open`. If the daemon restarts, the review keeps serving and reconnects to it; if the terminal running the review goes away, the review ends.

| Flag         | Effect                                                                                 |
| ------------ | -------------------------------------------------------------------------------------- |
| `--no-open`  | Print the URL without opening a browser.                                               |
| `--no-watch` | Do not reload when the input changes. With `--web`, Hunk watches its input by default. |

Input that cannot be read again, such as `some-command | hunk patch - --web`, is served once without watching, as in [watch mode](/docs/workflows/watch-mode/).

### Open a running review

`hunk session open` opens the browser page for a review that is already running, including one in a terminal:

```bash
hunk session open --repo .          # the session for this repository
hunk session open <session-id>      # one session, from `hunk session list`
hunk session open --repo . --no-open # print the URL instead
```

In the terminal UI, **File → Open in browser** does the same for the review you are looking at. The command id is `hunk.app.openInBrowser`; it has no key by default, and you can [bind one](/docs/configure/keybindings/).

## What you see

- A toolbar with the review title, file count, totals, the shared file filter, refresh, copy link, viewed progress and **Hide viewed**, layout (auto, split, unified), wrap, line numbers, and the theme picker.
- The files sidebar, as a tree or a flat list. Selecting a file jumps to it in the stream.
- One top-to-bottom stream of every visible file, with collapsed unchanged lines you can expand, inline notes, and agent highlights.
- A side panel with **Overview** (totals by role, change kind, and directory, the largest files, and notes per file) and **Notes** (every note as threads by file, with author and text filters). Drag its edge to resize it, or focus the edge and use the arrow keys, Home, and End.
- A minimap beside the stream that marks changed regions and notes.

## Shared with the terminal, and kept per browser

The page and any terminal showing the same review are two views of one session.

- **Shared:** notes and replies, the file filter, whether agent notes are shown, viewed marks, and the review contents after a reload. An agent's `hunk session navigate` and focused comments move every view.
- **Per view:** your selection and scroll position. Moving in the browser does not move the terminal, and the other way round.
- **Per browser:** layout, wrap, line numbers, sidebar mode and width, side panel and minimap, **Hide viewed**, and the theme. The page starts on the session's theme, including a custom one; choosing another theme in the page changes only that browser. **Use session theme** in the palette goes back.

## Keys

The page answers to the terminal's command ids and default keys, and to your `[keybindings]` table: `[` and `]` move between hunks, `r` refreshes, `c` adds a note, and so on. Press `?` for the full list as it applies in the page.

Chords that use Ctrl, Cmd, Alt, Tab, or a function key stay with the browser and are not bound in the page. The page adds its own commands, under `hunk.web.*` ids in the palette; if your `[keybindings]` give one of their keys to another command, your binding wins and the page command stays in the palette without a key:

| Key                     | Action                                           |
| ----------------------- | ------------------------------------------------ |
| Ctrl+K (Cmd+K on macOS) | Command palette                                  |
| Ctrl+P (Cmd+P on macOS) | Go to file                                       |
| Ctrl+Enter (Cmd+Enter)  | Save the note you are writing                    |
| Esc                     | Cancel the note, or close a dialog               |
| `p`                     | Show or hide the side panel                      |
| `O`                     | Side panel: Overview                             |
| `N`                     | Side panel: Notes                                |
| `V`                     | Mark the selected file viewed, or clear the mark |

## Tools only in the browser

- **Line-range notes.** Drag in the line-number gutter to select lines and write a note on them. Several notes can be open at once, and an unsaved note survives reloading the tab.
- **Notes.** Add, edit, reply to, and delete your notes from the note card or with the same keys as the terminal.
- **Command palette and go to file.** Every command the page supports, searchable, with its key.
- **Links.** The address bar follows the file, hunk, or note you are on, so back and forward work. **Copy link** copies a link to the review or to the current hunk or note. A link to something the page hides (a filtered file, a file "Hide viewed" hides, or an agent note while agent notes are off) says so in a notice instead of changing your view.
- **Image previews.** Changed images compare side by side, by swipe, or by onion skin. Added and deleted images show their one side.
- **Viewed files.** The **Viewed** checkbox on a file header or flat sidebar row, or `V` on the selected file, marks it viewed; the toolbar counts "N of M viewed". A viewed file collapses to one row that opens on click. Marks belong to the session, so every page on the review sees them, and a file whose content changes on reload loses its mark and says "Changed since viewed". **Hide viewed** (`hunk.web.toggleHideViewed`) takes viewed files out of the stream, sidebar, and minimap in this browser only.
- **Rendered Markdown.** A Markdown file's header has a **Diff | Rendered** switch; the highlighted side is the one showing.

## Security

- The page is served by Hunk's session daemon on `127.0.0.1` only. It loads nothing from the network, and nothing about the review leaves your machine.
- Each review URL carries an access key for that one session (`#capability=…`). When the page loads, it moves the key out of the address bar into storage for that tab, so the key does not stay in the address bar or the tab's history. A reload of the same tab keeps working; a new tab needs the full URL again.
- Anyone who has the full URL and can reach the daemon on your machine can read the review and add, edit, or delete notes in it. Treat a copied link like a password. **Copy link** says when the copied link includes the key.
- The key stops working when the session ends.

## Limits

- Loopback only: the page is not reachable from another machine.
- The browser shows reviews. `hunk log`, `hunk status`, and `hunk open` stay in the terminal.
- Extension panes, dialogs, and commands run only in the terminal UI. In a browser-only review, repository-local extensions that are not trusted yet stay disabled.
- All sessions share one daemon port, `47657` by default. Set `HUNK_MCP_PORT` to use another loopback port.

## Troubleshooting

**The page says "This review link is not valid for that session."** The tab has no access key (for example, an address copied from the address bar after the page loaded), or the key belongs to a session that has ended. Run `hunk session open --repo .` for a current link.

**The page says "This review session has ended."** The Hunk process that served the review stopped (Ctrl+C, a closed terminal, or a crash). What the page already shows stays readable, but notes, the filter, viewed marks, and refresh are disabled. Run `hunk diff --web` again, or `hunk session open` for a review that is still running.

**The browser did not open.** Hunk prints a warning on standard error and keeps serving; open the printed URL yourself. Hunk uses `$BROWSER` when it is set.

**Port already in use.** If another program holds the daemon's port, `hunk diff --web` prints no URL and exits with status 1 within a few seconds, with `hunk: could not serve this review through the session daemon on 127.0.0.1:<port>. Session broker port 127.0.0.1:<port> is already in use by another process. Stop the conflicting process or set HUNK_MCP_PORT to a different loopback port.` Stop that program, or set `HUNK_MCP_PORT=<port>` to a free loopback port. Every Hunk command that should reach the same review needs the same value.
