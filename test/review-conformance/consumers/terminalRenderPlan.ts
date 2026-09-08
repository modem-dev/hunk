/**
 * The terminal's render planning as a conformance consumer.
 *
 * Every value here is read back out of what the terminal would actually draw — planned
 * rows, the note target a session command resolves, the message the diff pane prints —
 * rather than by calling the shared primitives again. That is the point: if the row
 * builder ever re-derives a gap range or a note target on its own, this adapter reports
 * the divergence.
 */
import { resolveCommentTarget } from "../../../packages/hunk/src/core/liveComments";
import { reviewGapId } from "../../../packages/hunk/src/core/review/expansion";
import type { DiffFile } from "../../../packages/hunk/src/core/changeset/model";
import { buildDiffSectionRowPlan } from "../../../packages/hunk/src/ui/diff/diffSectionRowPlan";
import { DIFF_MESSAGES, diffMessage } from "../../../packages/hunk/src/ui/diff/plannedRowText";
import type { DiffRow } from "../../../packages/hunk/src/ui/diff/diffRows";
import { buildSelectedHunkSummary } from "../../../packages/hunk/src/ui/lib/reviewState";
import { resolveTheme } from "../../../packages/hunk/src/ui/themes";
import type {
  ConformanceExpandedRow,
  ConformanceGap,
  ConformanceHunkRanges,
  ReviewGeometryConsumer,
  ReviewGeometryFixture,
} from "../types";

const THEME = resolveTheme("github-dark-default", null);

/** Recover the shared reason from the wording the diff pane would print. */
function emptyDiffReasonOf(file: DiffFile) {
  const message = diffMessage(file);
  return Object.entries(DIFF_MESSAGES).find(([, text]) => text === message)?.[0];
}

/** Plan one file's rows exactly as the diff pane does. */
function planRows(file: DiffFile, expandedGapId?: string, sourceText?: string) {
  return buildDiffSectionRowPlan({
    file,
    layout: "split",
    showHunkHeaders: true,
    theme: THEME,
    ...(expandedGapId ? { expandedKeys: new Set([expandedGapId]) } : {}),
    ...(sourceText !== undefined
      ? { sourceStatus: { kind: "loaded" as const, text: sourceText } }
      : {}),
  }).plannedRows.flatMap((planned) => (planned.kind === "diff-row" ? [planned.row] : []));
}

/** Read the gaps the terminal drew, in the order it drew them. */
function gapsOf(rows: DiffRow[]): ConformanceGap[] {
  return rows.flatMap((row) =>
    row.type === "collapsed"
      ? [
          {
            gapId: reviewGapId(row.position, row.hunkIndex),
            oldRange: [...row.oldRange] as [number, number],
            newRange: [...row.newRange] as [number, number],
            lineCount: row.oldRange[1] - row.oldRange[0] + 1,
          },
        ]
      : [],
  );
}

/** Read the synthesized rows an expanded gap added, with the labels beside them. */
function expandedRowsOf(rows: DiffRow[], gapId: string): ConformanceExpandedRow[] {
  return rows.flatMap((row) =>
    row.type === "split-line" && row.isExpansionRow && row.expandedGapKey === gapId
      ? [
          {
            oldLine: row.left.lineNumber ?? 0,
            newLine: row.right.lineNumber ?? 0,
            text: row.left.spans.map((span) => span.text).join(""),
          },
        ]
      : [],
  );
}

/** Read the per-hunk extents the session snapshot reports for one file. */
function hunkRangesOf(file: DiffFile): ConformanceHunkRanges[] {
  return file.metadata.hunks.map((_hunk, index) => {
    const summary = buildSelectedHunkSummary(file, index);
    return {
      oldRange: summary.oldRange ?? [0, 0],
      newRange: summary.newRange ?? [0, 0],
    };
  });
}

export const terminalRenderPlanConsumer: ReviewGeometryConsumer = {
  name: "terminal render planning",
  phase: "Phase 1 PR 2",
  project(fixture: ReviewGeometryFixture) {
    const files = fixture.build();
    return {
      files: files.map((file, fileIndex) => {
        const expansion =
          fixture.expansion?.fileIndex === fileIndex ? fixture.expansion : undefined;
        const rows = planRows(file, expansion?.gapId, expansion?.sourceText);
        return {
          path: file.path,
          gaps: gapsOf(rows),
          hunkRanges: hunkRangesOf(file),
          defaultNoteTargets: file.metadata.hunks.map((_hunk, hunkIndex) => {
            const target = resolveCommentTarget(file, {
              filePath: file.path,
              hunkIndex,
              summary: "conformance",
            });
            return { side: target.side, line: target.line };
          }),
          ...(file.metadata.hunks.length === 0 ? { emptyDiffReason: emptyDiffReasonOf(file) } : {}),
          ...(expansion ? { expandedRows: expandedRowsOf(rows, expansion.gapId) } : {}),
        };
      }),
    };
  },
};
