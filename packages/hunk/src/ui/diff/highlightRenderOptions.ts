/** Revision for Pierre options that affect document token ranges. */
export const DOCUMENT_HIGHLIGHT_RENDER_OPTIONS_REVISION = 1;

/** Maximum line length Pierre tokenizes while preserving deterministic resource bounds. */
export const DOCUMENT_HIGHLIGHT_MAX_LINE_LENGTH = 1_000;

/** Build the Pierre options shared by inline and worker highlighting. */
export function pierreHighlightRenderOptions(themeName: string) {
  return {
    theme: themeName as "pierre-dark",
    useTokenTransformer: false,
    tokenizeMaxLineLength: DOCUMENT_HIGHLIGHT_MAX_LINE_LENGTH,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: 10_000,
  };
}
