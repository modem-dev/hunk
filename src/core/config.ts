import fs from "node:fs";
import { join } from "node:path";
import { resolveGlobalConfigPath } from "./paths";
import { detectVcs, findVcsRepoRootCandidate, isVcsId } from "./vcs";
import type {
  CliInput,
  CommonOptions,
  CustomSyntaxColorsConfig,
  CustomThemeConfig,
  LayoutMode,
  PersistedViewPreferences,
  VcsMode,
} from "./types";

const BUILT_IN_THEME_IDS = ["graphite", "midnight", "paper", "ember"] as const;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const CUSTOM_THEME_COLOR_KEYS = [
  "background",
  "panel",
  "panelAlt",
  "border",
  "accent",
  "accentMuted",
  "text",
  "muted",
  "addedBg",
  "removedBg",
  "contextBg",
  "addedContentBg",
  "removedContentBg",
  "contextContentBg",
  "addedSignColor",
  "removedSignColor",
  "lineNumberBg",
  "lineNumberFg",
  "selectedHunk",
  "badgeAdded",
  "badgeRemoved",
  "badgeNeutral",
  "fileNew",
  "fileDeleted",
  "fileRenamed",
  "fileModified",
  "fileUntracked",
  "noteBorder",
  "noteBackground",
  "noteTitleBackground",
  "noteTitleText",
] as const;
const CUSTOM_SYNTAX_COLOR_KEYS = [
  "default",
  "keyword",
  "string",
  "comment",
  "number",
  "function",
  "property",
  "type",
  "punctuation",
] as const;

const DEFAULT_VIEW_PREFERENCES: PersistedViewPreferences = {
  mode: "auto",
  showLineNumbers: true,
  wrapLines: false,
  showHunkHeaders: true,
  showAgentNotes: false,
  copyDecorations: false,
};

interface ConfigResolutionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface HunkConfigResolution {
  input: CliInput;
  customTheme?: CustomThemeConfig;
  globalConfigPath?: string;
  repoConfigPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept only the layout names Hunk already supports. */
function normalizeLayoutMode(value: unknown): LayoutMode | undefined {
  return value === "auto" || value === "split" || value === "stack" ? value : undefined;
}

/** Accept only the VCS backends Hunk can load directly. */
function normalizeVcsMode(value: unknown): VcsMode | undefined {
  return isVcsId(value) ? value : undefined;
}

/** Accept only plain booleans from config files. */
function normalizeBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

/** Accept only plain strings from config files. */
function normalizeString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Accept only #rrggbb theme colors and report the failing TOML key path. */
function normalizeThemeColor(value: unknown, keyPath: string) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !HEX_COLOR_PATTERN.test(value)) {
    throw new Error(`Expected ${keyPath} to be a hex color like #112233.`);
  }

  return value.toLowerCase();
}

/** Accept only built-in base theme ids for config-defined custom themes. */
function normalizeCustomThemeBase(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "string" ||
    !BUILT_IN_THEME_IDS.includes(value as (typeof BUILT_IN_THEME_IDS)[number])
  ) {
    throw new Error(`Expected custom_theme.base to be one of: ${BUILT_IN_THEME_IDS.join(", ")}.`);
  }

  return value;
}

/** Read the nested syntax color overrides from a [custom_theme.syntax] TOML table. */
function readCustomSyntaxColors(
  source: Record<string, unknown>,
): CustomSyntaxColorsConfig | undefined {
  const syntax: CustomSyntaxColorsConfig = {};

  for (const key of CUSTOM_SYNTAX_COLOR_KEYS) {
    const value = normalizeThemeColor(source[key], `custom_theme.syntax.${key}`);
    if (value !== undefined) {
      syntax[key] = value;
    }
  }

  return Object.keys(syntax).length > 0 ? syntax : undefined;
}

/** Read the optional config-defined custom theme palette from one TOML object level. */
function readCustomTheme(source: Record<string, unknown>): CustomThemeConfig | undefined {
  const customThemeSource = source.custom_theme;
  if (!isRecord(customThemeSource)) {
    return undefined;
  }

  const syntaxSource = customThemeSource.syntax;
  if (syntaxSource !== undefined && !isRecord(syntaxSource)) {
    throw new Error("Expected custom_theme.syntax to contain a TOML table.");
  }

  const customTheme: CustomThemeConfig = {
    base: normalizeCustomThemeBase(customThemeSource.base),
  };
  const label = normalizeString(customThemeSource.label);
  if (label !== undefined) {
    customTheme.label = label;
  }

  for (const key of CUSTOM_THEME_COLOR_KEYS) {
    const value = normalizeThemeColor(customThemeSource[key], `custom_theme.${key}`);
    if (value !== undefined) {
      customTheme[key] = value;
    }
  }

  if (isRecord(syntaxSource)) {
    const syntax = readCustomSyntaxColors(syntaxSource);
    if (syntax) {
      customTheme.syntax = syntax;
    }
  }

  return customTheme;
}

