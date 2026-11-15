/**
 * The renderer-free review session host as a navigation conformance consumer.
 *
 * A headless review and the terminal both plan canonical moves and repair stale selections
 * through `ReviewSessionHost`, so this adapter drives the host itself: the fixture's annotated
 * hunks become real sidecar annotations on the diff files, the host derives its own annotation
 * index from them, the fixture's stored selection is repaired by `repairSelection`, and moves go
 * through `moveSelection`. A host that re-derived either rule would disagree with the corpus.
 */
import type { AgentAnnotation } from "../../../packages/hunk/src/extension-api/types";
import type { ReviewAction } from "../../../packages/hunk/src/core/review/actions";
import { ReviewSessionHost } from "../../../packages/hunk/src/app/review/reviewSessionHost";
import { reviewDefaultHunkLineTarget } from "../../../packages/hunk/src/core/review/geometry";
import { selectRevealTarget } from "../../../packages/hunk/src/core/review/selectors";
import type { ReviewState } from "../../../packages/hunk/src/core/review/state";
import { createTestDiffFile } from "../../helpers/diff-helpers";
import { toConformanceSelection, toSemanticSelection } from "./intentPlanner";
import type { ReviewNavigationConsumer, ReviewNavigationFixture } from "../types";

/** Build the fixture's files with one sidecar annotation on each annotated hunk. */
function buildAnnotatedFiles(fixture: ReviewNavigationFixture) {
  return fixture.build().map((file, fileIndex) => {
    const hunkIndexes = fixture.annotatedHunks?.[fileIndex];
    if (!hunkIndexes || hunkIndexes.length === 0) return file;
    const annotations: AgentAnnotation[] = hunkIndexes.map((hunkIndex) => {
      const target = reviewDefaultHunkLineTarget(file.metadata.hunks[hunkIndex]!);
      const range: [number, number] = [target.line, target.line];
      return target.side === "new"
        ? { newRange: range, summary: `note ${hunkIndex}` }
        : { oldRange: range, summary: `note ${hunkIndex}` };
    });
    return { ...file, agent: { path: file.path, annotations } };
  });
}

/**
 * Create a host over the fixture with its filter and one repaired selection.
 *
 * Positions the host cannot store directly arrive the way a live review produces them: a
 * selection on a file the document lost comes from a reload that dropped that file, and an
 * empty selection from a review that started with no files.
 */
function hostAt(
  fixture: ReviewNavigationFixture,
  selection: ReviewNavigationFixture["selections"][number],
) {
  const files = buildAnnotatedFiles(fixture);
  if (selection.file === null || selection.file === "vanished") {
    const vanished = createTestDiffFile({ id: "vanished", path: "vanished.ts" });
    const host = new ReviewSessionHost({
      files: selection.file === null ? [] : [...files, vanished],
    });
    if (fixture.filter) host.setFilter(fixture.filter);
    if (selection.file === "vanished") {
      host.store.dispatch({
        type: "selection/select",
        fileKey: host.fileKeyFor("vanished")!,
        hunkIndex: selection.hunkIndex,
      });
    }
    host.replaceFiles(files);
    return host;
  }

  const host = new ReviewSessionHost({ files });
  if (fixture.filter) host.setFilter(fixture.filter);
  // Store the fixture's position as written, stale or not, then let the host repair it.
  host.store.dispatch({
    type: "selection/select",
    ...toSemanticSelection(selection, host.getDocument()),
  } as ReviewAction);
  host.repairSelection();
  return host;
}

/** Recover the semantic reveal request from the counters the store published. */
function revealFromTransition(before: ReviewState, after: ReviewState) {
  return {
    anchor:
      after.reveal.fileTopToken !== before.reveal.fileTopToken
        ? ("file-top" as const)
        : after.reveal.hunkToken !== before.reveal.hunkToken
          ? ("hunk" as const)
          : ("none" as const),
    scrollToNote: after.reveal.scrollToNote,
  };
}

export const reviewSessionHostNavigationConsumer: ReviewNavigationConsumer = {
  name: "review session host",
  phase: "M1 step 3",
  project(fixture: ReviewNavigationFixture) {
    const base = new ReviewSessionHost({ files: buildAnnotatedFiles(fixture) });
    const document = base.getDocument();

    return {
      moves: fixture.moves.map((move) => {
        const host = hostAt(fixture, move.from);
        const before = host.getSnapshot();
        const outcome = host.moveSelection(move.scope, move.delta);
        if (!outcome) {
          return { to: null };
        }
        const after = host.getSnapshot();
        return {
          to: toConformanceSelection(after.selection.fileKey, after.selection.hunkIndex, document),
          reveal: revealFromTransition(before, after),
        };
      }),
      normalizedSelections: fixture.selections.map((input) => {
        const selection = hostAt(fixture, input).getSnapshot().selection;
        return toConformanceSelection(selection.fileKey, selection.hunkIndex, document);
      }),
      revealTargets: document.files.map((file, fileIndex) =>
        file.hunks.map(
          (_hunk, hunkIndex) =>
            selectRevealTarget({
              ...base.getSnapshot(),
              selection: toSemanticSelection({ file: fileIndex, hunkIndex }, document),
            }) ?? null,
        ),
      ),
    };
  },
};
