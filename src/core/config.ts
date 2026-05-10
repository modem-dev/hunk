import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { applyKeymapOverrides, loadKeymapDefaults } from "./keymap/load";
import type { Keymap } from "./keymap/match";
import { resolveGlobalConfigPath } from "./paths";
import type {
  CliInput,
  CommonOptions,
  LayoutMode,
  PersistedViewPreferences,
  VcsMode,
} from "./types";

const DEFAULT_VIEW_PREFERENCES: PersistedViewPreferences = {
  mode: "auto",
  showLineNumbers: true,
  wrapLines: false,
  showHunkHeaders: true,
  showAgentNotes: false,
};

interface ConfigResolutionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface HunkConfigResolution {
  input: CliInput;
  globalConfigPath?: string;
  repoConfigPath?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept only the layout names Hunk already supports. */
function normalizeLayoutMode(value: unknown): LayoutMode | undefined {
  return value === "auto" || value === "split" || value === "stack" ? value : undefined;
}

/** Accept only the VCS backends Hunk can load directly. */
function normalizeVcsMode(value: unknown): VcsMode | undefined {
  return value === "git" || value === "jj" ? value : undefined;
}

/** Accept only plain booleans from config files. */
function normalizeBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

/** Accept only plain strings from config files. */
function normalizeString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read the view preferences stored at one TOML object level. */
function readConfigPreferences(source: Record<string, unknown>): CommonOptions {
  return {
    mode: normalizeLayoutMode(source.mode),
    vcs: normalizeVcsMode(source.vcs),
    theme: normalizeString(source.theme),
    excludeUntracked: normalizeBoolean(source.exclude_untracked),
    lineNumbers: normalizeBoolean(source.line_numbers),
    wrapLines: normalizeBoolean(source.wrap_lines),
    hunkHeaders: normalizeBoolean(source.hunk_headers),
    agentNotes: normalizeBoolean(source.agent_notes),
  };
}

/** Merge partial preference layers with right-hand overrides taking precedence. */
function mergeOptions(base: CommonOptions, overrides: CommonOptions): CommonOptions {
  return {
    ...base,
    mode: overrides.mode ?? base.mode,
    vcs: overrides.vcs ?? base.vcs,
    theme: overrides.theme ?? base.theme,
    agentContext: overrides.agentContext ?? base.agentContext,
    pager: overrides.pager ?? base.pager,
    watch: overrides.watch ?? base.watch,
    excludeUntracked: overrides.excludeUntracked ?? base.excludeUntracked,
    lineNumbers: overrides.lineNumbers ?? base.lineNumbers,
    wrapLines: overrides.wrapLines ?? base.wrapLines,
    hunkHeaders: overrides.hunkHeaders ?? base.hunkHeaders,
    agentNotes: overrides.agentNotes ?? base.agentNotes,
    keymap: overrides.keymap ?? base.keymap,
  };
}

/** Apply one parsed config object, including command/pager sections, to the current invocation. */
function resolveConfigLayer(source: Record<string, unknown>, input: CliInput): CommonOptions {
  let resolved = readConfigPreferences(source);

  const commandSection = source[input.kind];
  if (isRecord(commandSection)) {
    resolved = mergeOptions(resolved, readConfigPreferences(commandSection));
  }

  const pagerSection = source.pager;
  if (input.options.pager && isRecord(pagerSection)) {
    resolved = mergeOptions(resolved, readConfigPreferences(pagerSection));
  }

  return resolved;
}

/** Return the first parent that looks like a repository root. */
function findRepoRoot(cwd = process.cwd()) {
  let current = resolve(cwd);

  for (;;) {
    if (fs.existsSync(join(current, ".git")) || fs.existsSync(join(current, ".jj"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

/** Choose the VCS backend that best matches the discovered checkout. */
function detectRepoVcsMode(repoRoot?: string): VcsMode {
  if (repoRoot && fs.existsSync(join(repoRoot, ".jj"))) {
    return "jj";
  }

  return "git";
}

/**
 * Parse one TOML config file into a plain object. Missing files yield `{}`;
 * malformed TOML and non-object roots are reported to stderr and treated as
 * absent so a bad config never aborts startup.
 */
function readTomlRecord(path: string) {
  if (!fs.existsSync(path)) {
    return {};
  }

  try {
    const parsed = Bun.TOML.parse(fs.readFileSync(path, "utf8"));
    if (!isRecord(parsed)) {
      process.stderr.write(`[hunk] config: ${path} is not a TOML object — ignored.\n`);
      return {};
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[hunk] config: parse error in ${path}: ${message} — ignored.\n`);
    return {};
  }
}

/** Resolve CLI input against global and repo-local config files. */
export function resolveConfiguredCliInput(
  input: CliInput,
  { cwd = process.cwd(), env = process.env }: ConfigResolutionOptions = {},
): HunkConfigResolution {
  const repoRoot = findRepoRoot(cwd);
  const repoConfigPath = repoRoot ? join(repoRoot, ".hunk", "config.toml") : undefined;
  const userConfigPath = resolveGlobalConfigPath(env);

  let resolvedOptions: CommonOptions = {
    mode: DEFAULT_VIEW_PREFERENCES.mode,
    vcs: detectRepoVcsMode(repoRoot),
    // Keep the built-in theme default explicit so stdin-backed startup paths do not depend on
    // renderer theme-mode detection for their initial palette.
    theme: "graphite",
    agentContext: input.options.agentContext,
    pager: input.options.pager ?? false,
    watch: input.options.watch ?? false,
    excludeUntracked: false,
    lineNumbers: DEFAULT_VIEW_PREFERENCES.showLineNumbers,
    wrapLines: DEFAULT_VIEW_PREFERENCES.wrapLines,
    hunkHeaders: DEFAULT_VIEW_PREFERENCES.showHunkHeaders,
    agentNotes: DEFAULT_VIEW_PREFERENCES.showAgentNotes,
  };

  // Keymap is layered separately from view options. It only honors the
  // top-level `[keybindings.<scope>]` blocks — not command-section overrides —
  // because a per-command keymap would be confusing and is unnecessary for v1.
  let keymap: Keymap = loadKeymapDefaults();
  const userTomlRoot = userConfigPath ? readTomlRecord(userConfigPath) : undefined;
  const repoTomlRoot = repoConfigPath ? readTomlRecord(repoConfigPath) : undefined;

  if (userConfigPath && userTomlRoot) {
    resolvedOptions = mergeOptions(resolvedOptions, resolveConfigLayer(userTomlRoot, input));
    keymap = applyKeymapOverrides(keymap, userTomlRoot);
  }

  if (repoConfigPath && repoTomlRoot) {
    resolvedOptions = mergeOptions(resolvedOptions, resolveConfigLayer(repoTomlRoot, input));
    keymap = applyKeymapOverrides(keymap, repoTomlRoot);
  }

  resolvedOptions = mergeOptions(resolvedOptions, input.options);
  resolvedOptions = {
    ...resolvedOptions,
    agentContext: input.options.agentContext,
    pager: input.options.pager ?? false,
    watch: input.options.watch ?? false,
    excludeUntracked: resolvedOptions.excludeUntracked ?? false,
    vcs: resolvedOptions.vcs ?? "git",
    mode: resolvedOptions.mode ?? DEFAULT_VIEW_PREFERENCES.mode,
    lineNumbers: resolvedOptions.lineNumbers ?? DEFAULT_VIEW_PREFERENCES.showLineNumbers,
    wrapLines: resolvedOptions.wrapLines ?? DEFAULT_VIEW_PREFERENCES.wrapLines,
    hunkHeaders: resolvedOptions.hunkHeaders ?? DEFAULT_VIEW_PREFERENCES.showHunkHeaders,
    agentNotes: resolvedOptions.agentNotes ?? DEFAULT_VIEW_PREFERENCES.showAgentNotes,
    keymap,
  };

  return {
    input: {
      ...input,
      options: resolvedOptions,
    },
    globalConfigPath: userConfigPath,
    repoConfigPath,
  };
}
