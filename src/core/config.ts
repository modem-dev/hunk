import fs from "node:fs";
import { dirname, join } from "node:path";
import { BUNDLED_SHIKI_THEME_IDS } from "../ui/lib/shikiThemes";
import { normalizeBuiltInThemeId } from "../ui/themes";
import { LEGACY_CUSTOM_SYNTAX_COLOR_KEYS, resolveSyntaxScopeOverrides } from "./legacySyntaxScopes";
import { resolveGlobalConfigPath } from "./paths";
import { LEGACY_CUSTOM_SYNTAX_NOTICES, type StartupNotice } from "./startupNotice";
import { detectVcs, findVcsRepoRootCandidate, getDefaultVcsAdapter, isVcsId } from "./vcs";
import type {
  CliInput,
  CommonOptions,
  CustomSyntaxColorsConfig,
  CustomSyntaxScopesConfig,
  CustomThemeConfig,
  LayoutMode,
  PersistedViewPreferences,
  VcsMode,
} from "./types";

const BUILT_IN_THEME_IDS = BUNDLED_SHIKI_THEME_IDS;
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
  "movedAddedBg",
  "movedRemovedBg",
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
const DEFAULT_VIEW_PREFERENCES: PersistedViewPreferences = {
  mode: "auto",
  showLineNumbers: true,
  wrapLines: false,
  showHunkHeaders: true,
  showMenuBar: true,
  showAgentNotes: false,
  copyDecorations: false,
};

const VIEW_PREFERENCES_PROMPT_CONFIG_KEY = "prompt_save_view_preferences";
const PERSISTED_VIEW_PREFERENCE_KEYS: Array<{
  configKey: string;
  value: (preferences: PersistedViewPreferences) => string | boolean | undefined;
}> = [
  { configKey: "theme", value: (preferences) => preferences.theme },
  { configKey: "mode", value: (preferences) => preferences.mode },
  { configKey: "line_numbers", value: (preferences) => preferences.showLineNumbers },
  { configKey: "wrap_lines", value: (preferences) => preferences.wrapLines },
  { configKey: "hunk_headers", value: (preferences) => preferences.showHunkHeaders },
  { configKey: "menu_bar", value: (preferences) => preferences.showMenuBar },
  { configKey: "agent_notes", value: (preferences) => preferences.showAgentNotes },
  { configKey: "copy_decorations", value: (preferences) => preferences.copyDecorations },
];

interface ConfigResolutionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface HunkConfigResolution {
  input: CliInput;
  customTheme?: CustomThemeConfig;
  startupNotices?: readonly StartupNotice[];
  globalConfigPath?: string;
  repoConfigPath?: string;
  viewPreferencesConfigPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Serialize one primitive TOML preference value. */
function serializeTomlPreferenceValue(value: string | boolean) {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return JSON.stringify(value);
}

/** Update one top-level TOML key while preserving sections and unrelated comments. */
function upsertTopLevelTomlValue(source: string, key: string, value: string | boolean) {
  const lines = source.length > 0 ? source.split("\n") : [];
  const serialized = serializeTomlPreferenceValue(value);
  const assignment = `${key} = ${serialized}`;
  let firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstTableIndex < 0) {
    firstTableIndex = lines.length;
  }

  const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
  for (let index = 0; index < firstTableIndex; index += 1) {
    if (keyPattern.test(lines[index] ?? "")) {
      lines[index] = assignment;
      return `${lines.join("\n").replace(/\n*$/, "")}\n`;
    }
  }

  let insertAt = firstTableIndex;
  const hasTableSpacer = insertAt > 0 && lines[insertAt - 1] === "";
  if (hasTableSpacer) {
    insertAt -= 1;
  }
  lines.splice(
    insertAt,
    0,
    assignment,
    ...(hasTableSpacer || insertAt === lines.length ? [] : [""]),
  );
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
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

/** Accept only built-in theme ids for config-defined custom themes. */
function normalizeCustomThemeBase(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(
      `Expected custom_theme.base to be a built-in theme id. Known themes: ${BUILT_IN_THEME_IDS.join(", ")}.`,
    );
  }

