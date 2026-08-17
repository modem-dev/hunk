import type { NamedCustomThemeConfig } from "../extension-api/types";
import type { Changeset, DiffFile } from "./changeset/model";
import type {
  CliInput,
  CursorLine,
  LayoutMode,
  SidebarVisibility,
} from "./invocation/commandInputs";
import type { StartupNotice } from "./runtime/startupNotice";
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
 * The changeset model and the command-input shapes moved to leaf modules —
 * `changeset/model` and `invocation/commandInputs` — so the VCS contract, watch
 * planning, and the session surfaces can import them without this module's
 * app-facing layer; they are re-exported here to keep one import site. Only the
 * names other modules actually reach for are listed; the union members nothing
 * imports stay where they are declared.
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
  ExtensionManageCommandInput,
  FileCommandInput,
  HelpCommandInput,
  LayoutMode,
  MarkupRenderCommandInput,
  PagerCommandInput,
  ParsedCliInput,
  PatchCommandInput,
  ReviewNoteSource,
  SessionCommandInput,
  SessionCommandOutput,
  SessionCommentAddCommandInput,
  SessionCommentApplyCommandInput,
  SessionCommentApplyItemInput,
  SessionCommentClearCommandInput,
  SessionCommentListCommandInput,
  SessionCommentListType,
  SessionCommentRemoveCommandInput,
  SessionHighlightAddCommandInput,
  SessionHighlightClearCommandInput,
  SessionNavigateCommandInput,
  SessionReloadCommandInput,
  SessionReviewCommandInput,
  SessionSelectorInput,
  SidebarVisibility,
  VcsDiffCommandInput,
  VcsMode,
  VcsShowCommandInput,
  VcsStashShowCommandInput,
} from "./invocation/commandInputs";

export type TerminalThemeMode = "light" | "dark";

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
