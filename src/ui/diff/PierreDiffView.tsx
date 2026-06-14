import { useRenderer } from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import type { DiffFile, LayoutMode, UserNoteLineTarget } from "../../core/types";
import { AgentInlineNote } from "../components/panes/AgentInlineNote";
import type { VisibleAgentNote } from "../lib/agentAnnotations";
import type { CopySelectedRowRange } from "../components/panes/copySelection";
import type { DiffSectionGeometry } from "./diffSectionGeometry";
import { reviewRowId } from "../lib/ids";
import type { AppTheme } from "../themes";
import { type FileSourceStatus } from "./expandCollapsedRows";
import { spansForHighlightedSourceLine, type DiffRow } from "./pierre";
import { plannedReviewRowVisible } from "./plannedReviewRows";
import { buildDiffSectionRowPlan } from "./diffSectionRowPlan";
import { resolveVisiblePlannedRowWindow, type VisibleBodyBounds } from "./rowWindowing";
import { diffMessage, DiffRowView, fitText } from "./renderRows";
import { useHighlightedDiff } from "./useHighlightedDiff";
import { useHighlightedSource } from "./useHighlightedSource";

const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];
const EMPTY_EXPANDED_GAP_KEYS: ReadonlySet<string> = new Set();
const ADD_NOTE_IDLE_HIDE_DELAY_MS = 2000;

export interface ActiveAddNoteAffordance {
  hunkIndex: number;
  target?: UserNoteLineTarget;
}

type AddNoteTargetRow = Extract<DiffRow, { type: "split-line" | "stack-line" }>;

/** Return whether a diff row can be used as an inline user-note target. */
function isAddNoteTargetRow(row: DiffRow): row is AddNoteTargetRow {
  return row.type === "split-line" || row.type === "stack-line";
}

/** Resolve the note insertion target represented by a visible add-note affordance. */
function addNoteAffordanceForRow(row: AddNoteTargetRow): ActiveAddNoteAffordance {
  if (row.type === "split-line") {
    return {
      hunkIndex: row.hunkIndex,
      target:
        row.right.lineNumber !== undefined
          ? { side: "new", line: row.right.lineNumber }
          : row.left.lineNumber !== undefined
            ? { side: "old", line: row.left.lineNumber }
            : undefined,
    };
  }

  return {
    hunkIndex: row.hunkIndex,
    target:
      row.cell.newLineNumber !== undefined
        ? { side: "new", line: row.cell.newLineNumber }
        : row.cell.oldLineNumber !== undefined
          ? { side: "old", line: row.cell.oldLineNumber }
          : undefined,
  };
}

interface PierreDiffViewProps {
  codeHorizontalOffset?: number;
  copySelectedRowRanges?: Map<string, CopySelectedRowRange>;
  copySelectedSide?: "left" | "right";
  expandedGapKeys?: ReadonlySet<string>;
  file: DiffFile | undefined;
  layout: Exclude<LayoutMode, "auto">;
  onHover?: () => void;
  onActiveAddNoteAffordanceChange?: (affordance: ActiveAddNoteAffordance | null) => void;
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void;
  onToggleGap?: (gapKey: string) => void;
  showLineNumbers?: boolean;
  showHunkHeaders?: boolean;
  sourceStatus?: FileSourceStatus | undefined;
  wrapLines?: boolean;
  theme: AppTheme;
  visibleAgentNotes?: VisibleAgentNote[];
  hoverActive?: boolean;
  hoverClearSignal?: number;
  width: number;
  selectedHunkIndex: number;
  sectionGeometry?: DiffSectionGeometry;
  shouldLoadHighlight?: boolean;
  scrollable?: boolean;
  visibleBodyBounds?: VisibleBodyBounds;
}

