import type {
  DiffFile,
  ShowCommandInput,
  StashShowCommandInput,
  VcsCommandInput,
  VcsMode,
} from "../types";

export type VcsId = VcsMode;

export interface VcsDetection {
  id: VcsId;
  repoRoot: string;
}

export interface VcsLoadContext {
  cwd: string;
}

export type VcsReviewInput = VcsCommandInput | ShowCommandInput | StashShowCommandInput;

export type VcsReviewOperation =
  | { kind: "working-tree-diff"; input: VcsCommandInput }
  | { kind: "revision-show"; input: ShowCommandInput }
  | { kind: "stash-show"; input: StashShowCommandInput };

export type VcsReviewOperationKind = VcsReviewOperation["kind"];

export interface VcsCapabilities {
  reviewOperations: ReadonlySet<VcsReviewOperationKind>;
  stagedDiff?: boolean;
  sourceFetching?: boolean;
  watchSignatures?: boolean;
}

export interface VcsPatchResult {
  repoRoot: string;
  sourceLabel: string;
  title: string;
  patchText: string;
  untrackedFiles?: string[];
  extraFiles?: DiffFile[];
}

export interface VcsAdapter {
  id: VcsId;
  name: string;
  capabilities: VcsCapabilities;
  detect(cwd: string): VcsDetection | null;
  loadReview(operation: VcsReviewOperation, context: VcsLoadContext): Promise<VcsPatchResult>;
  watchSignature?: (operation: VcsReviewOperation, context: VcsLoadContext) => string;
}
