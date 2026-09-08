# CLI tools extension

Demonstrates a generic top-level command tree. The handler owns every token below `cli-tools`, can stream headless output, receives cooperative cancellation, and can hand terminal ownership to one built-in Hunk command.

Run it directly from this checkout:

```bash
bun run packages/hunk/src/main.tsx --extension ./examples/extensions/cli-tools cli-tools status
bun run packages/hunk/src/main.tsx --extension ./examples/extensions/cli-tools cli-tools review
```

`status` writes to stdout and exits. `review` performs signal-aware asynchronous preprocessing, writes progress to stderr, then delegates to `hunk diff`. A delegating handler must not write stdout or read stdin because the built-in command or TUI takes ownership of both.

The example parses its raw argument tokens directly. Extensions may use their own parser, make network requests, spawn processes, or access the filesystem under Hunk's ordinary extension trust model.
