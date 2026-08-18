/**
 * Declares the normalized changeset model every input source produces and every
 * surface consumes: one `Changeset` of ordered `DiffFile`s plus the sidecar
 * context matched onto them.
 *
 * Kept as a leaf module so loaders, the VCS contract, and watch planning can
 * share these shapes without importing `core/types`, which layers the
 * app-facing types above them.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import type { AgentFileContext } from "../../extension-api/types";
import type { FileSourceFetcher } from "./fileSource";

/** One loaded review sidecar: the changeset summary plus every annotated file it names. */
export interface SidecarContext {
  version: number;
  summary?: string;
  files: AgentFileContext[];
}

export interface DiffFile {
  id: string;
  path: string;
  previousPath?: string;
  patch: string;
  language?: string;
  stats: {
    additions: number;
    deletions: number;
  };
  metadata: FileDiffMetadata;
  lineMoveKinds?: DiffLineMoveKinds;
  agent: AgentFileContext | null;
  isUntracked?: boolean;
  isBinary?: boolean;
  isTooLarge?: boolean;
  statsTruncated?: boolean;
  // Optional capability for fetching the file's full text on either side.
  // Loaders attach this when source content is reachable; absent when not.
  sourceFetcher?: FileSourceFetcher;
}

export type DiffLineMoveKind = "moved";

export interface DiffLineMoveKinds {
  additionLines: Array<DiffLineMoveKind | undefined>;
  deletionLines: Array<DiffLineMoveKind | undefined>;
}

export interface Changeset {
  id: string;
  sourceLabel: string;
  title: string;
  summary?: string;
  agentSummary?: string;
  files: DiffFile[];
}
