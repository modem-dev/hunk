import {
  cleanLastNewline,
  getHighlighterOptions,
  getSharedHighlighter,
  renderDiffWithHighlighter,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { formatHunkHeader } from "../../core/hunkHeader";
import type { DiffFile } from "../../core/types";
import type { AppTheme } from "../themes";
import { expandDiffTabs } from "./codeColumns";

const PIERRE_THEME = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

/** Resolve the single Pierre theme name needed for the current appearance. */
function pierreThemeName(appearance: AppTheme["appearance"]) {
  return PIERRE_THEME[appearance];
}

const PIERRE_RENDER_OPTIONS_BY_APPEARANCE = {
  light: {
    theme: pierreThemeName("light"),
    tokenizeMaxLineLength: 1_000,
    lineDiffType: "word-alt" as const,
  },
  dark: {
    theme: pierreThemeName("dark"),
    tokenizeMaxLineLength: 1_000,
    lineDiffType: "word-alt" as const,
  },
} as const;

/** Reuse the render options for one appearance so startup work avoids extra object churn. */
function pierreRenderOptions(appearance: AppTheme["appearance"]) {
  return PIERRE_RENDER_OPTIONS_BY_APPEARANCE[appearance];
}

type HighlightOptions = ReturnType<typeof getHighlighterOptions>;

const highlighterOptionsByKey = new Map<string, HighlightOptions>();
let queuedHighlightWork = Promise.resolve();

type HastNode = HastTextNode | HastElementNode;

interface HastTextNode {
  type: "text";
  value: string;
}

interface HastElementNode {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export interface HighlightedDiffCode {
  deletionLines: Array<HastNode | undefined>;
  additionLines: Array<HastNode | undefined>;
}

export interface RenderSpan {
  text: string;
  fg?: string;
  bg?: string;
}

export interface SplitLineCell {
  kind: "context" | "addition" | "deletion" | "empty";
  sign: string;
  lineNumber?: number;
  spans: RenderSpan[];
}

export interface StackLineCell {
  kind: "context" | "addition" | "deletion";
  sign: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  spans: RenderSpan[];
}

export type DiffRow =
  | {
      type: "collapsed" | "hunk-header";
      key: string;
      fileId: string;
      hunkIndex: number;
      text: string;
    }
  | {
      type: "split-line";
      key: string;
      fileId: string;
      hunkIndex: number;
      left: SplitLineCell;
      right: SplitLineCell;
    }
  | {
      type: "stack-line";
      key: string;
      fileId: string;
      hunkIndex: number;
      cell: StackLineCell;
    };

/** Replace tabs with fixed spaces so terminal cell widths stay predictable. */
function tabify(text: string) {
  return expandDiffTabs(text);
}

const EMPTY_STYLE_VALUES = new Map<string, string>();
// Pierre reuses the same tiny set of inline style strings across many token spans.
// Caching the parsed key/value pairs avoids reparsing identical `color:#...` snippets
// every time split/stack row builders revisit the same highlighted lines.
const parsedStyleValueCache = new Map<string, Map<string, string>>();

/** Parse an inline CSS style string from Pierre's highlighted HAST output. */
function parseStyleValue(styleValue: unknown) {
  if (typeof styleValue !== "string") {
    return EMPTY_STYLE_VALUES;
  }

  const cached = parsedStyleValueCache.get(styleValue);
  if (cached) {
    return cached;
  }

  const styles = new Map<string, string>();
  for (const segment of styleValue.split(";")) {
    const separator = segment.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (key && value) {
      styles.set(key, value);
    }
  }

  parsedStyleValueCache.set(styleValue, styles);
  return styles;
}

const RESERVED_PIERRE_TOKEN_COLORS = {
  dark: {
    "#ff6762": "keyword",
    "#5ecc71": "string",
  },
  light: {
    "#d52c36": "keyword",
    "#199f43": "string",
  },
} as const;
// After style parsing, token colors still need one normalization step so syntax hues never
// collide with diff-semantic add/remove colors. Cache that remap per theme because themes that
// share an appearance can still use different syntax palettes.
const normalizedColorCache = new Map<string, Map<string, string>>();
// The expensive part after highlighting is walking Pierre's HAST line tree and flattening it
// into terminal spans. The same highlighted line objects are reused when files remount or when
// we build both split and stack rows, so memoize flattened spans by line node + theme/background.
const flattenedHighlightedLineCache = new WeakMap<HastNode, Map<string, RenderSpan[]>>();

/** Remap Pierre token hues that collide with diff add/remove semantics into theme-safe syntax colors. */
function normalizeHighlightedColor(color: string | undefined, theme: AppTheme) {
  if (!color) {
    return color;
  }

  let cacheForTheme = normalizedColorCache.get(theme.id);
  if (!cacheForTheme) {
    cacheForTheme = new Map<string, string>();
    normalizedColorCache.set(theme.id, cacheForTheme);
  }

  const cached = cacheForTheme.get(color);
  if (cached) {
    return cached;
  }

  const normalized = color.trim().toLowerCase();
  const reserved =
    RESERVED_PIERRE_TOKEN_COLORS[theme.appearance][
      normalized as keyof (typeof RESERVED_PIERRE_TOKEN_COLORS)[typeof theme.appearance]
    ];
  const resolvedColor = reserved ? theme.syntaxColors[reserved] : color;
  cacheForTheme.set(color, resolvedColor);
  return resolvedColor;
}

/** Append a span while coalescing adjacent runs with identical colors. */
function mergeSpan(target: RenderSpan[], next: RenderSpan) {
  if (next.text.length === 0) {
    return;
  }

  const previous = target[target.length - 1];
  if (previous && previous.fg === next.fg && previous.bg === next.bg) {
    previous.text += next.text;
    return;
  }

  target.push(next);
}

/** Flatten one highlighted HAST line into terminal-friendly styled text spans. */
function flattenHighlightedLine(node: HastNode | undefined, theme: AppTheme, emphasisBg: string) {
  if (!node) {
    return [];
  }

  const cacheKey = `${theme.id}:${emphasisBg}`;
  const cachedByTheme = flattenedHighlightedLineCache.get(node);
  const cached = cachedByTheme?.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Cache hits here are what make revisiting/remounting already-highlighted files cheap:
  // we skip the full recursive walk and return the already-flattened terminal spans.

  const spans: RenderSpan[] = [];
  const colorVariable = theme.appearance === "light" ? "--diffs-token-light" : "--diffs-token-dark";

  const visit = (current: HastNode | undefined, inherited: Pick<RenderSpan, "fg" | "bg">) => {
    if (!current) {
      return;
    }

    if (current.type === "text") {
      mergeSpan(spans, {
        text: tabify(current.value),
        fg: inherited.fg,
        bg: inherited.bg,
      });
      return;
    }

    const properties = current.properties ?? {};
    const styles = parseStyleValue(properties.style);
    const nextStyle: Pick<RenderSpan, "fg" | "bg"> = {
      // Newer Pierre output can emit direct `color:#...` styles instead of theme CSS variables.
      fg: normalizeHighlightedColor(
        styles.get(colorVariable) ?? styles.get("color") ?? inherited.fg,
        theme,
      ),
      // Pierre marks inline word-diff emphasis spans with a data attribute rather than a separate row kind.
      bg: Object.hasOwn(properties, "data-diff-span") ? emphasisBg : inherited.bg,
    };

    for (const child of current.children ?? []) {
      visit(child, nextStyle);
    }
  };

  visit(node, {});

  const nextCachedByTheme = cachedByTheme ?? new Map<string, RenderSpan[]>();
  nextCachedByTheme.set(cacheKey, spans);
  if (!cachedByTheme) {
    flattenedHighlightedLineCache.set(node, nextCachedByTheme);
  }

  return spans;
}

/** Normalize one raw diff line before rendering. */
function cleanDiffLine(line: string | undefined) {
  return tabify(cleanLastNewline(line ?? ""));
}

/** Build the normalized render model for one split-view cell. */
function makeSplitCell(
  kind: SplitLineCell["kind"],
  lineNumber: number | undefined,
  rawLine: string | undefined,
  highlightedLine: HastNode | undefined,
  theme: AppTheme,
) {
  if (kind === "empty") {
    return {
      kind,
      sign: " ",
      spans: [],
    } satisfies SplitLineCell;
  }

  // Startup renders often build rows before highlighted HAST exists, so keep that plain-text path cheap.
  // Once highlighted spans are available, avoid touching the raw source line unless flattening
  // produced nothing. That keeps newline stripping + tab expansion off the hot path.
  let spans: RenderSpan[];
  if (highlightedLine === undefined) {
    const fallbackText = cleanDiffLine(rawLine);
    spans = fallbackText.length > 0 ? [{ text: fallbackText }] : [];
  } else {
    spans = flattenHighlightedLine(
      highlightedLine,
      theme,
      kind === "addition"
        ? theme.addedContentBg
        : kind === "deletion"
          ? theme.removedContentBg
          : theme.contextContentBg,
    );

    if (spans.length === 0) {
      const fallbackText = cleanDiffLine(rawLine);
      spans = fallbackText.length > 0 ? [{ text: fallbackText }] : [];
    }
  }

  return {
    kind,
    sign: kind === "addition" ? "+" : kind === "deletion" ? "-" : " ",
    lineNumber,
    spans,
  } satisfies SplitLineCell;
}

/** Build the normalized render model for one stack-view cell. */
function makeStackCell(
  kind: StackLineCell["kind"],
  oldLineNumber: number | undefined,
  newLineNumber: number | undefined,
  rawLine: string | undefined,
  highlightedLine: HastNode | undefined,
  theme: AppTheme,
) {
  // Same lazy-fallback strategy as split cells: only normalize the raw source line when we really
  // need the plain-text fallback, not when highlighted spans are already ready to reuse.
  let spans: RenderSpan[];
  if (highlightedLine === undefined) {
    const fallbackText = cleanDiffLine(rawLine);
    spans = fallbackText.length > 0 ? [{ text: fallbackText }] : [];
  } else {
    spans = flattenHighlightedLine(
      highlightedLine,
      theme,
      kind === "addition"
        ? theme.addedContentBg
        : kind === "deletion"
          ? theme.removedContentBg
          : theme.contextContentBg,
    );

    if (spans.length === 0) {
      const fallbackText = cleanDiffLine(rawLine);
      spans = fallbackText.length > 0 ? [{ text: fallbackText }] : [];
    }
  }

  return {
    kind,
    sign: kind === "addition" ? "+" : kind === "deletion" ? "-" : " ",
    oldLineNumber,
    newLineNumber,
    spans,
  } satisfies StackLineCell;
}

/** Describe a collapsed unchanged region between visible hunks. */
function collapsedRowText(lines: number) {
  return `${lines} unchanged ${lines === 1 ? "line" : "lines"}`;
}

/** Count hidden unchanged lines after the final visible hunk when Pierre omits them. */
function trailingCollapsedLines(metadata: FileDiffMetadata) {
  const lastHunk = metadata.hunks.at(-1);
  if (!lastHunk || metadata.isPartial) {
    return 0;
  }

  const additionRemaining =
    metadata.additionLines.length - (lastHunk.additionLineIndex + lastHunk.additionCount);
  const deletionRemaining =
    metadata.deletionLines.length - (lastHunk.deletionLineIndex + lastHunk.deletionCount);

  if (additionRemaining !== deletionRemaining) {
    return 0;
  }

  return Math.max(additionRemaining, 0);
}

/** Prepare syntax highlighting for one language/appearance pair using Pierre's shared highlighter. */
async function prepareHighlighter(
  language: string | undefined,
  appearance: AppTheme["appearance"],
) {
  const resolvedLanguage = language ?? "text";
  const cacheKey = `${appearance}:${resolvedLanguage}`;
  const options =
    highlighterOptionsByKey.get(cacheKey) ??
    getHighlighterOptions(resolvedLanguage, {
      theme: pierreThemeName(appearance),
    });

  if (!highlighterOptionsByKey.has(cacheKey)) {
    highlighterOptionsByKey.set(cacheKey, options);
  }

  return getSharedHighlighter({
    ...options,
    preferredHighlighter: "shiki-wasm",
  });
}

/** Queue highlight rendering so startup work stays serialized in request order. */
function queueHighlightedDiff(run: () => HighlightedDiffCode) {
  const queued = queuedHighlightWork.then(
    () =>
      new Promise<HighlightedDiffCode>((resolve, reject) => {
        queueMicrotask(() => {
          try {
            resolve(run());
          } catch (error) {
            reject(error);
          }
        });
      }),
  );

  queuedHighlightWork = queued.then(
    () => undefined,
    () => undefined,
  );

  return queued;
}

/**
 * Pierre highlights unchanged context on both diff sides even though split/stack rendering later
 * cares only about the styled code spans. Reuse one side's line node for both arrays so identical
 * context flattens once and the existing WeakMap span cache can fan that result back out.
 */
function aliasHighlightedContextLines(file: DiffFile, highlighted: HighlightedDiffCode) {
  for (const hunk of file.metadata.hunks) {
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          const sharedLine =
            highlighted.additionLines[additionLineIndex + offset] ??
            highlighted.deletionLines[deletionLineIndex + offset];

          if (!sharedLine) {
            continue;
          }

          highlighted.deletionLines[deletionLineIndex + offset] = sharedLine;
          highlighted.additionLines[additionLineIndex + offset] = sharedLine;
        }

        deletionLineIndex += content.lines;
        additionLineIndex += content.lines;
        continue;
      }

      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
    }
  }

  return highlighted;
}

