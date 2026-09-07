/**
 * Declares the app bootstrap contract: everything a composed launch hands the
 * interactive shell, plus the context that shell needs to reload the review it
 * was given.
 *
 * This module names shapes the tiers below it already own — the changeset, the
 * parsed command input, the resolved view and keybinding preferences, the
 * detected theme mode — and composes them into the one value that crosses from
 * startup into the UI. The module directories under `packages/hunk/src/core` do not import it
 * back — composition sits above the leaves it composes — with one exception the
 * boundary rules name: `changeset/loaders.ts` assembles this value in
 * `loadAppBootstrap`, so it has to name the shape it returns.
 */
import type { ExtensionReviewDescriptor, NamedCustomThemeConfig } from "../extension-api/types";
import type { Changeset } from "./changeset/model";
import type { CliInput, CursorLine, LayoutMode, SidebarVisibility } from "./run/commandInputs";
import type { UserKeyBinding } from "./run/config";
import type { StartupNotice } from "./process/startupNotice";
import type { TerminalThemeMode } from "./theme/detection";
import type { VcsCatalog } from "./vcs/types";

/** Where a review was loaded from, retained so the session can reload and watch it. */
export interface ReloadContext {
  cwd: string;
  repoRoot?: string;
  initialWatchSignature?: string;
  /** Complete catalog used to load this review, retained for reload and watch. */
  vcsCatalog?: VcsCatalog;
}

/**
 * One fully resolved launch: the changeset to review, the input that asked for it,
 * and every view option settled before the first frame. `initial*` fields are
 * starting values the shell then owns — the shell, not this record, is where they
 * change during the session.
 */
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
  initialFileGap?: number;
  initialHunkGap?: number;
  initialWrapLines?: boolean;
  initialShowHunkHeaders?: boolean;
  initialShowMenuBar?: boolean;
  initialSidebar?: SidebarVisibility;
  initialShowAgentNotes?: boolean;
  initialCopyDecorations?: boolean;
  initialCursorLine?: CursorLine;
  startupNotices?: readonly StartupNotice[];
  /** Validated metadata attached only by an extension-delegated patch review. */
  review?: ExtensionReviewDescriptor;
  viewPreferencesConfigPath?: string;
  /** The user's `[keybindings]` table, resolved against command defaults in App. */
  keybindings?: Record<string, UserKeyBinding>;
  /** App-owned extension state carried without coupling core to the extension host. */
  extensions?: ExtensionState;
}
