import type { BuildDiffFileOptions } from "../diffFile";
import type {
  DiffFile,
  VcsShowCommandInput,
  VcsStashShowCommandInput,
  VcsDiffCommandInput,
} from "../types";

export type VcsId = string;

export interface VcsDetection {
  id: VcsId;
  repoRoot: string;
}

export interface VcsLoadContext {
  cwd: string;
  gitExecutable?: string;
}

export type VcsReviewInput = VcsDiffCommandInput | VcsShowCommandInput | VcsStashShowCommandInput;

export type VcsReviewOperation =
  | { kind: "working-tree-diff"; input: VcsDiffCommandInput }
  | { kind: "revision-show"; input: VcsShowCommandInput }
  | { kind: "stash-show"; input: VcsStashShowCommandInput };

export type VcsReviewOperationKind = VcsReviewOperation["kind"];

export interface VcsOperation<Input extends VcsReviewInput> {
  load(input: Input, context: VcsLoadContext): Promise<VcsPatchResult>;
  watchSignature?: (input: Input, context: VcsLoadContext) => string;
}

export interface VcsOperations {
  "working-tree-diff"?: VcsOperation<VcsDiffCommandInput>;
  "revision-show"?: VcsOperation<VcsShowCommandInput>;
  "stash-show"?: VcsOperation<VcsStashShowCommandInput>;
}

export interface VcsPatchResult {
  repoRoot: string;
  sourceLabel: string;
  title: string;
  patchText: string;
  sourceFetcherBuilder?: BuildDiffFileOptions["sourceFetcherBuilder"];
  extraFiles?: DiffFile[];
}

export interface VcsAdapter {
  id: VcsId;
  name: string;
  detect(cwd: string): VcsDetection | null;
  operations: VcsOperations;
}
