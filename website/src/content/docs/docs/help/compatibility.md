---
title: Terminal and platform compatibility
description: Understand Hunk's OS requirements and the terminal capabilities behind mouse, color, copy, and layout behavior.
---

Hunk publishes prebuilt binaries for macOS (arm64, x64), Linux (arm64, x64; glibc), and Windows (x64). There are no prebuilt binaries for Windows on arm64 or for musl-based Linux such as Alpine. On x86-64, Hunk needs a CPU with SSE4.2. npm installs require Node.js 22 or newer; standalone installs do not require Node.js. Git is recommended; Jujutsu and Sapling support requires their respective command-line tools.

## Terminal capabilities

Hunk is a terminal-native application built on OpenTUI. The best experience needs:

- a modern terminal with Unicode and truecolor support
- alternate-screen and mouse protocol support
- enough columns for split mode (auto mode uses unified layout on narrow screens)
- OSC 52 support when Hunk copies through the terminal clipboard protocol

If a terminal omits one capability, keyboard navigation and unified layout remain the safest fallback.

## Remote sessions and multiplexers

SSH, tmux, and similar layers can filter mouse, clipboard, keyboard, or color sequences. Verify the behavior in the underlying terminal, then ensure each intermediate layer forwards the relevant protocol. Use keyboard shortcuts when mouse reporting is captured by a multiplexer.

## Windows notes

Run Hunk in a modern Windows terminal. npm installs require Node.js 22 or newer on `PATH`; standalone mise installs do not require Node.js.

Hunk uses the same directory layout on Windows as on macOS and Linux, rooted at your home directory (`HOME` if set, otherwise `%USERPROFILE%`) rather than `%APPDATA%`:

| File                | Default location                             |
| ------------------- | -------------------------------------------- |
| User config         | `%USERPROFILE%\.config\hunk\config.toml`     |
| Saved state (trust) | `%USERPROFILE%\.local\state\hunk\state.json` |
| Global extensions   | `%USERPROFILE%\.config\hunk\extensions\`     |

Set `XDG_CONFIG_HOME` or `XDG_STATE_HOME` to move them. The plain-text pager falls back to `more`, and `hunk completion` supports bash and zsh only.

Git Bash, PowerShell, and other shells quote commands differently, so adapt multi-line shell examples to your environment.

## Light and dark backgrounds

The default `terminal` theme reads your terminal's palette and falls back to a standard xterm-style palette when the terminal doesn't answer. `--theme auto` queries the terminal background and falls back to `github-dark-default`. Choose `github-light-default` or another explicit theme when terminal reporting, transparency, or remote layers make detection unreliable.

For a specific failure, continue with [Troubleshooting](/docs/help/troubleshooting/).
