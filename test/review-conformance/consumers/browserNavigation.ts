/**
 * The browser page's navigation path as a navigation conformance consumer.
 *
 * The page never sees diff models or sidecar files: it receives the shared-state snapshot and
 * the document, and plans every move in its own store. So this adapter builds the review the way
 * a live session holds it — the fixture's annotated hunks as real sidecar annotations on a
 * `ReviewSessionHost` — materializes the real shared-state snapshot with the producer's own
 * `buildReviewSharedState`, and hands that to the page's `ClientReviewStore`: `adoptShared`
 * builds the annotation index from the snapshot's notes, `adopt` repairs the selection, and moves
 * go through `apply`. A page that re-derived either rule would disagree with the corpus.
 */
import type { AgentAnnotation } from "../../../packages/hunk/src/extension-api/types";
import { ReviewSessionHost } from "../../../packages/hunk/src/app/review/reviewSessionHost";
import {
  buildReviewPresentationDefaults,
  buildReviewSharedState,
} from "../../../packages/hunk/src/app/review/sharedState";
import { reviewDefaultHunkLineTarget } from "../../../packages/hunk/src/core/review/geometry";
import {
  selectNormalizedSelection,
  selectRevealTarget,
} from "../../../packages/hunk/src/core/review/selectors";
import type { ReviewState } from "../../../packages/hunk/src/core/review/state";
import type { ReviewDocumentV1 } from "../../../packages/hunk/src/core/review/types";
import { ClientReviewStore } from "../../../packages/hunk/src/web/store/clientReviewStore";
import type { ReviewApiClient } from "../../../packages/hunk/src/web/transport/apiClient";
import { createTestDiffFile } from "../../helpers/diff-helpers";
import { createTestReviewBootstrap } from "../../helpers/review-session-harness";
import { toConformanceSelection, toSemanticSelection } from "./intentPlanner";
import type {
  ConformanceSelectionInput,
  ReviewNavigationConsumer,
  ReviewNavigationFixture,
} from "../types";

/** Build the fixture's files with one sidecar annotation on each annotated hunk. */
function buildAnnotatedFiles(fixture: ReviewNavigationFixture) {
  return fixture.build().map((file, fileIndex) => {
    const hunkIndexes = fixture.annotatedHunks?.[fileIndex];
    if (!hunkIndexes || hunkIndexes.length === 0) {
      // A sidecar entry with no summary and no annotations still puts the file in the
      // annotated-file scope.
      return fixture.annotatedFiles?.includes(fileIndex)
        ? { ...file, agent: { path: file.path, annotations: [] } }
        : file;
    }
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

/** The page's store, never asked for a resource by these moves. */
function createTestPageStore() {
  return new ClientReviewStore({ client: {} as ReviewApiClient });
}

/**
 * The page's store at one fixture position, reached the way the page reaches it.
 *
 * A selection on a file the document lost arrives through a reload that dropped the file, and
 * an empty review is a document with no files; either way `adopt` repairs it.
 */
function pageStoreAt(
  fixture: ReviewNavigationFixture,
  input: ConformanceSelectionInput,
  shared: ReturnType<typeof buildReviewSharedState>,
  document: ReviewDocumentV1,
) {
  const store = createTestPageStore();
  store.adoptShared(shared);
  if (input.file === null) {
    // A review that started empty and then received its files.
    store.adopt({ files: [] }, undefined);
    store.adopt(document, undefined);
    return store;
  }
  if (input.file === "vanished") {
    const vanished = new ReviewSessionHost({
      files: [
        ...buildAnnotatedFiles(fixture),
        createTestDiffFile({ id: "vanished", path: "vanished.ts" }),
      ],
    }).getDocument();
    store.adopt(vanished, undefined);
    store.store.dispatch({
      type: "selection/select",
      fileKey: vanished.files[vanished.files.length - 1]!.key,
      hunkIndex: input.hunkIndex,
    });
    store.adopt(document, undefined);
    return store;
  }
  store.adopt(document, undefined);
  store.store.dispatch({
    type: "selection/select",
    ...(toSemanticSelection(input, document) as { fileKey: string; hunkIndex: number }),
  });
  return store;
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

export const browserNavigationConsumer: ReviewNavigationConsumer = {
  name: "browser page store",
  phase: "M4 state",
  project(fixture: ReviewNavigationFixture) {
    const files = buildAnnotatedFiles(fixture);
    const host = new ReviewSessionHost({ files });
    if (fixture.filter) host.setFilter(fixture.filter);
    const document = host.getDocument();
    const shared = buildReviewSharedState(host, {
      generation: "conformance",
      presentation: buildReviewPresentationDefaults(createTestReviewBootstrap(files)),
    });

    return {
      moves: fixture.moves.map((move) => {
        const store = pageStoreAt(fixture, move.from, shared, document);
        const before = store.store.getSnapshot();
        store.apply({ type: "selection/move", scope: move.scope, delta: move.delta });
        const after = store.store.getSnapshot();
        if (after === before) {
          return { to: null };
        }
        return {
          to: toConformanceSelection(after.selection.fileKey, after.selection.hunkIndex, document),
          reveal: revealFromTransition(before, after),
        };
      }),
      normalizedSelections: fixture.selections.map((input) => {
        const state = pageStoreAt(fixture, input, shared, document).store.getSnapshot();
        const selection = selectNormalizedSelection(state);
        return toConformanceSelection(selection.fileKey, selection.hunkIndex, document);
      }),
      revealTargets: document.files.map((file, fileIndex) =>
        file.hunks.map(
          (_hunk, hunkIndex) =>
            selectRevealTarget({
              document,
              selection: toSemanticSelection({ file: fileIndex, hunkIndex }, document),
            }) ?? null,
        ),
      ),
    };
  },
};