  const resolvedThemeId = normalizeBuiltInThemeId(value);
  if (!resolvedThemeId) {
    throw new Error(
      `Expected custom_theme.base to be a built-in theme id. Known themes: ${BUILT_IN_THEME_IDS.join(", ")}.`,
    );
  }

  return resolvedThemeId;
}

/** Read the deprecated semantic colors retained for one compatibility release window. */
function readLegacyCustomSyntaxColors(
  source: Record<string, unknown>,
): CustomSyntaxColorsConfig | undefined {
  const syntax: CustomSyntaxColorsConfig = {};

  for (const key of LEGACY_CUSTOM_SYNTAX_COLOR_KEYS) {
    const value = normalizeThemeColor(source[key], `custom_theme.syntax.${key}`);
    if (value !== undefined) {
      syntax[key] = value;
    }
  }

  return Object.keys(syntax).length > 0 ? syntax : undefined;
}

/** Read exact Shiki/TextMate scope colors from a [custom_theme.syntax_scopes] TOML table. */
function readCustomSyntaxScopes(
  source: Record<string, unknown>,
): CustomSyntaxScopesConfig | undefined {
  const syntaxScopes: CustomSyntaxScopesConfig = {};

  for (const [scope, rawColor] of Object.entries(source)) {
    if (scope.trim().length === 0) {
      throw new Error("Expected custom_theme.syntax_scopes keys to be non-empty Shiki scopes.");
    }

    const color = normalizeThemeColor(rawColor, `custom_theme.syntax_scopes.${scope}`);
    if (color !== undefined) {
      syntaxScopes[scope] = color;
    }
  }

  return Object.keys(syntaxScopes).length > 0 ? syntaxScopes : undefined;
}

interface CustomThemeLayer {
  customTheme?: CustomThemeConfig;
  usesLegacySyntax: boolean;
}

