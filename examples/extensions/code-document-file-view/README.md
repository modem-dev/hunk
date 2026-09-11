# Code-document file view

This API-v26 example presents one old/new code pair per diff hunk. It declares the complete source documents so Hunk can tokenize with multiline lexical context, while each displayed span references either a complete old-side line or a partial new-side UTF-16 slice. Gutters and the unhighlighted prefix stay ordinary symbolic spans.

Hunk owns the language, active syntax theme, workers, caching, terminal safety, and plain fallback. The extension never supplies token colors.

Run it from this checkout against two JavaScript or TypeScript files:

```bash
bun run packages/hunk/src/main.tsx -- diff \
  --extension ./examples/extensions/code-document-file-view \
  path/to/before.ts path/to/after.ts
```

Choose **View → File presentation → Code documents: old / new**. The example intentionally omits `sourceRanges`: syntax references paint code but do not claim note/navigation ownership. A visible note therefore makes Hunk use the raw diff, as required by the all-or-raw note policy.
