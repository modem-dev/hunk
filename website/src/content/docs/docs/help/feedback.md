---
title: Send feedback
description: Tell the Hunk team what works and what doesn't, and see exactly what a submission sends.
---

Hunk can send a short message to the team that makes it, through [Modem](https://modem.dev)'s feedback service. Use it for "this confused me" or "I wish Hunk did X". For bugs that need steps to reproduce, [open a GitHub issue](https://github.com/modem-dev/hunk/issues) instead.

Hunk never sends feedback on its own. It sends only when you confirm one specific message, and it shows you everything that message contains first.

## From the review

Open **Help → Send feedback…**. The form shows what will be sent above the message box. Type your message, optionally add an email address if you want a reply, and press `ctrl+s` or click **send to Modem**. Press `esc` to cancel; nothing is sent and the draft is not saved anywhere.

The command has no default key. Bind one with the `hunk.app.openFeedback` id in [`[keybindings]`](/docs/configure/keybindings/).

## From the command line

```bash
hunk feedback "The split view loses my place when I resize"
```

Hunk prints what it will send, including the exact request body, and asks `Send this feedback to Modem? [y/N]`. Anything but `y` cancels.

| Option                 | Effect                                                          |
| ---------------------- | --------------------------------------------------------------- |
| `--dry-run`            | Print exactly what would be sent, then exit without sending.    |
| `--email <address>`    | Add a reply address. Omitted unless you pass it.                |
| `-F, --file <path\|->` | Read the message from a file, or from stdin with `-`.           |
| `--skip-confirm`       | Send without the prompt. Needed when no terminal can answer it. |
| `--json`               | Print the result as JSON.                                       |

With no message, `hunk feedback` opens the same form the review uses. The prompt reads your answer from the terminal, not from stdin, so a piped message can still be confirmed at the keyboard:

```bash
git log -1 --format=%B | hunk feedback --file -
```

## What is sent

One HTTPS request to Modem's feedback service (`ingest.modem.dev`, part of modem.dev), containing:

| Field            | Value                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Message          | What you typed.                                                                                                |
| Hunk version     | For example `0.24.1`.                                                                                          |
| Operating system | `darwin`, `linux`, or `win32`. No OS version.                                                                  |
| Source labels    | Constant labels saying it came from Hunk's terminal app, and whether from the form or the CLI.                 |
| Submission ID    | A random ID made for this one message, so a retry is not counted twice. It is not tied to you or your machine. |
| Email            | Only if you entered one.                                                                                       |

Nothing else is sent: no file names, diffs, repository paths, configuration, account details, or machine identifiers. As with any web request, Modem's servers see your IP address. It is used for rate limiting and is not stored with your feedback.

If a send times out or you press `esc` while it is in flight, Hunk says it couldn't confirm the result. The message may still have arrived. Sending it again won't create a duplicate.

## Turning it off

Feedback never sends without your confirmation, so `DO_NOT_TRACK` and `HUNK_DISABLE_ANALYTICS` do not hide it. To remove the Help entry and the command entirely, set this in your config:

```toml
[feedback]
enabled = false
```

A repository's `.hunk/config.toml` can turn feedback off for its contributors but cannot turn it back on. See the [config reference](/docs/reference/config/#feedback).