/** Render a file diff in split or stack mode, with inline agent notes inserted between diff rows. */
export function PierreDiffView(props: PierreDiffViewProps) {
  const codeHorizontalOffset = () => props.codeHorizontalOffset ?? 0;
  const expandedGapKeys = () => props.expandedGapKeys ?? EMPTY_EXPANDED_GAP_KEYS;
  const showLineNumbers = () => props.showLineNumbers ?? true;
  const showHunkHeaders = () => props.showHunkHeaders ?? true;
  const wrapLines = () => props.wrapLines ?? false;
  const visibleAgentNotes = () => props.visibleAgentNotes ?? EMPTY_VISIBLE_AGENT_NOTES;
  const hoverActive = () => props.hoverActive ?? true;
  const hoverClearSignal = () => props.hoverClearSignal ?? 0;
  const shouldLoadHighlight = () => props.shouldLoadHighlight ?? true;
  const scrollable = () => props.scrollable ?? true;

  const renderer = useRenderer();
  const [hoveredRowKey, setHoveredRowKey] = createSignal<string | null>(null);
  const hoverIdleTimeoutRef: { current: ReturnType<typeof setTimeout> | null } = {
    current: null,
  };
  const previousHoverClearSignalRef: { current: number } = { current: hoverClearSignal() };

  const clearHoverIdleTimeout = () => {
    if (hoverIdleTimeoutRef.current) {
      clearTimeout(hoverIdleTimeoutRef.current);
      hoverIdleTimeoutRef.current = null;
    }
  };

  const clearHoveredRow = () => {
    clearHoverIdleTimeout();
    setHoveredRowKey(null);
    props.onActiveAddNoteAffordanceChange?.(null);
  };

  const activateHoveredRow = (rowKey: string, affordance: ActiveAddNoteAffordance) => {
    setHoveredRowKey(rowKey);
    props.onActiveAddNoteAffordanceChange?.(affordance);
    clearHoverIdleTimeout();
    hoverIdleTimeoutRef.current = setTimeout(() => {
      setHoveredRowKey((current) => (current === rowKey ? null : current));
      props.onActiveAddNoteAffordanceChange?.(null);
      hoverIdleTimeoutRef.current = null;
    }, ADD_NOTE_IDLE_HIDE_DELAY_MS);
  };

  createEffect(() => {
    if (!hoverActive()) {
      clearHoveredRow();
    }
  });

  createEffect(() => {
    if (previousHoverClearSignalRef.current === hoverClearSignal()) {
      return;
    }

    previousHoverClearSignalRef.current = hoverClearSignal();
    clearHoveredRow();
  });

  /** Hide hover-only affordances when terminal focus leaves Hunk. */
  createEffect(() => {
    renderer.on("blur", clearHoveredRow);
    onCleanup(() => {
      renderer.off("blur", clearHoveredRow);
    });
  });

  onCleanup(clearHoverIdleTimeout);

  const resolvedHighlighted = useHighlightedDiff({
    file: () => props.file,
    appearance: () => props.theme.appearance,
    shouldLoadHighlight,
  });
  const sourceTextForHighlight = () =>
    props.sourceStatus?.kind === "loaded" && expandedGapKeys().size > 0
      ? props.sourceStatus.text
      : undefined;
  const resolvedHighlightedSource = useHighlightedSource({
    file: () => props.file,
    text: sourceTextForHighlight,
    appearance: () => props.theme.appearance,
    shouldLoadHighlight: () => shouldLoadHighlight() && expandedGapKeys().size > 0,
  });
  const sourceLineSpans = (line: string | undefined, sourceLineNumber: number) =>
    spansForHighlightedSourceLine(
      line,
      resolvedHighlightedSource()?.lines[sourceLineNumber],
      props.theme,
    );

  const sectionRowPlan = createMemo(() =>
    buildDiffSectionRowPlan({
      expandedKeys: expandedGapKeys(),
      file: props.file,
      highlightedDiff: resolvedHighlighted(),
      layout: props.layout,
      showHunkHeaders: showHunkHeaders(),
      sourceLineSpans,
      sourceStatus: props.sourceStatus,
      theme: props.theme,
      visibleAgentNotes: visibleAgentNotes(),
    }),
  );
  const plannedRows = () => sectionRowPlan().plannedRows;
  const lineNumberDigits = () => sectionRowPlan().lineNumberDigits;
  const fileHasSourceFetcher = () => Boolean(props.file?.sourceFetcher);

  // Stable wrappers around the unstable upstream handlers. Presence/absence still mirrors the
  // incoming props so rows keep hiding affordances when the handlers are not provided.
  const stableToggleGap = (gapKey: string) => props.onToggleGap?.(gapKey);
  const gapToggleHandler = () =>
    fileHasSourceFetcher() && props.onToggleGap ? stableToggleGap : undefined;
  const stableStartUserNoteAtHunk = (hunkIndex: number, target?: UserNoteLineTarget) =>
    props.onStartUserNoteAtHunk?.(hunkIndex, target);
  const startUserNoteAtHunkHandler = () =>
    props.onStartUserNoteAtHunk ? stableStartUserNoteAtHunk : undefined;

  // Precompute each hoverable row's note-insertion target so the shared hover callback can stay
  // identity-stable and look targets up by row key instead of closing over per-row state.
  // Keyed by the DiffRow key (not the planned-row key) because that is what DiffRowView reports
  // back through onHoverRow.
  const addNoteAffordanceByRowKey = createMemo(() => {
    const next = new Map<string, ActiveAddNoteAffordance>();
    for (const plannedRow of plannedRows()) {
      if (plannedRow.kind === "diff-row" && isAddNoteTargetRow(plannedRow.row)) {
        next.set(plannedRow.row.key, addNoteAffordanceForRow(plannedRow.row));
      }
    }
    return next;
  });

  /** One shared hover handler for every diff row; DiffRowView passes the hovered row's key. */
  const handleHoverRow = (rowKey: string) => {
    props.onHover?.();
    const affordance = addNoteAffordanceByRowKey().get(rowKey);
    if (affordance) {
      activateHoveredRow(rowKey, affordance);
    } else {
      clearHoveredRow();
    }
  };
  const visiblePlannedRowWindow = createMemo(() => {
    // Fall back to the full row list unless all three row-windowing inputs are ready:
    // - the complete planned row stream for this file
    // - measured per-row geometry for that same stream
    // - one file-local visible body slice from DiffPane
    // The helper relies on those structures staying in lockstep, so any missing input means
    // "render everything" instead of risking a mismatched partial slice.
    if (!props.sectionGeometry || !props.visibleBodyBounds) {
      return {
        bottomSpacerHeight: 0,
        plannedRows: plannedRows(),
        topSpacerHeight: 0,
      };
    }

    // `visibleBodyBounds` is already relative to this file body, not the whole review stream.
    // Example: if DiffPane says "mount rows 120..260 within package-lock.json", this helper keeps
    // only the planned rows whose measured bounds overlap that interval.
    //
    // The return value is not just the sliced rows. It also includes spacer heights for the skipped
    // region above and below so the file still occupies its original total body height inside the
    // scroll stream. That lets navigation, sticky headers, and reveal math keep using the same
    // absolute geometry even though most rows are temporarily unmounted.
    return resolveVisiblePlannedRowWindow({
      plannedRows: plannedRows(),
      sectionGeometry: props.sectionGeometry,
      visibleBodyBounds: props.visibleBodyBounds,
    });
  });

  /** Shared body content for both scrollable and inline (non-scrollable) layouts. */
  const content = () => (
    <box style={{ width: "100%", flexDirection: "column" }}>
      <Show when={visiblePlannedRowWindow().topSpacerHeight > 0}>
        {/* Reserve the skipped height above the mounted slice so the file body keeps its original
            absolute row positions inside the larger review stream. */}
        <box
          style={{
            width: "100%",
            height: visiblePlannedRowWindow().topSpacerHeight,
            backgroundColor: props.theme.panel,
          }}
        />
      </Show>
      <For each={visiblePlannedRowWindow().plannedRows}>
        {(plannedRow) => {
          // Mirror the same visibility/id decisions used by the scroll-bound helpers so the mounted
          // tree can be measured by hunk later.
          const rowId = reviewRowId(plannedRow.key);
          const visible = plannedReviewRowVisible(plannedRow, {
            showHunkHeaders: showHunkHeaders(),
            layout: props.layout,
            width: props.width,
          });

          return (
            <Show when={visible}>
              <Switch>
                <Match when={plannedRow.kind === "inline-note" ? plannedRow : undefined}>
                  {(inlineNote) => (
                    <box
                      id={rowId}
                      style={{ width: "100%", flexDirection: "column" }}
                      onMouseOver={clearHoveredRow}
                    >
                      <AgentInlineNote
                        annotation={inlineNote().annotation}
                        anchorSide={inlineNote().anchorSide}
                        draft={inlineNote().note.draft}
                        file={props.file}
                        layout={props.layout}
                        noteCount={inlineNote().noteCount}
                        noteIndex={inlineNote().noteIndex}
                        onClose={inlineNote().note.onRemove}
                        theme={props.theme}
                        width={props.width}
                      />
                    </box>
                  )}
                </Match>
                <Match when={plannedRow.kind === "diff-row" ? plannedRow : undefined}>
                  {(diffRow) => (
                    <box id={rowId} style={{ width: "100%", flexDirection: "column" }}>
                      <DiffRowView
                        row={diffRow().row}
                        width={props.width}
                        lineNumberDigits={lineNumberDigits()}
                        showLineNumbers={showLineNumbers()}
                        showHunkHeaders={showHunkHeaders()}
                        wrapLines={wrapLines()}
                        codeHorizontalOffset={codeHorizontalOffset()}
                        theme={props.theme}
                        selected={diffRow().row.hunkIndex === props.selectedHunkIndex}
                        copySelectedRowRange={props.copySelectedRowRanges?.get(diffRow().key)}
                        copySelectedSide={props.copySelectedSide}
                        anchorId={diffRow().anchorId}
                        noteGuideSide={diffRow().noteGuideSide}
                        showAddNoteBadge={
                          startUserNoteAtHunkHandler() !== undefined &&
                          hoveredRowKey() === diffRow().row.key &&
                          addNoteAffordanceByRowKey().has(diffRow().row.key)
                        }
                        onHoverRow={handleHoverRow}
                        onStartUserNoteAtHunk={startUserNoteAtHunkHandler()}
                        onToggleGap={gapToggleHandler()}
                      />
                    </box>
                  )}
                </Match>
              </Switch>
            </Show>
          );
        }}
      </For>
      <Show when={visiblePlannedRowWindow().bottomSpacerHeight > 0}>
        {/* Mirror that reservation below the mounted slice so total file-body height stays stable. */}
        <box
          style={{
            width: "100%",
            height: visiblePlannedRowWindow().bottomSpacerHeight,
            backgroundColor: props.theme.panel,
          }}
        />
      </Show>
    </box>
  );

  return (
    <Show
      when={props.file}
      fallback={
        <box style={{ width: "100%", paddingLeft: 1, paddingRight: 1 }}>
          <text fg={props.theme.muted}>
            {fitText("No file selected.", Math.max(1, props.width - 2))}
          </text>
        </box>
      }
    >
      {(file) => (
        <Show
          when={file().metadata.hunks.length > 0}
          fallback={
            <box style={{ width: "100%", paddingLeft: 1, paddingRight: 1, paddingBottom: 1 }}>
              <text fg={props.theme.muted}>
                {fitText(diffMessage(file()), Math.max(1, props.width - 2))}
              </text>
            </box>
          }
        >
          <Show when={scrollable()} fallback={content()}>
            <scrollbox
              width="100%"
              height="100%"
              scrollY={true}
              viewportCulling={true}
              focused={false}
            >
              {content()}
            </scrollbox>
          </Show>
        </Show>
      )}
    </Show>
  );
}
