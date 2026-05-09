import type { FileDiffMetadata } from "@pierre/diffs";

export type LayoutMode = "auto" | "split" | "stack";
export type VcsMode = "git" | "jj";

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
  isUntracked?: boolean;
  isBinary?: boolean;
  isTooLarge?: boolean;
  statsTruncated?: boolean;
  /**
   * Verbatim commit metadata block (commit/Author/Date/blank/message lines) that should
   * render as a plain-text header above this file in the review pane. Only set on the
   * first file under each commit when the source is a multi-commit stream like
   * `git log -p`. Otherwise undefined.
   */
  commitHeaderText?: string;
  /**
   * Zero-based index of the commit this file belongs to within the streamed input.
   * Set by the streaming pager pipeline once any commit boundary has been seen so the
   * App can map the user's selection to a commit position in O(1) for back-pressure.
   */
  commitIndex?: number;
}

export interface Changeset {
  id: string;
  sourceLabel: string;
  title: string;
  summary?: string;
  agentSummary?: string;
  files: DiffFile[];
  /** Set when files are still arriving from a streaming source. */
  isStreaming?: boolean;
}

export interface CommonOptions {
  mode?: LayoutMode;
  vcs?: VcsMode;
  theme?: string;
  agentContext?: string;
  pager?: boolean;
  watch?: boolean;
  excludeUntracked?: boolean;
  lineNumbers?: boolean;
  wrapLines?: boolean;
  hunkHeaders?: boolean;
  agentNotes?: boolean;
  /** Visibility of the commit metadata block in commit-review pager mode. */
  commitDetailsMode?: CommitDetailsMode;
  /**
   * When true, the session does not register with the daemon and the agent review
   * surface (live comments, hunk session commands, daemon-driven reload) is disabled.
   * Pager mode auto-enables this for log-style multi-commit input. Other modes leave
   * it undefined, which means "register with the daemon as usual."
   */
  noReview?: boolean;
}

/**
 * Three-state commit metadata visibility for the commit-review pager:
 * - `full`: render the verbatim header block (commit/Author/Date/blank/subject + body).
 * - `compact`: two-row summary — `commit <sha>  Author: …  Date: …` then the subject.
 * - `hidden`: omit the metadata block entirely.
 *
 * Only meaningful in commit-review pager sessions. Other modes ignore the setting.
 */
export type CommitDetailsMode = "full" | "compact" | "hidden";

/**
 * Live view-preference bundle owned by AppHost so the toggles a user has set
 * survive App remounts (which fire whenever the commit cursor moves between
 * commits). Updates are applied as partials through `updateView`. This is the
 * runtime shape; the persisted-on-disk variant is `PersistedViewPreferences`
 * below and uses CLI/config field names rather than the internal ones.
 */
export interface ViewPreferences {
  layoutMode: LayoutMode;
  themeId: string;
  showAgentNotes: boolean;
  showLineNumbers: boolean;
  wrapLines: boolean;
  showHunkHeaders: boolean;
  sidebarVisible: boolean;
  /**
   * User opted to keep the sidebar open in a viewport that wouldn't auto-show it
   * (medium/tight widths in split/stack layouts). Lives in the persisted view bundle
   * because otherwise it'd reset on every App remount and the sidebar would disappear
   * after each commit-cursor move on narrower terminals.
   */
  forceSidebarOpen: boolean;
  commitDetailsMode: CommitDetailsMode;
}

export interface PersistedViewPreferences {
  mode: LayoutMode;
  theme?: string;
  showLineNumbers: boolean;
  wrapLines: boolean;
  showHunkHeaders: boolean;
  showAgentNotes: boolean;
  commitDetailsMode: CommitDetailsMode;
}

export interface HelpCommandInput {
  kind: "help";
  text: string;
}

export interface PagerCommandInput {
  kind: "pager";
  options: CommonOptions;
}

