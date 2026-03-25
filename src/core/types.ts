import type { FileDiffMetadata } from "@pierre/diffs";

export type LayoutMode = "auto" | "split" | "stack";

export interface AgentAnnotation {
  id?: string;
  oldRange?: [number, number];
  newRange?: [number, number];
  summary: string;
  rationale?: string;
  tags?: string[];
  confidence?: "low" | "medium" | "high";
  source?: string;
  author?: string;
  createdAt?: string;
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
  mode?: LayoutMode;
  theme?: string;
  agentContext?: string;
  pager?: boolean;
  watch?: boolean;
  lineNumbers?: boolean;
  wrapLines?: boolean;
  hunkHeaders?: boolean;
  agentNotes?: boolean;
}

export interface PersistedViewPreferences {
  mode: LayoutMode;
  theme?: string;
  showLineNumbers: boolean;
  wrapLines: boolean;
  showHunkHeaders: boolean;
  showAgentNotes: boolean;
}

export interface HelpCommandInput {
  kind: "help";
  text: string;
}

export interface PagerCommandInput {
  kind: "pager";
  options: CommonOptions;
}

export interface McpServeCommandInput {
  kind: "mcp-serve";
}

export type SessionCommandOutput = "text" | "json";

export interface SessionSelectorInput {
  sessionId?: string;
  sessionPath?: string;
  repoRoot?: string;
}

export interface SessionListCommandInput {
  kind: "session";
  action: "list";
  output: SessionCommandOutput;
}

export interface SessionGetCommandInput {
  kind: "session";
  action: "get" | "context";
  output: SessionCommandOutput;
  selector: SessionSelectorInput;
}

export interface SessionNavigateCommandInput {
  kind: "session";
  action: "navigate";
  output: SessionCommandOutput;
  selector: SessionSelectorInput;
  filePath: string;
  hunkNumber?: number;
  side?: "old" | "new";
  line?: number;
}

export interface SessionReloadCommandInput {
  kind: "session";
  action: "reload";
  output: SessionCommandOutput;
  selector: SessionSelectorInput;
  nextInput: CliInput;
  sourcePath?: string;
}

export interface SessionCommentAddCommandInput {
  kind: "session";
  action: "comment-add";
  output: SessionCommandOutput;
  selector: SessionSelectorInput;
  filePath: string;
  side: "old" | "new";
  line: number;
  summary: string;
  rationale?: string;
  author?: string;
  reveal: boolean;
}

export interface SessionCommentListCommandInput {
  kind: "session";
  action: "comment-list";
  output: SessionCommandOutput;
  selector: SessionSelectorInput;
  filePath?: string;
}

export interface SessionCommentRemoveCommandInput {
  kind: "session";
  action: "comment-rm";
  output: SessionCommandOutput;
  selector: SessionSelectorInput;
  commentId: string;
}

export interface SessionCommentClearCommandInput {
  kind: "session";
  action: "comment-clear";
  output: SessionCommandOutput;
  selector: SessionSelectorInput;
  filePath?: string;
  confirmed: boolean;
}

export type SessionCommandInput =
  | SessionListCommandInput
  | SessionGetCommandInput
  | SessionNavigateCommandInput
  | SessionReloadCommandInput
  | SessionCommentAddCommandInput
  | SessionCommentListCommandInput
  | SessionCommentRemoveCommandInput
  | SessionCommentClearCommandInput;

export interface GitCommandInput {
  kind: "git";
  range?: string;
  staged: boolean;
  pathspecs?: string[];
  options: CommonOptions;
}

export interface ShowCommandInput {
  kind: "show";
  ref?: string;
  pathspecs?: string[];
  options: CommonOptions;
}

export interface StashShowCommandInput {
  kind: "stash-show";
  ref?: string;
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
  text?: string;
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
  | ShowCommandInput
  | StashShowCommandInput
  | FileCommandInput
  | PatchCommandInput
  | DiffToolCommandInput;

export type ParsedCliInput =
  | CliInput
  | HelpCommandInput
  | PagerCommandInput
  | McpServeCommandInput
  | SessionCommandInput;

export interface AppBootstrap {
  input: CliInput;
  changeset: Changeset;
  initialMode: LayoutMode;
  initialTheme?: string;
  initialShowLineNumbers?: boolean;
  initialWrapLines?: boolean;
  initialShowHunkHeaders?: boolean;
  initialShowAgentNotes?: boolean;
}
