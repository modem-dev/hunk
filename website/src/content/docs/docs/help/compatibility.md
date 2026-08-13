---
title: Terminal and platform compatibility
description: Understand Hunk's OS requirements and the terminal capabilities behind mouse, color, copy, and layout behavior.
---

Hunk supports macOS, Linux, and Windows with Node.js 18 or newer. Git is recommended; Jujutsu and Sapling support requires their respective command-line tools.

## Terminal capabilities

Hunk is a terminal-native application built on OpenTUI. The best experience needs:

- a modern terminal with Unicode and truecolor support
- alternate-screen and mouse protocol support
- enough columns for split mode (auto mode stacks on narrow screens)
- OSC 52 support when Hunk copies through the terminal clipboard protocol

If a terminal omits one capability, keyboard navigation and stack layout remain the safest fallback.

## Remote sessions and multiplexers

SSH, tmux, and similar layers can filter mouse, clipboard, keyboard, or color sequences. Verify the behavior in the underlying terminal, then ensure each intermediate layer forwards the relevant protocol. Use keyboard shortcuts when a multiplexer captures mouse reporting.

## Windows notes

Run Hunk in a modern Windows terminal with Node.js on `PATH`. Repository paths and config locations follow platform conventions; examples use shell-neutral Hunk arguments where possible. Git Bash, PowerShell, and other shells quote commands differently, so adapt multi-line shell examples to your environment.

## Light and dark backgrounds

`--theme auto` queries the terminal. If no answer arrives, Hunk uses the dark default. Choose `github-light-default` or another explicit theme when terminal reporting, transparency, or remote layers make detection unreliable.

For a specific failure, continue with [Troubleshooting](/docs/help/troubleshooting/).
