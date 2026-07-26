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

/**
 * One adapter operation's result, after the conversion boundary.
 *
 * Adapters return the published `ExtensionVcsPatchResult`; this is what
 * `toInternalVcsPatchResult` turns it into. The two extra fields here are the
 * diff-engine side of published capabilities rather than privileges: every
 * backend Hunk ships crosses the same boundary to reach them.
 */
export interface VcsPatchResult {
  repoRoot: string;
  sourceLabel: string;
  title: string;
  patchText: string;
  /** Repo-root-relative untracked paths Hunk synthesizes into added-file diffs. */
  untrackedPaths?: string[];
  /** Exact old/new content lookups, built from the result's `readFileSource`. */
  sourceFetcherBuilder?: BuildDiffFileOptions["sourceFetcherBuilder"];
  /** Diff files built from the result's declarative `extraFiles` entries. */
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
