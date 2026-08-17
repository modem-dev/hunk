import type { NamedCustomThemeConfig } from "../extension-api/types";
import type { Changeset, DiffFile } from "./changeset/model";
import type {
  CliInput,
  CommonOptions,
  CursorLine,
  LayoutMode,
  SidebarVisibility,
} from "./commandInputs";
import type { StartupNotice } from "./startupNotice";
import type { VcsCatalog } from "./vcs/types";

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

/**
 * The changeset model and command-input shapes moved to leaf modules so the
 * VCS contract and watch planning can import them without this module's
 * app-facing layer; they are re-exported here to keep one import site.
 */
export type {
  Changeset,
  DiffFile,
  DiffLineMoveKind,
  DiffLineMoveKinds,
  SidecarContext,
} from "./changeset/model";
export type {
  CliInput,
  CommonOptions,
  CursorLine,
  DiffToolCommandInput,
  FileCommandInput,
  LayoutMode,
  PatchCommandInput,
  SidebarVisibility,
  VcsDiffCommandInput,
  VcsMode,
  VcsShowCommandInput,
  VcsStashShowCommandInput,
} from "./commandInputs";

export type TerminalThemeMode = "light" | "dark";

export type ReviewNoteSource = "ai" | "agent" | "user";
export type SessionCommentListType = "live" | "all" | ReviewNoteSource;

export interface UserNoteLineTarget {
  side: "old" | "new";
  line: number;
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
  cursorLine: CursorLine;
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
  /** Nearest project boundary known for this repo-path selector. */
  repoBoundary?: string;
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

export interface SessionHighlightAddCommandInput {
  kind: "session";
  action: "highlight-add";
  output: SessionCommandOutput;
  selector: SessionSelectorInput;
  filePath: string;
  side: "old" | "new";
  line: number;
  /** 0-based inclusive UTF-16 code-unit offset into the line's raw text. */
  start: number;
  /** Exclusive end offset; must exceed `start`. */
  end: number;
  tone?: "match" | "current" | "info" | "warning" | "error";
  reveal: boolean;
}

export interface SessionHighlightClearCommandInput {
  kind: "session";
  action: "highlight-clear";
  output: SessionCommandOutput;
  selector: SessionSelectorInput;
  filePath?: string;
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
  | SessionCommentClearCommandInput
  | SessionHighlightAddCommandInput
  | SessionHighlightClearCommandInput;

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

export interface ExtensionInstallCommandInput {
  kind: "extension-manage";
  action: "install";
  /** Install source spec: owner/repo, git:host/path, a git URL, or a local path. */
  source: string;
  /** Skip the interactive confirmation (required when stdin is not a TTY). */
  yes: boolean;
}

export interface ExtensionListCommandInput {
  kind: "extension-manage";
  action: "list";
}

export interface ExtensionUpdateCommandInput {
  kind: "extension-manage";
  action: "update";
  /** One managed install to update; every managed install when omitted. */
  name?: string;
}

export interface ExtensionRemoveCommandInput {
  kind: "extension-manage";
  action: "remove";
  name: string;
}

/** `hunk extension ...` managed-install commands. */
export type ExtensionManageCommandInput =
  | ExtensionInstallCommandInput
  | ExtensionListCommandInput
  | ExtensionUpdateCommandInput
  | ExtensionRemoveCommandInput;

export type ParsedCliInput =
  | CliInput
  | HelpCommandInput
  | PagerCommandInput
  | DaemonServeCommandInput
  | SessionCommandInput
  | MarkupRenderCommandInput
  | MarkupGuideCommandInput
  | ExtensionManageCommandInput;

export interface ReloadContext {
  cwd: string;
  repoRoot?: string;
  initialWatchSignature?: string;
  /** Complete catalog used to load this review, retained for reload and watch. */
  vcsCatalog?: VcsCatalog;
}

export interface AppBootstrap<ExtensionState = unknown> {
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
  initialSidebar?: SidebarVisibility;
  initialShowAgentNotes?: boolean;
  initialCopyDecorations?: boolean;
  initialCursorLine?: CursorLine;
  startupNotices?: readonly StartupNotice[];
  viewPreferencesConfigPath?: string;
  /** The user's `[keybindings]` table, resolved against command defaults in App. */
  keybindings?: Record<string, UserKeyBinding>;
  /** App-owned extension state carried without coupling core to the extension host. */
  extensions?: ExtensionState;
}
