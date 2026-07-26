import type { BuildDiffFileOptions } from "../diffFile";
import type { WatchPlan } from "../watchPlan";
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
  watchPlan?: (input: Input, context: VcsLoadContext) => WatchPlan;
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
  /** Repo-root-relative untracked paths Hunk synthesizes into added-file diffs. */
  untrackedPaths?: string[];
  /**
   * Core-only: exact old/new content lookups for syntax highlighting and word
   * diffing. Reaching into the diff engine's file model, so it stays off the
   * published contract; adapters without it fall back to patch-derived content.
   */
  sourceFetcherBuilder?: BuildDiffFileOptions["sourceFetcherBuilder"];
  /** Core-only: fully built diff files an adapter assembled itself. */
  extraFiles?: DiffFile[];
}

export interface VcsAdapter {
  id: VcsId;
  name: string;
  detect(cwd: string): VcsDetection | null;
  operations: VcsOperations;
  /** Detection order weight; higher is consulted first. See the public contract. */
  detectionPriority?: number;
}
