# Static renderer

`hunkdiff/static` turns a unified patch into Hunk's non-interactive ANSI output. Use it when your application already has patch text and needs a terminal-rendered diff without creating an OpenTUI application.

## Install

```bash
npm i hunkdiff
```

## Usage

```ts
import { renderStaticDiff } from "hunkdiff/static";

const patch = [
  "diff --git a/greeting.ts b/greeting.ts",
  "--- a/greeting.ts",
  "+++ b/greeting.ts",
  "@@ -1 +1 @@",
  "-export const greeting = 'hello';",
  "+export const greeting = 'hello, world';",
  "",
].join("\n");

const output = await renderStaticDiff(patch, {
  layout: "stack",
  width: process.stdout.columns,
});

process.stdout.write(output);
```

The renderer sanitizes patch text before writing terminal output. It returns ANSI text and does not create an alternate screen, read input, or start Hunk's interactive review UI.

## Options

| Option                  | Description                                                                   |
| ----------------------- | ----------------------------------------------------------------------------- |
| `layout`                | `"stack"` (default) or `"split"` rendering.                                   |
| `theme`                 | Built-in Hunk theme id. Unknown ids use the default theme.                    |
| `lineNumbers`           | Show old and new line-number gutters. Defaults to `true`.                     |
| `hunkHeaders`           | Show `@@` hunk headers. Defaults to `true`.                                   |
| `tabWidth`              | Source-code tab stop width from 1 through 16. Defaults to `4`.                |
| `transparentBackground` | Leave neutral surfaces transparent while preserving changed-line backgrounds. |
| `width`                 | Available terminal columns. Defaults to stdout columns or 120.                |