/** Highlight a diff file and return just the rendered line trees the UI needs. */
export async function loadHighlightedDiff(
  file: DiffFile,
  appearance: AppTheme["appearance"] = "dark",
): Promise<HighlightedDiffCode> {
  try {
    const highlighter = await prepareHighlighter(file.language, appearance);
    return queueHighlightedDiff(() => {
      const highlighted = renderDiffWithHighlighter(
        file.metadata,
        highlighter,
        pierreRenderOptions(appearance),
      );
      return aliasHighlightedContextLines(file, {
        deletionLines: highlighted.code.deletionLines as Array<HastNode | undefined>,
        additionLines: highlighted.code.additionLines as Array<HastNode | undefined>,
      });
    });
  } catch {
    const highlighter = await prepareHighlighter("text", appearance);
    return queueHighlightedDiff(() => {
      const highlighted = renderDiffWithHighlighter(
        { ...file.metadata, lang: "text" },
        highlighter,
        pierreRenderOptions(appearance),
      );
      return aliasHighlightedContextLines(file, {
        deletionLines: highlighted.code.deletionLines as Array<HastNode | undefined>,
        additionLines: highlighted.code.additionLines as Array<HastNode | undefined>,
      });
    });
  }
}

/** Expand Pierre metadata into the flat split-view row stream consumed by the renderer. */
export function buildSplitRows(
  file: DiffFile,
  highlighted: HighlightedDiffCode | null,
  theme: AppTheme,
): DiffRow[] {
  const rows: DiffRow[] = [];
  const deletionLines = highlighted?.deletionLines ?? [];
  const additionLines = highlighted?.additionLines ?? [];

  for (const [hunkIndex, hunk] of file.metadata.hunks.entries()) {
    if (hunk.collapsedBefore > 0) {
      rows.push({
        type: "collapsed",
        key: `${file.id}:collapsed:${hunkIndex}`,
        fileId: file.id,
        hunkIndex,
        text: collapsedRowText(hunk.collapsedBefore),
      });
    }

    rows.push({
      type: "hunk-header",
      key: `${file.id}:header:${hunkIndex}`,
      fileId: file.id,
      hunkIndex,
      text: formatHunkHeader(hunk),
    });

    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;
    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          rows.push({
            type: "split-line",
            key: `${file.id}:split:${hunkIndex}:context:${deletionLineIndex + offset}:${additionLineIndex + offset}`,
            fileId: file.id,
            hunkIndex,
            left: makeSplitCell(
              "context",
              deletionLineNumber + offset,
              file.metadata.deletionLines[deletionLineIndex + offset],
              deletionLines[deletionLineIndex + offset],
              theme,
            ),
            right: makeSplitCell(
              "context",
              additionLineNumber + offset,
              file.metadata.additionLines[additionLineIndex + offset],
              additionLines[additionLineIndex + offset],
              theme,
            ),
          });
        }

        deletionLineIndex += content.lines;
        additionLineIndex += content.lines;
        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        continue;
      }

      // Split mode keeps deletions and additions visually paired, padding the shorter side with empty cells.
      const pairedLines = Math.max(content.deletions, content.additions);
      for (let offset = 0; offset < pairedLines; offset += 1) {
        const hasDeletion = offset < content.deletions;
        const hasAddition = offset < content.additions;

        rows.push({
          type: "split-line",
          key: `${file.id}:split:${hunkIndex}:change:${deletionLineIndex + offset}:${additionLineIndex + offset}`,
          fileId: file.id,
          hunkIndex,
          left: hasDeletion
            ? makeSplitCell(
                "deletion",
                deletionLineNumber + offset,
                file.metadata.deletionLines[deletionLineIndex + offset],
                deletionLines[deletionLineIndex + offset],
                theme,
              )
            : makeSplitCell("empty", undefined, undefined, undefined, theme),
          right: hasAddition
            ? makeSplitCell(
                "addition",
                additionLineNumber + offset,
                file.metadata.additionLines[additionLineIndex + offset],
                additionLines[additionLineIndex + offset],
                theme,
              )
            : makeSplitCell("empty", undefined, undefined, undefined, theme),
        });
      }

      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
    }
  }

  const trailingLines = trailingCollapsedLines(file.metadata);
  if (trailingLines > 0) {
    rows.push({
      type: "collapsed",
      key: `${file.id}:collapsed:trailing`,
      fileId: file.id,
      hunkIndex: Math.max(file.metadata.hunks.length - 1, 0),
      text: collapsedRowText(trailingLines),
    });
  }

  return rows;
}

