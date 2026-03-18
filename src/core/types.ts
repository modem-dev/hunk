import type { FileDiffMetadata } from "@pierre/diffs";

export type LayoutMode = "auto" | "split" | "stack";

export interface AgentAnnotation {
  oldRange?: [number, number];
  newRange?: [number, number];
  summary: string;
  rationale?: string;
  tags?: string[];
  confidence?: "low" | "medium" | "high";
}

export interface AgentFileContext {
  path: string;
  summary?: string;
  annotations: AgentAnnotation[];
}

export interface AgentContext {
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
  agent: AgentFileContext | null;
}

export interface Changeset {
  id: string;
  sourceLabel: string;
  title: string;
  summary?: string;
  agentSummary?: string;
  files: DiffFile[];
}

export interface CommonOptions {
  mode: LayoutMode;
  theme?: string;
  agentContext?: string;
  pager?: boolean;
}

export interface GitCommandInput {
  kind: "git";
  range?: string;
  staged: boolean;
  options: CommonOptions;
}

export interface FileCommandInput {
  kind: "diff";
  left: string;
  right: string;
  options: CommonOptions;
}

export interface PatchCommandInput {
  kind: "patch";
  file?: string;
  options: CommonOptions;
}

export interface DiffToolCommandInput {
  kind: "difftool";
  left: string;
  right: string;
  path?: string;
  options: CommonOptions;
}

export type CliInput =
  | GitCommandInput
  | FileCommandInput
  | PatchCommandInput
  | DiffToolCommandInput;

export interface AppBootstrap {
  input: CliInput;
  changeset: Changeset;
  initialMode: LayoutMode;
  initialTheme?: string;
}
