/**
 * Declares every shape a parsed `hunk` invocation can take: the review-launching
 * inputs and the view options they carry, plus the non-review commands — help,
 * pager, `daemon serve`, `session *`, `markup *`, and `extension *` — that
 * `ParsedCliInput` unions together.
 *
 * Kept as a leaf module so the VCS contract, watch planning, and the session
 * surfaces can name these inputs without importing `core/types`, which layers
 * the app-facing types above them.
 */
import type {
  ExtensionVcsDiffInput,
  ExtensionVcsShowInput,
  ExtensionVcsStashShowInput,
} from "../../extension-api/types";
import type { InstallSource } from "../install/installSource";

export type LayoutMode = "auto" | "split" | "stack";
export type CursorLine = "row" | "number" | "off";
export type SidebarVisibility = boolean | "auto";
export type VcsMode = string;

export interface CommonOptions {
  mode?: LayoutMode;
  cursorLine?: CursorLine;
  vcs?: VcsMode;
  theme?: string;
  agentContext?: string;
  pager?: boolean;
  watch?: boolean;
  /** Enable launch-scoped experimental review features. */
  experimental?: boolean;
  /** Offload eligible syntax highlighting for this launch. */
  fast?: boolean;
  excludeUntracked?: boolean;
  lineNumbers?: boolean;
  tabWidth?: number;
  /** Blank rows between files in the review stream, including the `─` rule. */
  fileGap?: number;
  /** Blank rows before each hunk after the first in a file. */
  hunkGap?: number;
  wrapLines?: boolean;
  hunkHeaders?: boolean;
  menuBar?: boolean;
  sidebar?: SidebarVisibility;
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

/**
 * Review requests extend the published input views rather than restating them,
 * so an adapter written against the extension contract accepts the exact values
 * Hunk's commands produce. `options` is the internal half: resolved CLI and
 * config state that no adapter — bundled or third-party — needs to see.
 */
export type VcsDiffCommandInput = ExtensionVcsDiffInput & {
  options: CommonOptions;
};

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

/**
 * Note provenance, and the filter `hunk session comment-list --type` accepts.
 * Declared here because the session command inputs name them; `core/types`
 * re-exports both for the review model and the session surfaces.
 */
export type ReviewNoteSource = "ai" | "agent" | "user";
export type SessionCommentListType = "live" | "all" | ReviewNoteSource;

export type HistoryColorMode = "auto" | "always" | "never";
export type HistoryFormat = "medium" | "compact";

/** Auto-responsive VCS history invocation, deliberately separate from review view options. */
export interface HistoryCommandInput {
  kind: "history";
  revision?: string;
  all?: boolean;
  firstParent?: boolean;
  maxCount?: number;
  author?: string;
  grep?: string;
  since?: string;
  until?: string;
  pathspecs?: string[];
  color: HistoryColorMode;
  format: HistoryFormat;
  ascii: boolean;
  /** Force scrollback output even when stdin and stdout are terminals. */
  static: boolean;
  theme?: string;
  vcs?: string;
  extensionsEnabled: boolean;
  extensionPaths: string[];
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
  commentId?: string;
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
  tone?: "match" | "current" | "info" | "warning" | "error" | "dim";
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

export interface ExtensionCliInvocationInput {
  kind: "extension-cli";
  /** Unknown top-level token claimed by a loaded extension at startup. */
  commandName: string;
  /** Tokens below the extension-owned top-level command, preserved in order. */
  args: string[];
  /** Entry paths from leading repeated `--extension` bootstrap flags. */
  extensionPaths: string[];
  /** False only when a leading `--no-extensions` hard-disables lookup. */
  extensionsEnabled: boolean;
}

export interface SelfUpdateCommandInput {
  kind: "update";
  /** Version to install; the install channel's newest release when omitted. */
  version?: string;
  /** Install method override from `--method`, normalized to an install source. */
  method?: InstallSource;
  /** Report the installed and available versions without installing anything. */
  check: boolean;
}

/** `hunk extension ...` managed-install commands. */
export type ExtensionManageCommandInput =
  | ExtensionInstallCommandInput
  | ExtensionListCommandInput
  | ExtensionUpdateCommandInput
  | ExtensionRemoveCommandInput;

export type ParsedCliInput =
  | CliInput
  | HistoryCommandInput
  | HelpCommandInput
  | PagerCommandInput
  | DaemonServeCommandInput
  | SessionCommandInput
  | MarkupRenderCommandInput
  | MarkupGuideCommandInput
  | ExtensionManageCommandInput
  | ExtensionCliInvocationInput
  | SelfUpdateCommandInput;