/** Expand Pierre metadata into the flat stack-view row stream consumed by the renderer. */
export function buildStackRows(
  file: DiffFile,
  highlighted: HighlightedDiffCode | null,
  theme: AppTheme,
): DiffRow[] {
  const rows: DiffRow[] = [];
  const deletionLines = highlighted?.deletionLines ?? [];
  const additionLines = highlighted?.additionLines ?? [];

  for (const [hunkIndex, hunk] of file.metadata.hunks.entries()) {
    if (hunk.collapsedBefore > 0) {
      rows.push({
        type: "collapsed",
        key: `${file.id}:stack:collapsed:${hunkIndex}`,
        fileId: file.id,
        hunkIndex,
        text: collapsedRowText(hunk.collapsedBefore),
      });
    }

    rows.push({
      type: "hunk-header",
      key: `${file.id}:stack:header:${hunkIndex}`,
      fileId: file.id,
      hunkIndex,
      text: formatHunkHeader(hunk),
    });

    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;
    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          rows.push({
            type: "stack-line",
            key: `${file.id}:stack:${hunkIndex}:context:${deletionLineIndex + offset}:${additionLineIndex + offset}`,
            fileId: file.id,
            hunkIndex,
            cell: makeStackCell(
              "context",
              deletionLineNumber + offset,
              additionLineNumber + offset,
              file.metadata.additionLines[additionLineIndex + offset],
              additionLines[additionLineIndex + offset],
              theme,
            ),
          });
        }

        deletionLineIndex += content.lines;
        additionLineIndex += content.lines;
        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        continue;
      }

      for (let offset = 0; offset < content.deletions; offset += 1) {
        rows.push({
          type: "stack-line",
          key: `${file.id}:stack:${hunkIndex}:deletion:${deletionLineIndex + offset}`,
          fileId: file.id,
          hunkIndex,
          cell: makeStackCell(
            "deletion",
            deletionLineNumber + offset,
            undefined,
            file.metadata.deletionLines[deletionLineIndex + offset],
            deletionLines[deletionLineIndex + offset],
            theme,
          ),
        });
      }

      for (let offset = 0; offset < content.additions; offset += 1) {
        rows.push({
          type: "stack-line",
          key: `${file.id}:stack:${hunkIndex}:addition:${additionLineIndex + offset}`,
          fileId: file.id,
          hunkIndex,
          cell: makeStackCell(
            "addition",
            undefined,
            additionLineNumber + offset,
            file.metadata.additionLines[additionLineIndex + offset],
            additionLines[additionLineIndex + offset],
            theme,
          ),
        });
      }

      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
    }
  }

  const trailingLines = trailingCollapsedLines(file.metadata);
  if (trailingLines > 0) {
    rows.push({
      type: "collapsed",
      key: `${file.id}:stack:collapsed:trailing`,
      fileId: file.id,
      hunkIndex: Math.max(file.metadata.hunks.length - 1, 0),
      text: collapsedRowText(trailingLines),
    });
  }

  return rows;
}
