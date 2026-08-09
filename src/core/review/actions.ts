import type { ReviewDocumentGeneration, ReviewDocumentV1, ReviewSide } from "./types";
import type {
  ReviewDraftNote,
  ReviewExpandedGapState,
  ReviewSemanticSelection,
  ReviewSourceStatus,
  ReviewStoredNote,
} from "./state";

interface GenerationAction {
  expectedGeneration: ReviewDocumentGeneration;
}

export type ReviewAction =
  | { type: "document/reconcile"; document: ReviewDocumentV1; expectedGeneration: string }
  | {
      type: "selection/select";
      selection: ReviewSemanticSelection;
      reveal?: { kind: "hunk" | "file-top" | "line"; scrollToNote?: boolean };
    }
  | { type: "filter/set"; filter: string }
  | { type: "notes/set-visibility"; visible: boolean }
  | (GenerationAction & { type: "trust/set-prompt"; repoRoot: string | null })
  | (GenerationAction & { type: "notes/add-live"; notes: ReviewStoredNote[] })
  | (GenerationAction & { type: "notes/remove-live"; noteId: string })
  | (GenerationAction & {
      type: "notes/clear-live";
      fileKey?: string;
      noteIds?: string[];
      userNoteIds?: string[];
      includeUser?: boolean;
    })
  | (GenerationAction & { type: "notes/add-user"; note: ReviewStoredNote })
  | (GenerationAction & { type: "notes/update-user"; noteId: string; note: ReviewStoredNote })
  | (GenerationAction & { type: "notes/remove-user"; noteId: string })
  | (GenerationAction & { type: "draft/start"; draft: ReviewDraftNote })
  | (GenerationAction & { type: "draft/update"; body: string })
  | (GenerationAction & { type: "draft/cancel" })
  | (GenerationAction & { type: "draft/save"; note: ReviewStoredNote })
  | (GenerationAction & { type: "expansion/toggle"; gap: ReviewExpandedGapState })
  | (GenerationAction & { type: "expansion/clear-file"; fileKey: string })
  | (GenerationAction & {
      type: "expansion/set-source-status";
      fileKey: string;
      status: ReviewSourceStatus;
    })
  | {
      type: "selection/set-line";
      fileKey: string;
      hunkIndex: number;
      side: ReviewSide;
      line: number;
      contextDigest?: string;
      reveal?: boolean;
    };
