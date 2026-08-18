/**
 * Assembles the app bootstrap for one launch: loads the changeset for the CLI input and
 * composes it with the launch's view options, themes, and reload context.
 *
 * Loading lives in `core/changeset/loaders`; this module owns the composition, so the
 * domain tier never names the `AppBootstrap` contract built above it.
 */
import { loadChangeset } from "../core/changeset/loaders";
import type { AppBootstrap } from "../core/bootstrap";
import type { CliInput } from "../core/run/commandInputs";
import { DEFAULT_TAB_WIDTH } from "../core/run/tabWidth";
import type { VcsCatalog } from "../core/vcs/types";
import type { NamedCustomThemeConfig } from "../extension-api/types";

export interface LoadAppBootstrapOptions {
  cwd?: string;
  /** Selectable custom themes for this session, already merged into menu order. */
  customThemes?: readonly NamedCustomThemeConfig[];
  /** Complete adapter catalog composed by the app for this session. */
  vcsCatalog?: VcsCatalog;
}

/** Resolve CLI input into the fully loaded app bootstrap state. */
export async function loadAppBootstrap(
  input: CliInput,
  { cwd = process.cwd(), customThemes, vcsCatalog }: LoadAppBootstrapOptions = {},
): Promise<AppBootstrap> {
  const { changeset, repoRoot, initialWatchSignature } = await loadChangeset(input, {
    cwd,
    vcsCatalog,
  });

  return {
    input,
    reloadContext: { cwd, repoRoot, initialWatchSignature, vcsCatalog },
    changeset,
    initialMode: input.options.mode ?? "auto",
    initialTheme: input.options.theme,
    customThemes,
    initialShowLineNumbers: input.options.lineNumbers ?? true,
    initialTabWidth: input.options.tabWidth ?? DEFAULT_TAB_WIDTH,
    initialWrapLines: input.options.wrapLines ?? false,
    initialShowHunkHeaders: input.options.hunkHeaders ?? true,
    initialShowMenuBar: input.options.menuBar ?? true,
    initialSidebar: input.options.sidebar ?? "auto",
    initialShowAgentNotes: input.options.agentNotes ?? false,
    initialCopyDecorations: input.options.copyDecorations ?? false,
    initialCursorLine: input.options.cursorLine ?? "row",
  };
}