/** Read one config layer's optional custom theme and compatibility metadata. */
function readCustomTheme(source: Record<string, unknown>): CustomThemeLayer {
  const customThemeSource = source.custom_theme;
  if (!isRecord(customThemeSource)) {
    return { usesLegacySyntax: false };
  }

  const legacySyntaxSource = customThemeSource.syntax;
  if (legacySyntaxSource !== undefined && !isRecord(legacySyntaxSource)) {
    throw new Error("Expected custom_theme.syntax to contain a TOML table.");
  }

  const syntaxScopesSource = customThemeSource.syntax_scopes;
  if (syntaxScopesSource !== undefined && !isRecord(syntaxScopesSource)) {
    throw new Error("Expected custom_theme.syntax_scopes to contain a TOML table.");
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

  const legacySyntax = isRecord(legacySyntaxSource)
    ? readLegacyCustomSyntaxColors(legacySyntaxSource)
    : undefined;
  const exactSyntaxScopes = isRecord(syntaxScopesSource)
    ? readCustomSyntaxScopes(syntaxScopesSource)
    : undefined;
  const syntaxScopes = resolveSyntaxScopeOverrides(legacySyntax, exactSyntaxScopes);
  if (syntaxScopes) {
    // Normalize legacy config at the boundary so every runtime highlighter uses raw scopes only.
    customTheme.syntaxScopes = syntaxScopes;
  }

  return {
    customTheme,
    usesLegacySyntax: Boolean(legacySyntax),
  };
}

/** Merge partial custom theme layers while keeping exact syntax scope overrides field-based. */
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
    base: overrides.base ?? base.base ?? "github-dark-default",
    label: overrides.label ?? base.label,
    syntaxScopes:
      base.syntaxScopes || overrides.syntaxScopes
        ? {
            ...base.syntaxScopes,
            ...overrides.syntaxScopes,
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
    menuBar: normalizeBoolean(source.menu_bar),
    agentNotes: normalizeBoolean(source.agent_notes),
    copyDecorations: normalizeBoolean(source.copy_decorations),
    promptSaveViewPreferences: normalizeBoolean(source[VIEW_PREFERENCES_PROMPT_CONFIG_KEY]),
    transparentBackground:
      normalizeBoolean(source.transparentBackground) ??
      normalizeBoolean(source.transparent_background),
    colorMoved: normalizeBoolean(source.color_moved),
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
    menuBar: overrides.menuBar ?? base.menuBar,
    agentNotes: overrides.agentNotes ?? base.agentNotes,
    copyDecorations: overrides.copyDecorations ?? base.copyDecorations,
    promptSaveViewPreferences:
      overrides.promptSaveViewPreferences ?? base.promptSaveViewPreferences,
    transparentBackground: overrides.transparentBackground ?? base.transparentBackground,
    colorMoved: overrides.colorMoved ?? base.colorMoved,
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
  return detectVcs(cwd)?.id ?? getDefaultVcsAdapter().id;
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

/** Read a config file if it already exists. */
function readConfigSource(configPath: string) {
  return fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
}

/** Resolve the config file path used for interactive persistence. */
function resolveWritableConfigPath(configuredPath: string | undefined, env: NodeJS.ProcessEnv) {
  const configPath = configuredPath ?? resolveGlobalConfigPath(env);
  if (!configPath) {
    throw new Error("Could not resolve a config path because HOME/XDG_CONFIG_HOME is unset.");
  }

  return configPath;
}

/** Write an updated config source after ensuring the parent directory exists. */
function writeConfigSource(configPath: string, source: string) {
  fs.mkdirSync(dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, source);
}

/** One view preference the quit prompt would rewrite, as TOML assignment text. */
export interface ViewPreferenceChange {
  configKey: string;
  previousValue: string;
  nextValue: string;
}

/**
 * Diff two view-preference snapshots into the TOML assignments
 * `saveGlobalViewPreferences` would rewrite, so prompt UI and persistence
 * stay derived from the same key table.
 */
export function diffPersistedViewPreferences(
  previous: PersistedViewPreferences,
  next: PersistedViewPreferences,
): ViewPreferenceChange[] {
  const changes: ViewPreferenceChange[] = [];
  for (const key of PERSISTED_VIEW_PREFERENCE_KEYS) {
    const previousValue = key.value(previous);
    const nextValue = key.value(next);
    if (previousValue === nextValue) {
      continue;
    }

    changes.push({
      configKey: key.configKey,
      previousValue:
        previousValue === undefined ? "unset" : serializeTomlPreferenceValue(previousValue),
      nextValue: nextValue === undefined ? "unset" : serializeTomlPreferenceValue(nextValue),
    });
  }

  return changes;
}

/** Persist accepted in-app view preferences to the selected Hunk config file. */
export function saveGlobalViewPreferences(
  preferences: PersistedViewPreferences,
  {
    configPath: configuredPath,
    env = process.env,
  }: Pick<ConfigResolutionOptions, "env"> & { configPath?: string } = {},
) {
  const configPath = resolveWritableConfigPath(configuredPath, env);
  let nextSource = readConfigSource(configPath);
  for (const key of PERSISTED_VIEW_PREFERENCE_KEYS) {
    const value = key.value(preferences);
    if (value !== undefined) {
      nextSource = upsertTopLevelTomlValue(nextSource, key.configKey, value);
    }
  }

  writeConfigSource(configPath, nextSource);
  return configPath;
}

/** Persist whether Hunk should prompt before discarding changed view preferences. */
export function saveViewPreferencesPromptPreference(
  promptSaveViewPreferences: boolean,
  {
    configPath: configuredPath,
    env = process.env,
  }: Pick<ConfigResolutionOptions, "env"> & { configPath?: string } = {},
) {
  const configPath = resolveWritableConfigPath(configuredPath, env);
  const nextSource = upsertTopLevelTomlValue(
    readConfigSource(configPath),
    VIEW_PREFERENCES_PROMPT_CONFIG_KEY,
    promptSaveViewPreferences,
  );

  writeConfigSource(configPath, nextSource);
  return configPath;
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
  let usesLegacyCustomSyntax = false;

  let resolvedOptions: CommonOptions = {
    mode: DEFAULT_VIEW_PREFERENCES.mode,
    vcs: detectRepoVcsMode(cwd),
    // Keep the built-in theme default explicit so stdin-backed startup paths do not depend on
    // renderer theme-mode detection for their initial palette.
    theme: "github-dark-default",
    agentContext: input.options.agentContext,
    pager: input.options.pager ?? false,
    watch: input.options.watch ?? false,
    excludeUntracked: false,
    lineNumbers: DEFAULT_VIEW_PREFERENCES.showLineNumbers,
    wrapLines: DEFAULT_VIEW_PREFERENCES.wrapLines,
    hunkHeaders: DEFAULT_VIEW_PREFERENCES.showHunkHeaders,
    menuBar: DEFAULT_VIEW_PREFERENCES.showMenuBar,
    agentNotes: DEFAULT_VIEW_PREFERENCES.showAgentNotes,
    copyDecorations: DEFAULT_VIEW_PREFERENCES.copyDecorations,
    promptSaveViewPreferences: true,
    transparentBackground: false,
  };

  if (userConfigPath) {
    const userConfig = readTomlRecord(userConfigPath);
    const themeLayer = readCustomTheme(userConfig);
    resolvedOptions = mergeOptions(resolvedOptions, resolveConfigLayer(userConfig, input));
    resolvedCustomTheme = mergeCustomTheme(resolvedCustomTheme, themeLayer.customTheme);
    usesLegacyCustomSyntax ||= themeLayer.usesLegacySyntax;
  }

  if (repoConfigPath) {
    const repoConfig = readTomlRecord(repoConfigPath);
    const themeLayer = readCustomTheme(repoConfig);
    resolvedOptions = mergeOptions(resolvedOptions, resolveConfigLayer(repoConfig, input));
    resolvedCustomTheme = mergeCustomTheme(resolvedCustomTheme, themeLayer.customTheme);
    usesLegacyCustomSyntax ||= themeLayer.usesLegacySyntax;
  }

  resolvedOptions = mergeOptions(resolvedOptions, input.options);
  resolvedOptions = {
    ...resolvedOptions,
    agentContext: input.options.agentContext,
    pager: input.options.pager ?? false,
    watch: input.options.watch ?? resolvedOptions.watch ?? false,
    excludeUntracked: resolvedOptions.excludeUntracked ?? false,
    theme: resolvedOptions.theme,
    vcs: resolvedOptions.vcs ?? getDefaultVcsAdapter().id,
    mode: resolvedOptions.mode ?? DEFAULT_VIEW_PREFERENCES.mode,
    lineNumbers: resolvedOptions.lineNumbers ?? DEFAULT_VIEW_PREFERENCES.showLineNumbers,
    wrapLines: resolvedOptions.wrapLines ?? DEFAULT_VIEW_PREFERENCES.wrapLines,
    hunkHeaders: resolvedOptions.hunkHeaders ?? DEFAULT_VIEW_PREFERENCES.showHunkHeaders,
    menuBar: resolvedOptions.menuBar ?? DEFAULT_VIEW_PREFERENCES.showMenuBar,
    agentNotes: resolvedOptions.agentNotes ?? DEFAULT_VIEW_PREFERENCES.showAgentNotes,
    copyDecorations: resolvedOptions.copyDecorations ?? DEFAULT_VIEW_PREFERENCES.copyDecorations,
    promptSaveViewPreferences: resolvedOptions.promptSaveViewPreferences ?? true,
    transparentBackground: resolvedOptions.transparentBackground ?? false,
    colorMoved: resolvedOptions.colorMoved,
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
    startupNotices: usesLegacyCustomSyntax ? LEGACY_CUSTOM_SYNTAX_NOTICES : undefined,
    globalConfigPath: userConfigPath,
    repoConfigPath,
    // Persist in the repo config only when the repo already has one; otherwise keep personal view
    // choices user-scoped so Hunk does not create project policy files from an interactive prompt.
    viewPreferencesConfigPath:
      repoConfigPath && fs.existsSync(repoConfigPath) ? repoConfigPath : userConfigPath,
  };
}
