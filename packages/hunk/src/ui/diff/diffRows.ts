/**
 * Turns a parsed diff into the terminal row model every review surface draws from.
 *
 * `DiffRow` is the unit the rest of the UI measures, windows, and paints, so this module is
 * named for that role rather than for Pierre, whose highlighter it calls to build the spans
 * each row carries.
 */
import {
  cleanLastNewline,
  getHighlighterOptions,
  getSharedHighlighter,
  renderDiffWithHighlighter,
  renderFileWithHighlighter,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { formatHunkHeader } from "../../core/changeset/hunkHeader";
import {
  reviewLeadingGap,
  reviewTrailingGap,
  type ReviewGapAddress,
} from "../../core/review/expansion";
import { DEFAULT_TAB_WIDTH } from "../../core/run/tabWidth";
import type { DiffFile, DiffLineMoveKind } from "../../core/changeset/model";
import { blendHex, hexColorDistance } from "../lib/color";
import { measureTextWidth } from "../lib/text";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { MIN_EMPHASIS_SEPARATION, TRANSPARENT_BACKGROUND, type AppTheme } from "../themes";
import { expandDiffTabs } from "./codeColumns";
import type { DiffRow, RenderSpan, SplitLineCell, StackLineCell } from "./diffRowModel";
import {
  aliasContextHighlightLines,
  collectHastHighlightRuns,
  compactHighlightRunsForLine,
  highlightDiffInWorker,
  supportsHighlightWorkerOffload,
  validateCompactHighlightedDiff,
  type CompactHighlightedDiff,
  type CompactHighlightRun,
  type HastNode,
} from "./worker";
import {
  createSourceBackedHighlightPlan,
  remapSourceBackedHighlight,
  type SourceBackedHighlightPlan,
} from "./sourceBackedHighlight";
import {
  ensureSyntaxHighlightThemeRegistered,
  syntaxHighlightThemeName,
} from "./syntaxHighlightTheme";

type HighlightThemeInput = AppTheme | AppTheme["appearance"];

export const HIGHLIGHT_WORKER_MIN_LINES = 40;

export interface LoadHighlightedDiffOptions {
  /** Allow the interactive TUI to move eligible highlighting into the Bun worker. */
  offloadLargeDiff?: boolean;
}

/** Return the light/dark mode for a theme object or legacy appearance argument. */
function highlightThemeAppearance(theme: HighlightThemeInput) {
  return typeof theme === "string" ? theme : theme.appearance;
}

/** Build render options for the active syntax theme. */
function pierreRenderOptions(theme: HighlightThemeInput) {
  return {
    theme: syntaxHighlightThemeName(theme),
    useTokenTransformer: false,
    tokenizeMaxLineLength: 1_000,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: 10_000,
  };
}

type HighlightOptions = ReturnType<typeof getHighlighterOptions>;

const highlighterOptionsByKey = new Map<string, HighlightOptions>();
let queuedHighlightWork = Promise.resolve();

export interface CompactHighlightedDiffCode {
  payload: CompactHighlightedDiff;
  /** Map visible patch-side indexes to full-source payload indexes when source context was used. */
  deletionLineMap?: readonly number[];
  additionLineMap?: readonly number[];
}

export interface HighlightedDiffCode {
  deletionLines: Array<HastNode | undefined>;
  additionLines: Array<HastNode | undefined>;
  /** Holds the worker's compact result without reconstructing a HAST response tree. */
  compact?: CompactHighlightedDiffCode;
  /** Keeps a transient offload failure out of the shared cache so a later visit can retry it. */
  retryable?: true;
}

export interface HighlightedSourceCode {
  lines: Array<HastNode | undefined>;
}

export type {
  CollapsedGapPosition,
  DiffRow,
  RenderSpan,
  SplitLineCell,
  StackLineCell,
} from "./diffRowModel";

/** Expand source tabs before terminal rendering so downstream geometry stays predictable. */
function tabify(text: string, tabWidth: number, initialColumn = 0) {
  return expandDiffTabs(sanitizeTerminalLine(text), tabWidth, initialColumn);
}

// The expensive part after highlighting is walking Pierre's HAST line tree and flattening it
// into terminal spans. The same highlighted line objects are reused when files remount or when
// we build both split and stack rows, so memoize flattened spans by line node + theme/background.
const flattenedHighlightedLineCache = new WeakMap<HastNode, Map<string, RenderSpan[]>>();
const WORD_DIFF_BLEND_STEP = 0.005;
const WORD_DIFF_MAX_BLEND = 0.2;
const wordDiffBackgroundCache = new Map<string, Record<SplitLineCell["kind"], string>>();

/** Blend toward the semantic sign color just enough to hit the minimum visible contrast. */
function strengthenWordDiffBg(lineBg: string, signColor: string) {
  let strongestCandidate = lineBg;
  const maxSteps = Math.floor(WORD_DIFF_MAX_BLEND / WORD_DIFF_BLEND_STEP);

  for (let step = 1; step <= maxSteps; step += 1) {
    const blendRatio = step * WORD_DIFF_BLEND_STEP;
    const candidate = blendHex(signColor, lineBg, blendRatio);
    strongestCandidate = candidate;

    if (hexColorDistance(candidate, lineBg) >= MIN_EMPHASIS_SEPARATION) {
      return candidate;
    }
  }

  return strongestCandidate;
}

/** Return whether a theme color can safely participate in RGB distance and blend math. */
function isHexThemeColor(color: string) {
  return /^#[0-9a-f]{6}$/i.test(color);
}

/** Strengthen custom-theme overrides whose pair sits too close together. */
export function resolveWordDiffHighlightBg(contentBg: string, lineBg: string, signColor: string) {
  if (contentBg === TRANSPARENT_BACKGROUND || lineBg === TRANSPARENT_BACKGROUND) {
    return contentBg;
  }

  if (!isHexThemeColor(contentBg) || !isHexThemeColor(lineBg)) {
    return contentBg;
  }

  return hexColorDistance(contentBg, lineBg) >= MIN_EMPHASIS_SEPARATION
    ? contentBg
    : strengthenWordDiffBg(lineBg, signColor);
}

/** Resolve the inline word-diff background, strengthening theme colors that are too subtle to see. */
function wordDiffHighlightBg(kind: SplitLineCell["kind"], theme: AppTheme) {
  const cacheKey = [
    theme.addedContentBg,
    theme.addedBg,
    theme.addedSignColor,
    theme.removedContentBg,
    theme.removedBg,
    theme.removedSignColor,
    theme.contextContentBg,
    theme.panelAlt,
  ].join(":");
  let cached = wordDiffBackgroundCache.get(cacheKey);
  if (!cached) {
    const addition = resolveWordDiffHighlightBg(
      theme.addedContentBg,
      theme.addedBg,
      theme.addedSignColor,
    );
    const deletion = resolveWordDiffHighlightBg(
      theme.removedContentBg,
      theme.removedBg,
      theme.removedSignColor,
    );

    cached = {
      addition,
      context: theme.contextContentBg,
      deletion,
      empty: theme.panelAlt,
    };
    wordDiffBackgroundCache.set(cacheKey, cached);
  }

  return cached[kind];
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
function flattenHighlightedLine(
  node: HastNode | undefined,
  theme: AppTheme,
  emphasisBg: string,
  tabWidth: number,
) {
  if (!node) {
    return [];
  }

  // The highlighted HAST node is already unique to the content-addressed Shiki theme. Only
  // post-highlight choices belong in the inner key; syntax identity comes from the WeakMap key.
  const cacheKey = `${theme.appearance}:${emphasisBg}:${tabWidth}`;
  const cachedByTheme = flattenedHighlightedLineCache.get(node);
  const cached = cachedByTheme?.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Cache hits here are what make revisiting/remounting already-highlighted files cheap:
  // we skip the full recursive walk and return the already-flattened terminal spans.

  const spans: RenderSpan[] = [];
  let codeColumn = 0;

  for (const run of collectHastHighlightRuns(node, theme.appearance)) {
    const text = tabify(run.text, tabWidth, codeColumn);
    mergeSpan(spans, {
      text,
      fg: run.fg,
      bg: run.wordDiff ? emphasisBg : undefined,
    });
    codeColumn += measureTextWidth(text);
  }

  const nextCachedByTheme = cachedByTheme ?? new Map<string, RenderSpan[]>();
  nextCachedByTheme.set(cacheKey, spans);
  if (!cachedByTheme) {
    flattenedHighlightedLineCache.set(node, nextCachedByTheme);
  }

  return spans;
}

/** Flatten compact worker ranges against local text without rebuilding a HAST response tree. */
function flattenCompactHighlightedLine(
  rawLine: string | undefined,
  runs: CompactHighlightRun[],
  emphasisBg: string,
  tabWidth: number,
) {
  const source = cleanLastNewline(rawLine ?? "");
  const spans: RenderSpan[] = [];
  let sourceColumn = 0;
  let codeColumn = 0;

  const appendText = (text: string, fg?: string, bg?: string) => {
    const tabified = tabify(text, tabWidth, codeColumn);
    mergeSpan(spans, { text: tabified, fg, bg });
    codeColumn += measureTextWidth(tabified);
  };

  for (const run of runs) {
    appendText(source.slice(sourceColumn, run.start));
    appendText(source.slice(run.start, run.end), run.fg, run.wordDiff ? emphasisBg : undefined);
    sourceColumn = run.end;
  }
  appendText(source.slice(sourceColumn));

  return spans;
}

/** Resolve the compact worker runs for one visible patch-side line when present. */
function compactRunsForHighlightedLine(
  highlighted: HighlightedDiffCode | null,
  side: "deletion" | "addition",
  lineIndex: number,
) {
  const compact = highlighted?.compact;
  if (!compact) {
    return undefined;
  }

  const sourceLineMap = side === "deletion" ? compact.deletionLineMap : compact.additionLineMap;
  const sourceIndex = sourceLineMap ? sourceLineMap[lineIndex] : lineIndex;
  const lineCount = compact.payload[side].lineOffsets.length - 1;
  if (
    !Number.isInteger(sourceIndex) ||
    sourceIndex === undefined ||
    sourceIndex < 0 ||
    sourceIndex >= lineCount
  ) {
    return undefined;
  }

  return compactHighlightRunsForLine(compact.payload, side, sourceIndex);
}

/** Normalize one raw diff line before rendering. */
function cleanDiffLine(line: string | undefined, tabWidth: number) {
  return tabify(cleanLastNewline(line ?? ""), tabWidth);
}

/** Build the normalized render model for one split-view cell. */
function makeSplitCell(
  kind: SplitLineCell["kind"],
  lineNumber: number | undefined,
  rawLine: string | undefined,
  highlightedLine: HastNode | undefined,
  theme: AppTheme,
  tabWidth: number,
  moveKind?: DiffLineMoveKind,
  compactRuns?: CompactHighlightRun[],
) {
  if (kind === "empty") {
    return {
      kind,
      sign: " ",
      spans: [],
    } satisfies SplitLineCell;
  }

  // Startup renders often build rows before any highlight result exists, so keep that plain-text
  // path cheap. HAST wins for inline work; worker responses decode compact ranges against raw text.
  let spans: RenderSpan[];
  if (highlightedLine !== undefined) {
    spans = flattenHighlightedLine(
      highlightedLine,
      theme,
      wordDiffHighlightBg(kind, theme),
      tabWidth,
    );
  } else if (compactRuns !== undefined) {
    spans = flattenCompactHighlightedLine(
      rawLine,
      compactRuns,
      wordDiffHighlightBg(kind, theme),
      tabWidth,
    );
  } else {
    spans = [];
  }

  if (spans.length === 0) {
    const fallbackText = cleanDiffLine(rawLine, tabWidth);
    spans = fallbackText.length > 0 ? [{ text: fallbackText }] : [];
  }

  return {
    kind,
    sign: kind === "addition" ? "+" : kind === "deletion" ? "-" : " ",
    lineNumber,
    moveKind,
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
  tabWidth: number,
  moveKind?: DiffLineMoveKind,
  compactRuns?: CompactHighlightRun[],
) {
  // Same lazy-fallback strategy as split cells: only normalize raw text when no HAST or compact
  // syntax run is available, or the selected highlighter produced no spans.
  let spans: RenderSpan[];
  if (highlightedLine !== undefined) {
    spans = flattenHighlightedLine(
      highlightedLine,
      theme,
      wordDiffHighlightBg(kind, theme),
      tabWidth,
    );
  } else if (compactRuns !== undefined) {
    spans = flattenCompactHighlightedLine(
      rawLine,
      compactRuns,
      wordDiffHighlightBg(kind, theme),
      tabWidth,
    );
  } else {
    spans = [];
  }

  if (spans.length === 0) {
    const fallbackText = cleanDiffLine(rawLine, tabWidth);
    spans = fallbackText.length > 0 ? [{ text: fallbackText }] : [];
  }

  return {
    kind,
    sign: kind === "addition" ? "+" : kind === "deletion" ? "-" : " ",
    oldLineNumber,
    newLineNumber,
    moveKind,
    spans,
  } satisfies StackLineCell;
}

/** Describe one collapsed unchanged region in the diff stream. */
function collapsedRowText(lines: number) {
  return `${lines} unchanged ${lines === 1 ? "line" : "lines"}`;
}

/** Build the collapsed row one resolved gap address renders as. */
function collapsedGapRow(
  file: DiffFile,
  address: ReviewGapAddress,
  keyPrefix: string,
): Extract<DiffRow, { type: "collapsed" }> {
  return {
    type: "collapsed",
    key: `${file.id}:${keyPrefix}${address.position === "trailing" ? "trailing" : address.hunkIndex}`,
    fileId: file.id,
    hunkIndex: address.hunkIndex,
    text: collapsedRowText(address.lineCount),
    position: address.position,
    oldRange: [...address.oldRange] as [number, number],
    newRange: [...address.newRange] as [number, number],
  };
}

/** Prepare syntax highlighting for one language/theme pair using Pierre's shared highlighter. */
async function prepareHighlighter(language: string | undefined, theme: HighlightThemeInput) {
  const resolvedLanguage = language ?? "text";
  const syntaxTheme = ensureSyntaxHighlightThemeRegistered(theme);
  const cacheKey = `${syntaxTheme}:${resolvedLanguage}`;
  const options =
    highlighterOptionsByKey.get(cacheKey) ??
    getHighlighterOptions(resolvedLanguage, {
      theme: syntaxTheme,
    });

  if (!highlighterOptionsByKey.has(cacheKey)) {
    highlighterOptionsByKey.set(cacheKey, options);
  }

  return getSharedHighlighter({
    ...options,
    preferredHighlighter: "shiki-wasm",
  });
}

/** Queue highlight rendering so startup work stays serialized without starving input/render timers. */
function queueHighlightedWork<T>(run: () => T) {
  const queued = queuedHighlightWork.then(
    () =>
      new Promise<T>((resolve, reject) => {
        // Highlighting is CPU-heavy background work. Scheduling each serialized job as a timer,
        // rather than a microtask, yields back to OpenTUI input and frame timers between files.
        setTimeout(() => {
          try {
            resolve(run());
          } catch (error) {
            reject(error);
          }
        }, 0);
      }),
  );

  queuedHighlightWork = queued.then(
    () => undefined,
    () => undefined,
  );

  return queued;
}

/** Normalize source text the same way expanded-row slicing does before highlighting. */
function normalizeSourceText(text: string) {
  return text.replaceAll("\r\n", "\n");
}

/** Build Pierre file contents for a full-source highlight request. */
function sourceFileContents(file: DiffFile, text: string, language: string | undefined) {
  const contents: FileContents = {
    name: file.path,
    contents: normalizeSourceText(text),
    cacheKey: `${file.id}:${file.path}:${language ?? ""}:${text.length}`,
  };

  if (language) {
    contents.lang = language as FileContents["lang"];
  }

  return contents;
}

/** Load and validate authoritative source snapshots for one partial diff when available. */
async function loadSourceBackedHighlightPlan(file: DiffFile) {
  if (!file.metadata.isPartial || !file.sourceFetcher || file.metadata.hunks.length === 0) {
    return null;
  }

  try {
    const [oldText, newText] = await Promise.all([
      file.sourceFetcher.getFullText("old"),
      file.sourceFetcher.getFullText("new"),
    ]);
    return createSourceBackedHighlightPlan(file.metadata, oldText, newText);
  } catch {
    // Full-source highlighting is an enhancement over the patch-only path. Source races,
    // unavailable sides, and size limits must fall back without hiding the visible diff.
    return null;
  }
}

/** Convert Pierre output into partial-diff line indexes without losing side-specific grammar state. */
function finalizeHighlightedDiff(
  file: DiffFile,
  sourcePlan: SourceBackedHighlightPlan | null,
  highlighted: { code: { deletionLines: unknown[]; additionLines: unknown[] } },
): HighlightedDiffCode {
  const code = {
    deletionLines: highlighted.code.deletionLines as Array<HastNode | undefined>,
    additionLines: highlighted.code.additionLines as Array<HastNode | undefined>,
  };

  // Full old/new sources can put identical context text in different lexical states. Preserve
  // those authoritative per-side nodes; aliasing remains safe only for patch-fragment highlighting.
  return sourcePlan
    ? remapSourceBackedHighlight(sourcePlan, code)
    : aliasContextHighlightLines(file.metadata, code);
}

/** Render one metadata snapshot through an already prepared highlighter. */
function renderHighlightedDiff(
  file: DiffFile,
  metadata: FileDiffMetadata,
  highlighter: Awaited<ReturnType<typeof prepareHighlighter>>,
  theme: HighlightThemeInput,
  sourcePlan: SourceBackedHighlightPlan | null,
) {
  return queueHighlightedWork(() => {
    const highlighted = renderDiffWithHighlighter(
      metadata,
      highlighter,
      pierreRenderOptions(theme),
    );
    return finalizeHighlightedDiff(file, sourcePlan, highlighted);
  });
}

/**
 * Largest diff, in lines across both sides, that is worth syntax highlighting.
 *
 * Past this size the work stops paying for itself twice over: the job occupies the serialized
 * highlight queue for seconds while nothing else can be colorized, and the result is too large for
 * the shared cache to hold beside the files around it, so it evicts its neighbors and is evicted
 * back on the next scroll. Diffs this big are generated output — lockfiles, snapshots, vendored
 * bundles — where color earns little. They render as plain rows instead, immediately.
 *
 * Keep this at or below the cache budget in `highlightedDiffCache.ts`; that is what guarantees no
 * single entry can push the rest of the working set out.
 */
const MAX_HIGHLIGHTED_DIFF_LINES = 10_000;

/** Shared plain-rows result. Read-only, so one instance can back every skipped file. */
const UNHIGHLIGHTED_DIFF: HighlightedDiffCode = Object.freeze({
  deletionLines: [],
  additionLines: [],
});

/** Count the diff lines one file retains when highlighted, across both sides. */
export function highlightedDiffLineCount(metadata: FileDiffMetadata) {
  return (metadata.deletionLines?.length ?? 0) + (metadata.additionLines?.length ?? 0);
}

/** Return whether one metadata snapshot is small enough that highlighting it is worth the work. */
function shouldHighlightMetadata(metadata: FileDiffMetadata) {
  return highlightedDiffLineCount(metadata) <= MAX_HIGHLIGHTED_DIFF_LINES;
}

/** Return whether one file's diff is small enough that highlighting it is worth the work. */
export function shouldHighlightDiff(file: DiffFile) {
  return shouldHighlightMetadata(file.metadata);
}

/** Return whether this interactive diff can use the bundled-theme worker path. */
export function shouldOffloadHighlight(
  metadata: FileDiffMetadata,
  theme: HighlightThemeInput,
  options: LoadHighlightedDiffOptions,
) {
  return (
    options.offloadLargeDiff === true &&
    supportsHighlightWorkerOffload() &&
    typeof theme !== "string" &&
    Object.keys(theme.syntaxScopeOverrides ?? {}).length === 0 &&
    shouldHighlightMetadata(metadata) &&
    Math.max(metadata.deletionLines.length, metadata.additionLines.length) >=
      HIGHLIGHT_WORKER_MIN_LINES
  );
}

/** Return terminal-projected source lengths for compact UTF-16 range validation. */
function compactHighlightLineLengths(metadata: FileDiffMetadata) {
  return {
    deletion: metadata.deletionLines.map((line) => cleanLastNewline(line).length),
    addition: metadata.additionLines.map((line) => cleanLastNewline(line).length),
  };
}

/** Highlight one eligible metadata snapshot off the terminal event loop. */
async function loadWorkerHighlightedDiff(
  file: DiffFile,
  metadata: FileDiffMetadata,
  theme: AppTheme,
  sourcePlan: SourceBackedHighlightPlan | null,
) {
  const aliasContext = sourcePlan === null;
  const language = file.language ?? "text";
  const syntaxTheme = syntaxHighlightThemeName(theme);
  const payload = await highlightDiffInWorker({
    aliasContext,
    appearance: theme.appearance,
    language,
    metadata,
    theme: syntaxTheme,
  });
  validateCompactHighlightedDiff(payload, compactHighlightLineLengths(metadata));

  return {
    deletionLines: [],
    additionLines: [],
    compact: {
      payload,
      deletionLineMap: sourcePlan?.deletionLineMap,
      additionLineMap: sourcePlan?.additionLineMap,
    },
  } satisfies HighlightedDiffCode;
}

/** Highlight a diff file and return just the rendered line trees the UI needs. */
export async function loadHighlightedDiff(
  file: DiffFile,
  theme: HighlightThemeInput = "dark",
  options: LoadHighlightedDiffOptions = {},
): Promise<HighlightedDiffCode> {
  // Checked before the source read so an oversized file costs neither I/O nor queue time.
  if (!shouldHighlightDiff(file)) {
    return UNHIGHLIGHTED_DIFF;
  }

  const sourcePlan = await loadSourceBackedHighlightPlan(file);
  // A source graft includes every line before the visible hunk. Keep its work bounded, but fall
  // back to the already-eligible patch fragment instead of blanking a small review diff.
  const highlightSourcePlan =
    sourcePlan && shouldHighlightMetadata(sourcePlan.metadata) ? sourcePlan : null;
  const metadata = highlightSourcePlan?.metadata ?? file.metadata;

  if (typeof theme !== "string" && shouldOffloadHighlight(metadata, theme, options)) {
    try {
      return await loadWorkerHighlightedDiff(file, metadata, theme, highlightSourcePlan);
    } catch {
      // Do not repeat a multi-second highlight on the event loop after a worker failure. Render
      // plain rows now, but leave a later file visit free to retry a recreated worker.
      return { deletionLines: [], additionLines: [], retryable: true };
    }
  }

  try {
    const highlighter = await prepareHighlighter(file.language, theme);
    try {
      return await renderHighlightedDiff(file, metadata, highlighter, theme, highlightSourcePlan);
    } catch (error) {
      if (!highlightSourcePlan) {
        throw error;
      }

      // A validated source graft should render like ordinary complete-file metadata. If Pierre
      // still rejects it, preserve the pre-existing patch-fragment behavior rather than blanking it.
      return await renderHighlightedDiff(file, file.metadata, highlighter, theme, null);
    }
  } catch {
    const fallbackTheme = highlightThemeAppearance(theme);
    const highlighter = await prepareHighlighter("text", fallbackTheme);
    return await renderHighlightedDiff(
      file,
      { ...file.metadata, lang: "text" },
      highlighter,
      fallbackTheme,
      null,
    );
  }
}

/** Highlight a full source file for unchanged lines synthesized during gap expansion. */
export async function loadHighlightedSourceLines({
  file,
  text,
  theme = "dark",
}: {
  file: DiffFile;
  text: string;
  theme?: HighlightThemeInput;
}): Promise<HighlightedSourceCode> {
  try {
    const highlighter = await prepareHighlighter(file.language, theme);
    return queueHighlightedWork(() => {
      const highlighted = renderFileWithHighlighter(
        sourceFileContents(file, text, file.language),
        highlighter,
        pierreRenderOptions(theme),
      );
      return {
        lines: highlighted.code as Array<HastNode | undefined>,
      };
    });
  } catch {
    const fallbackTheme = highlightThemeAppearance(theme);
    const highlighter = await prepareHighlighter("text", fallbackTheme);
    return queueHighlightedWork(() => {
      const highlighted = renderFileWithHighlighter(
        sourceFileContents(file, text, "text"),
        highlighter,
        pierreRenderOptions(fallbackTheme),
      );
      return {
        lines: highlighted.code as Array<HastNode | undefined>,
      };
    });
  }
}

/** Convert one highlighted full-source line into the spans used by expanded context rows. */
export function spansForHighlightedSourceLine(
  rawLine: string | undefined,
  highlightedLine: HastNode | undefined,
  theme: AppTheme,
  tabWidth = DEFAULT_TAB_WIDTH,
): RenderSpan[] {
  if (highlightedLine === undefined) {
    const fallbackText = cleanDiffLine(rawLine, tabWidth);
    return fallbackText.length > 0 ? [{ text: fallbackText }] : [];
  }

  const spans = flattenHighlightedLine(highlightedLine, theme, theme.contextContentBg, tabWidth);
  if (spans.length > 0) {
    return spans;
  }

  const fallbackText = cleanDiffLine(rawLine, tabWidth);
  return fallbackText.length > 0 ? [{ text: fallbackText }] : [];
}

/** Expand Pierre metadata into the flat split-view row stream consumed by the renderer. */
export function buildSplitRows(
  file: DiffFile,
  highlighted: HighlightedDiffCode | null,
  theme: AppTheme,
  tabWidth = DEFAULT_TAB_WIDTH,
): DiffRow[] {
  const rows: DiffRow[] = [];
  const deletionLines = highlighted?.deletionLines ?? [];
  const additionLines = highlighted?.additionLines ?? [];

  for (const [hunkIndex, hunk] of file.metadata.hunks.entries()) {
    const leadingGap = reviewLeadingGap(file.metadata, hunkIndex);
    if (leadingGap) {
      rows.push(collapsedGapRow(file, leadingGap, "collapsed:"));
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
              tabWidth,
              undefined,
              compactRunsForHighlightedLine(highlighted, "deletion", deletionLineIndex + offset),
            ),
            right: makeSplitCell(
              "context",
              additionLineNumber + offset,
              file.metadata.additionLines[additionLineIndex + offset],
              additionLines[additionLineIndex + offset],
              theme,
              tabWidth,
              undefined,
              compactRunsForHighlightedLine(highlighted, "addition", additionLineIndex + offset),
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
                tabWidth,
                file.lineMoveKinds?.deletionLines[deletionLineIndex + offset],
                compactRunsForHighlightedLine(highlighted, "deletion", deletionLineIndex + offset),
              )
            : makeSplitCell("empty", undefined, undefined, undefined, theme, tabWidth),
          right: hasAddition
            ? makeSplitCell(
                "addition",
                additionLineNumber + offset,
                file.metadata.additionLines[additionLineIndex + offset],
                additionLines[additionLineIndex + offset],
                theme,
                tabWidth,
                file.lineMoveKinds?.additionLines[additionLineIndex + offset],
                compactRunsForHighlightedLine(highlighted, "addition", additionLineIndex + offset),
              )
            : makeSplitCell("empty", undefined, undefined, undefined, theme, tabWidth),
        });
      }

      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
    }
  }

  const trailingGap = reviewTrailingGap(file.metadata);
  if (trailingGap) {
    rows.push(collapsedGapRow(file, trailingGap, "collapsed:"));
  }

  return rows;
}

