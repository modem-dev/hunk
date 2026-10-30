# Rendered Markdown extension

An optional Markdown preview for Hunk's experimental file-view API. It parses Markdown with [Marked](https://marked.js.org/) and presents headings, inline formatting, links, lists, quotes, tables, and fenced code as host-owned symbolic rows.

This example is **not bundled or loaded by Hunk**. Install it explicitly if you want it.

## Try it from this checkout

The repository's root install supplies the example's development dependency:

```bash
bun run packages/hunk/src/main.tsx -- diff \
  --extension ./examples/extensions/rendered-markdown \
  before.md after.md
```

## Install it globally

Copy the whole folder, then install its local dependency:

```bash
mkdir -p ~/.config/hunk/extensions
cp -R examples/extensions/rendered-markdown ~/.config/hunk/extensions/
cd ~/.config/hunk/extensions/rendered-markdown
bun install
```

Hunk discovers the folder automatically on later launches. Open **View** and choose **File presentation: Rendered Markdown**, or press `F8`. The command is named `rendered-markdown.toggle-rendered-markdown` for `[keybindings]` customization.

Raw Pierre diff remains the default and fallback. The preview reads exact text through `input.readDocument`, returns hunk row bounds in source-hunk order, binds rendered blocks to exact new-side ranges, and retains hunk navigation and selection highlighting. Hunk inserts inline note cards at uniquely bound rows; if any visible note cannot be resolved, the complete file temporarily returns to raw rendering so review data is never hidden.

## Why it returns rows instead of an OpenTUI Markdown component

OpenTUI includes a capable `MarkdownRenderable`, but mounting it would make the extension own opaque layout geometry. Hunk needs exact rows before mount for review-stream measurement, windowing, scrolling, hunk navigation, and fallback. This example therefore uses the same Marked parser OpenTUI uses, then translates its tokens into the file-view contract's generic tones and text attributes.
