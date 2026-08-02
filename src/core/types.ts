import type { FileDiffMetadata } from "@pierre/diffs";
// Type-only import; the extension types depend on this module in turn, and
// `import type` keeps that relationship out of the runtime module graph.
import type { ExtensionLoadResult } from "../extensions/types";
import type {
  AgentFileContext,
  ExtensionVcsDiffInput,
  ExtensionVcsShowInput,
  ExtensionVcsStashShowInput,
  NamedCustomThemeConfig,
} from "../extension-api/types";
import type { FileSourceFetcher } from "./fileSource";
import type { StartupNotice } from "./startupNotice";
import type { VcsAdapter } from "./vcs/types";

/**
 * Shapes that are simultaneously internal model types and part of the published
 * extension contract are declared once in `src/extension-api/types.ts` — the
 * module whose declarations ship — and re-exported here so internal code keeps
 * importing them from `core/types`.
 */
export type {
  AgentAnnotation,
  AgentFileContext,
  CustomSyntaxColorsConfig,
  CustomSyntaxScopesConfig,
  CustomThemeConfig,
  NamedCustomThemeConfig,
} from "../extension-api/types";

export type LayoutMode = "auto" | "split" | "stack";
export type VcsMode = string;
export type TerminalThemeMode = "light" | "dark";

export type ReviewNoteSource = "ai" | "agent" | "user";
export type SessionCommentListType = "live" | "all" | ReviewNoteSource;

export interface UserNoteLineTarget {
  side: "old" | "new";
  line: number;
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

export interface CommonOptions {
  mode?: LayoutMode;
  vcs?: VcsMode;
  theme?: string;
  agentContext?: string;
  pager?: boolean;
  watch?: boolean;
  /** Enable launch-scoped experimental review features. */
  experimental?: boolean;
  excludeUntracked?: boolean;
  lineNumbers?: boolean;
  tabWidth?: number;
  wrapLines?: boolean;
  hunkHeaders?: boolean;
  menuBar?: boolean;
  agentNotes?: boolean;
  copyDecorations?: boolean;
  promptSaveViewPreferences?: boolean;
  transparentBackground?: boolean;
  colorMoved?: boolean;
  /** False only when `--no-extensions` disables user extension loading for this run. */
  extensions?: boolean;
  /** Entry paths from repeated `--extension` flags, for development and testing. */
  extensionPaths?: string[];
}

/** Resolved `[extensions]` and `[extension.<id>]` configuration for one invocation. */
export interface ExtensionsConfig {
  /**
   * False when `--no-extensions` or `[extensions] enabled = false` disables loading.
   *
   * Scoped to user extensions. Hunk's bundled tier — the Jujutsu and Sapling
   * backends — always loads: these switches exist to triage extensions you
   * installed, not to drop VCS support.
   */
  enabled: boolean;
  /** Explicit entry paths from the user config layer. */
  paths: string[];
  /** Explicit entry paths contributed by the repo config layer; trust-gated like `.hunk/extensions`. */
  repoPaths: string[];
  /** Per-extension config tables, keyed by extension id. */
  extensionConfigs: Record<string, Record<string, unknown>>;
}

/**
 * One `[keybindings]` entry: the chord(s) to bind a command to, or `false` to unbind it.
 *
 * Command ids are the ones the dispatch table declares — `"hunk.app.quit"`,
 * `"hunk.review.nextHunk"`, or `"<extensionId>.<commandId>"` for an extension
 * command. Resolution against each command's defaults lives in
 * `src/ui/lib/keymap.ts`.
 */
export type UserKeyBinding = string | readonly string[] | false;

export interface PersistedViewPreferences {
  mode: LayoutMode;
  theme?: string;
  showLineNumbers: boolean;
  wrapLines: boolean;
  showHunkHeaders: boolean;
  showMenuBar: boolean;
  showAgentNotes: boolean;
  copyDecorations: boolean;
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
  includeNotes?: boolean;
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
  markup?: string;
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
  markup?: string;
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
  type?: SessionCommentListType;
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
  includeUser?: boolean;
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

/**
 * Review requests extend the published input views rather than restating them,
 * so an adapter written against the extension contract accepts the exact values
 * Hunk's commands produce. `options` is the internal half: resolved CLI and
 * config state that no adapter — bundled or third-party — needs to see.
 */
export interface VcsDiffCommandInput extends ExtensionVcsDiffInput {
  options: CommonOptions;
}

export interface VcsShowCommandInput extends ExtensionVcsShowInput {
  options: CommonOptions;
}

export interface VcsStashShowCommandInput extends ExtensionVcsStashShowInput {
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
  /**
   * Header label for in-memory patches that have no backing file, such as a
   * pull request fetched via `hunk diff --pr`. Ignored when `file` is set.
   */
  label?: string;
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
  | VcsDiffCommandInput
  | VcsShowCommandInput
  | VcsStashShowCommandInput
  | FileCommandInput
  | PatchCommandInput
  | DiffToolCommandInput;

export interface MarkupRenderCommandInput {
  kind: "markup-render";
  /** Markup source path, or "-" for stdin. */
  file: string;
  width: number;
  color: "auto" | "always" | "never";
  theme?: string;
  json: boolean;
}

export interface MarkupGuideCommandInput {
  kind: "markup-guide";
}

export type ParsedCliInput =
  | CliInput
  | HelpCommandInput
  | PagerCommandInput
  | DaemonServeCommandInput
  | SessionCommandInput
  | MarkupRenderCommandInput
  | MarkupGuideCommandInput;

export interface ReloadContext {
  cwd: string;
  repoRoot?: string;
  initialWatchSignature?: string;
  /**
   * Extension-contributed VCS backends this session loaded its review through.
   *
   * Watch planning and signatures re-resolve the adapter from the input's
   * configured VCS id, so they need the same adapter set the changeset came
   * from — otherwise a review backed by an extension backend could not be
   * watched at all.
   */
  vcsAdapters?: readonly VcsAdapter[];
}

export interface AppBootstrap {
  input: CliInput;
  reloadContext: ReloadContext;
  changeset: Changeset;
  initialMode: LayoutMode;
  initialTheme?: string;
  initialThemeMode?: TerminalThemeMode;
  /** Selectable custom themes for this session, in menu order. */
  customThemes?: readonly NamedCustomThemeConfig[];
  initialShowLineNumbers?: boolean;
  initialTabWidth?: number;
  initialWrapLines?: boolean;
  initialShowHunkHeaders?: boolean;
  initialShowMenuBar?: boolean;
  initialShowAgentNotes?: boolean;
  initialCopyDecorations?: boolean;
  startupNotices?: readonly StartupNotice[];
  viewPreferencesConfigPath?: string;
  /** The user's `[keybindings]` table, resolved against command defaults in App. */
  keybindings?: Record<string, UserKeyBinding>;
  /** Extensions loaded for this session, and any load failures worth surfacing. */
  extensions?: ExtensionLoadResult;
}