/** Expand Pierre metadata into the flat stack-view row stream consumed by the renderer. */
export function buildStackRows(
  file: DiffFile,
  highlighted: HighlightedDiffCode | null,
  theme: AppTheme,
  tabWidth = DEFAULT_TAB_WIDTH,
): DiffRow[] {
  const rows: DiffRow[] = [];
  const deletionLines = highlighted?.deletionLines ?? [];
  const additionLines = highlighted?.additionLines ?? [];

  for (const [hunkIndex, hunk] of file.metadata.hunks.entries()) {
    const leadingGap = reviewLeadingGap(file.metadata, hunkIndex);
    if (leadingGap) {
      rows.push(collapsedGapRow(file, leadingGap, "stack:collapsed:"));
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
              tabWidth,
              undefined,
              compactRunsForHighlightedLine(highlighted, "addition", additionLineIndex + offset),
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
            tabWidth,
            file.lineMoveKinds?.deletionLines[deletionLineIndex + offset],
            compactRunsForHighlightedLine(highlighted, "deletion", deletionLineIndex + offset),
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
            tabWidth,
            file.lineMoveKinds?.additionLines[additionLineIndex + offset],
            compactRunsForHighlightedLine(highlighted, "addition", additionLineIndex + offset),
          ),
        });
      }

      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
    }
  }

  const trailingGap = reviewTrailingGap(file.metadata);
  if (trailingGap) {
    rows.push(collapsedGapRow(file, trailingGap, "stack:collapsed:"));
  }

  return rows;
}
