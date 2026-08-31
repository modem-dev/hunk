/**
 * Declares the actions the reducer executes: decided state transitions only.
 *
 * An action states what changes, not whether it should: lifecycle code and intent plans
 * decide that first. `reduceReviewState` applies one without further validation beyond
 * keeping the state internally consistent, so anything requiring judgement — "save the
 * current draft", "clear these notes" — is planned in `intents.ts` and lowered to these.
 */
import type {
  ReviewDraftNote,
  ReviewRevealRequest,
  ReviewSourceStatus,
  ReviewStoredNote,
} from "./state";
import type { ReviewDocumentV1 } from "./types";

export type ReviewAction =
  /** Adopt a newly loaded document, retiring state derived from content it replaced. */
  | { type: "document/reconcile"; document: ReviewDocumentV1 }
  | {
      type: "selection/select";
      fileKey: string;
      hunkIndex: number;
      /** Omitted by state reconciliation, which must not disturb the reviewer's viewport. */
      reveal?: ReviewRevealRequest;
    }
  | { type: "filter/set"; filter: string }
  | { type: "notes/set-visibility"; visible: boolean }
  | { type: "notes/add-live"; notes: readonly ReviewStoredNote[] }
  | { type: "notes/remove-live"; noteId: string }
  /** Clear mutable notes for one file, or for the whole review when no file is named. */
  | { type: "notes/clear"; fileKey?: string; includeUser?: boolean }
  | { type: "notes/remove-user"; noteId: string }
  | { type: "draft/start"; draft: ReviewDraftNote }
  | { type: "draft/update"; body: string }
  | { type: "draft/cancel" }
  /** Persist an active create/reply draft and retire it in one revision. */
  | { type: "draft/save"; note: ReviewStoredNote }
  /** Replace one saved user note in place and retire its edit draft in one revision. */
  | { type: "draft/save-edit"; note: ReviewStoredNote }
  | { type: "expansion/toggle"; fileKey: string; gapId: string; expanded: boolean }
  | { type: "expansion/set-source-status"; fileKey: string; status: ReviewSourceStatus };
