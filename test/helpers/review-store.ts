import { projectReviewDocument } from "../../src/core/review/document";
import { reconcileReviewState } from "../../src/core/review/reconcile";
import {
  createReviewStore,
  createReviewStoreFromState,
  type ReviewStore,
  type ReviewStoreOptions,
} from "../../src/core/review/store";
import type { Changeset, DiffFile } from "../../src/core/types";

/** Create an explicit renderer-neutral authority for direct component and hook tests. */
export function createTestReviewStore(
  files: DiffFile[],
  options: {
    changeset?: Partial<Omit<Changeset, "files">>;
    generation?: string;
    showAgentNotes?: boolean;
    sourceIdentity?: string;
    validateNextSnapshot?: ReviewStoreOptions["validateNextSnapshot"];
  } = {},
) {
  const document = projectReviewDocument(
    {
      id: options.changeset?.id ?? "test-review",
      sourceLabel: options.changeset?.sourceLabel ?? "test://review",
      title: options.changeset?.title ?? "Test review",
      ...(options.changeset?.summary !== undefined ? { summary: options.changeset.summary } : {}),
      ...(options.changeset?.agentSummary !== undefined
        ? { agentSummary: options.changeset.agentSummary }
        : {}),
      files,
    },
    {
      generation: options.generation ?? "generation:test:0",
      sourceIdentity: options.sourceIdentity ?? "test://review",
    },
  ).document;
  return createReviewStore(document, {
    showAgentNotes: options.showAgentNotes,
    validateNextSnapshot: options.validateNextSnapshot,
  });
}

/** Replace a test authority the same way production runtime replaces a soft-reload generation. */
export function replaceTestReviewStore(
  previous: ReviewStore,
  files: DiffFile[],
  generation: string,
) {
  const previousDocument = previous.getSnapshot().document;
  const document = projectReviewDocument(
    {
      id: previousDocument.changesetId,
      sourceLabel: previousDocument.sourceLabel,
      title: previousDocument.title,
      summary: previousDocument.summary,
      agentSummary: previousDocument.agentSummary,
      files,
    },
    {
      generation,
      sourceIdentity: "test://review",
    },
  ).document;
  const previousState = previous.getSnapshot();
  return createReviewStoreFromState({
    ...reconcileReviewState(previousState, document),
    stateRevision: previousState.stateRevision + 1,
  });
}
