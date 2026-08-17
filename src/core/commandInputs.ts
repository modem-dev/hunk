/**
 * Declares the review-launching command inputs and the resolved view options
 * they carry: everything a `hunk diff`/`show`/`stash show`/`patch`/`difftool`
 * invocation normalizes into before a changeset is loaded.
 *
 * Kept as a leaf module so the VCS contract and watch planning can name these
 * inputs without importing `core/types`, which layers the app-facing types
 * above them.
 */
import type {
  ExtensionVcsDiffInput,
  ExtensionVcsShowInput,
  ExtensionVcsStashShowInput,
} from "../extension-api/types";

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
  /** Offload eligible large-diff highlighting for this launch. */
  fast?: boolean;
  excludeUntracked?: boolean;
  lineNumbers?: boolean;
  tabWidth?: number;
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