export interface DaemonServeCommandInput {
  kind: "daemon-serve";
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

export interface SessionReviewCommandInput {
  kind: "session";
  action: "review";
  output: SessionCommandOutput;
  selector: SessionSelectorInput;
  includePatch: boolean;
}

export interface SessionNavigateCommandInput {
  kind: "session";
  action: "navigate";
  output: SessionCommandOutput;
  selector: SessionSelectorInput;
  filePath?: string;
  hunkNumber?: number;
  side?: "old" | "new";
  line?: number;
  commentDirection?: "next" | "prev";
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

export interface SessionCommentApplyItemInput {
  filePath: string;
  hunkNumber?: number;
  side?: "old" | "new";
  line?: number;
  summary: string;
  rationale?: string;
  author?: string;
}

export interface SessionCommentApplyCommandInput {
  kind: "session";
  action: "comment-apply";
  output: SessionCommandOutput;
  selector: SessionSelectorInput;
  comments: SessionCommentApplyItemInput[];
  revealMode: "none" | "first";
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
  | SessionReviewCommandInput
  | SessionNavigateCommandInput
  | SessionReloadCommandInput
  | SessionCommentAddCommandInput
  | SessionCommentApplyCommandInput
  | SessionCommentListCommandInput
  | SessionCommentRemoveCommandInput
  | SessionCommentClearCommandInput;

export interface VcsCommandInput {
  kind: "vcs";
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
  | VcsCommandInput
  | ShowCommandInput
  | StashShowCommandInput
  | FileCommandInput
  | PatchCommandInput
  | DiffToolCommandInput;

export type ParsedCliInput =
  | CliInput
  | HelpCommandInput
  | PagerCommandInput
  | DaemonServeCommandInput
  | SessionCommandInput;

/**
 * Handle exposed by a streaming changeset producer. Lets the UI subscribe to file appends
 * without coupling types.ts to the streaming module's internals.
 */
export interface ChangesetStreamHandle {
  subscribe(listener: ChangesetStreamListener): () => void;
  /**
   * Report the user's current position so the producer can apply back-pressure: pause
   * parsing when the lookahead buffer ahead of the user grows past the high watermark
   * and resume when it drops below the low watermark. Both indexes are zero-based and
   * refer to positions in the appended file list. Calling with the same values
   * repeatedly is cheap and idempotent.
   */
  setConsumedPosition(commitIndex: number, fileIndex: number): void;
  abort(): void;
}

export interface ChangesetStreamListener {
  onAppend: (files: DiffFile[]) => void;
  onComplete: (totalFiles: number) => void;
  onError: (err: Error) => void;
}

/**
 * Parsed commit metadata extracted from a `git log -p`-style verbatim header block.
 * The renderer uses these structured fields for the persistent header strip; the
 * verbatim `rawHeader` is preserved so the metadata overlay can show the original.
 */
export interface CommitMetadata {
  sha: string;
  shortSha: string;
  subject: string;
  author?: string;
  date?: string;
  /** Commit message without the sha/Author/Date headers, with leading/trailing blanks trimmed. */
  body: string;
  /** Verbatim header block as the chunker captured it. */
  rawHeader: string;
}

/**
 * One commit's review unit in a multi-commit pager session. The renderer treats each
 * `CommitChangeset` as a fresh review canvas — selection, scroll, and filter reset
 * when the cursor moves between commits. Live comments persist per-sha at the
 * AppHost level, so navigating away and back restores the notes left on a commit.
 */
export interface CommitChangeset {
  metadata: CommitMetadata;
  changeset: Changeset;
}

/**
 * Producer handle for a stream of `CommitChangeset` events. Used by the commit-by-commit
 * review path in pager mode (`git log -p | hunk pager`). The consumer reports the
 * cursor position via `setConsumedCommitIndex` so the producer can apply back-pressure
 * on commits-ahead.
 */
export interface CommitReviewStreamHandle {
  subscribe(listener: CommitReviewStreamListener): () => void;
  setConsumedCommitIndex(index: number): void;
  abort(): void;
}

export interface CommitReviewStreamListener {
  onCommit: (commit: CommitChangeset, index: number) => void;
  onComplete: (totalCommits: number) => void;
  onError: (err: Error) => void;
}

export interface AppBootstrap {
  input: CliInput;
  changeset: Changeset;
  initialMode: LayoutMode;
  initialTheme?: string;
  initialShowLineNumbers?: boolean;
  initialWrapLines?: boolean;
  initialShowHunkHeaders?: boolean;
  initialShowAgentNotes?: boolean;
  initialCommitDetailsMode?: CommitDetailsMode;
  /** Present for flat streaming pager input (--no-review path). */
  stream?: ChangesetStreamHandle;
  /** Present for commit-by-commit pager input (`git log -p | hunk pager` default). */
  commitReviewStream?: CommitReviewStreamHandle;
  /** Metadata for the commit currently displayed when the source is commit-by-commit. */
  currentCommit?: CommitMetadata;
  /**
   * Position of the active commit in the streamed log. Present whenever the source is
   * commit-by-commit so the UI can show a "5 of 23" indicator and the agent surface can
   * detect commit transitions.
   */
  commitCursor?: { current: number; total: number; streaming: boolean };
}