/** Merge partial custom theme layers while keeping nested syntax overrides field-based. */
function mergeCustomTheme(
  base: CustomThemeConfig | undefined,
  overrides: CustomThemeConfig | undefined,
): CustomThemeConfig | undefined {
  if (!base) {
    return overrides;
  }
  if (!overrides) {
    return base;
  }

  return {
    ...base,
    ...overrides,
    base: overrides.base ?? base.base ?? "graphite",
    label: overrides.label ?? base.label,
    syntax:
      base.syntax || overrides.syntax
        ? {
            ...base.syntax,
            ...overrides.syntax,
          }
        : undefined,
  };
}

/** Read the view preferences stored at one TOML object level. */
function readConfigPreferences(source: Record<string, unknown>): CommonOptions {
  return {
    mode: normalizeLayoutMode(source.mode),
    vcs: normalizeVcsMode(source.vcs),
    theme: normalizeString(source.theme),
    watch: normalizeBoolean(source.watch),
    excludeUntracked: normalizeBoolean(source.exclude_untracked),
    lineNumbers: normalizeBoolean(source.line_numbers),
    wrapLines: normalizeBoolean(source.wrap_lines),
    hunkHeaders: normalizeBoolean(source.hunk_headers),
    agentNotes: normalizeBoolean(source.agent_notes),
    copyDecorations: normalizeBoolean(source.copy_decorations),
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
    copyDecorations: overrides.copyDecorations ?? base.copyDecorations,
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

/** Choose the VCS backend that best matches the discovered checkout. */
function detectRepoVcsMode(cwd: string): VcsMode {
  return detectVcs(cwd)?.id ?? "git";
}

/** Parse one TOML config file into a plain object. */
function readTomlRecord(path: string) {
  if (!fs.existsSync(path)) {
    return {};
  }

  const parsed = Bun.TOML.parse(fs.readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`Expected ${path} to contain a TOML object.`);
  }

  return parsed;
}

/** Resolve CLI input against global and repo-local config files. */
export function resolveConfiguredCliInput(
  input: CliInput,
  { cwd = process.cwd(), env = process.env }: ConfigResolutionOptions = {},
): HunkConfigResolution {
  const repoRoot = findVcsRepoRootCandidate(cwd);
  const repoConfigPath = repoRoot ? join(repoRoot, ".hunk", "config.toml") : undefined;
  const userConfigPath = resolveGlobalConfigPath(env);
  let resolvedCustomTheme: CustomThemeConfig | undefined;

  let resolvedOptions: CommonOptions = {
    mode: DEFAULT_VIEW_PREFERENCES.mode,
    vcs: detectRepoVcsMode(cwd),
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
    copyDecorations: DEFAULT_VIEW_PREFERENCES.copyDecorations,
  };

  if (userConfigPath) {
    const userConfig = readTomlRecord(userConfigPath);
    resolvedOptions = mergeOptions(resolvedOptions, resolveConfigLayer(userConfig, input));
    resolvedCustomTheme = mergeCustomTheme(resolvedCustomTheme, readCustomTheme(userConfig));
  }

  if (repoConfigPath) {
    const repoConfig = readTomlRecord(repoConfigPath);
    resolvedOptions = mergeOptions(resolvedOptions, resolveConfigLayer(repoConfig, input));
    resolvedCustomTheme = mergeCustomTheme(resolvedCustomTheme, readCustomTheme(repoConfig));
  }

  resolvedOptions = mergeOptions(resolvedOptions, input.options);
  resolvedOptions = {
    ...resolvedOptions,
    agentContext: input.options.agentContext,
    pager: input.options.pager ?? false,
    watch: input.options.watch ?? resolvedOptions.watch ?? false,
    excludeUntracked: resolvedOptions.excludeUntracked ?? false,
    vcs: resolvedOptions.vcs ?? "git",
    mode: resolvedOptions.mode ?? DEFAULT_VIEW_PREFERENCES.mode,
    lineNumbers: resolvedOptions.lineNumbers ?? DEFAULT_VIEW_PREFERENCES.showLineNumbers,
    wrapLines: resolvedOptions.wrapLines ?? DEFAULT_VIEW_PREFERENCES.wrapLines,
    hunkHeaders: resolvedOptions.hunkHeaders ?? DEFAULT_VIEW_PREFERENCES.showHunkHeaders,
    agentNotes: resolvedOptions.agentNotes ?? DEFAULT_VIEW_PREFERENCES.showAgentNotes,
    copyDecorations: resolvedOptions.copyDecorations ?? DEFAULT_VIEW_PREFERENCES.copyDecorations,
  };

  if (resolvedOptions.theme === "custom" && !resolvedCustomTheme) {
    throw new Error('Expected a [custom_theme] table when config selects theme = "custom".');
  }

  return {
    input: {
      ...input,
      options: resolvedOptions,
    },
    customTheme: resolvedCustomTheme,
    globalConfigPath: userConfigPath,
    repoConfigPath,
  };
}
