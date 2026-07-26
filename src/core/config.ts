import fs from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeTerminalLine } from "../lib/terminalText";
import { BUNDLED_SHIKI_THEME_IDS } from "../ui/lib/shikiThemes";
import {
  createInvalidThemeIdNotice,
  createThemeCollisionNotice,
  CUSTOM_THEME_COLOR_KEYS,
  describeCustomThemeIdIssue,
  describeThemeColorIssue,
  LEGACY_CUSTOM_THEME_ID,
  normalizeThemeColorValue,
  resolveThemeBase,
} from "./customThemes";
import { LEGACY_CUSTOM_SYNTAX_COLOR_KEYS, resolveSyntaxScopeOverrides } from "./legacySyntaxScopes";
import { resolveGlobalConfigPath } from "./paths";
import { LEGACY_CUSTOM_SYNTAX_NOTICES, type StartupNotice } from "./startupNotice";
import { DEFAULT_TAB_WIDTH, validateTabWidth } from "./tabWidth";
import { detectVcs, findVcsRepoRootCandidate, getDefaultVcsAdapter } from "./vcs";
import type {
  CliInput,
  CommonOptions,
  CustomSyntaxColorsConfig,
  CustomSyntaxScopesConfig,
  ExtensionsConfig,
  LayoutMode,
  NamedCustomThemeConfig,
  PersistedViewPreferences,
  VcsMode,
} from "./types";

const BUILT_IN_THEME_IDS = BUNDLED_SHIKI_THEME_IDS;
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

export interface HunkConfigResolution {
  input: CliInput;
  /** Config-defined custom themes in declaration order, user layer before repo layer. */
  customThemes: NamedCustomThemeConfig[];
  extensions: ExtensionsConfig;
  /**
   * The `vcs` id a config layer or CLI flag named, when one did.
   *
   * `input.options.vcs` cannot answer this on its own: an explicit
   * `vcs = "git"` and a detected Git checkout resolve to the same string. Later
   * stages need the difference, because an explicit choice outranks detection
   * while a detected one may be revised once extension backends load.
   */
  explicitVcsId?: string;
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

/**
 * Accept any backend id a config layer names, provisionally.
 *
 * Config resolution runs before user extensions have been imported, so it
 * cannot yet know whether `vcs = "hg"` names a backend this session will have.
 * Rejecting it here discarded the user's explicit choice silently — the session
 * fell back to detection with nothing said, and an installed Mercurial
 * extension never got used no matter how plainly it was asked for.
 *
 * So unknown ids ride through, and `resolveSessionVcsId` reconciles them
 * against the adapters that actually loaded: it keeps the id when a backend
 * owns it, and otherwise falls back to detection *and says so*.
 */
function normalizeVcsMode(value: unknown): VcsMode | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Accept only plain booleans from config files. */
function normalizeBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

/** Accept only plain strings from config files. */
function normalizeString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Accept a bounded integer tab width from TOML configuration. */
function normalizeTabWidth(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("Expected tab_width to be an integer from 1 to 16.");
  }

  return validateTabWidth(value, "tab_width");
}

/**
 * Accept only #rrggbb theme colors and report the failing TOML key path.
 *
 * The rule itself lives in `./customThemes` so config tables and extension
 * `registerTheme` calls cannot drift apart; only the error wording — which
 * names the TOML key the user actually wrote — belongs to this layer.
 */
function normalizeThemeColor(value: unknown, keyPath: string) {
  if (value === undefined) {
    return undefined;
  }

  if (describeThemeColorIssue(value)) {
    throw new Error(`Expected ${keyPath} to be a hex color like #112233.`);
  }

  return normalizeThemeColorValue(value as string);
}

/** Accept only built-in theme ids as the base one config-defined theme inherits from. */
function normalizeCustomThemeBase(value: unknown, keyPath: string) {
  if (value === undefined) {
    return undefined;
  }

  const resolved = resolveThemeBase(value);
  if ("issue" in resolved) {
    throw new Error(
      `Expected ${keyPath}.base to be a built-in theme id. Known themes: ${BUILT_IN_THEME_IDS.join(", ")}.`,
    );
  }

  return resolved.base;
}

/** Read the deprecated semantic colors retained for one compatibility release window. */
function readLegacyCustomSyntaxColors(
  source: Record<string, unknown>,
  keyPath: string,
): CustomSyntaxColorsConfig | undefined {
  const syntax: CustomSyntaxColorsConfig = {};

  for (const key of LEGACY_CUSTOM_SYNTAX_COLOR_KEYS) {
    const value = normalizeThemeColor(source[key], `${keyPath}.syntax.${key}`);
    if (value !== undefined) {
      syntax[key] = value;
    }
  }

  return Object.keys(syntax).length > 0 ? syntax : undefined;
}

/** Read exact Shiki/TextMate scope colors from a theme's `syntax_scopes` TOML table. */
function readCustomSyntaxScopes(
  source: Record<string, unknown>,
  keyPath: string,
): CustomSyntaxScopesConfig | undefined {
  const syntaxScopes: CustomSyntaxScopesConfig = {};

  for (const [scope, rawColor] of Object.entries(source)) {
    if (scope.trim().length === 0) {
      throw new Error(`Expected ${keyPath}.syntax_scopes keys to be non-empty Shiki scopes.`);
    }

    const color = normalizeThemeColor(rawColor, `${keyPath}.syntax_scopes.${scope}`);
    if (color !== undefined) {
      syntaxScopes[scope] = color;
    }
  }

  return Object.keys(syntaxScopes).length > 0 ? syntaxScopes : undefined;
}

interface CustomThemeTable {
  theme: NamedCustomThemeConfig;
  usesLegacySyntax: boolean;
}

/**
 * Read one custom theme TOML table into a named theme.
 *
 * `keyPath` is the table's own path (`custom_theme` or `themes.<id>`) so every
 * validation error names the key the user actually wrote.
 */
function readCustomThemeTable(
  source: Record<string, unknown>,
  id: string,
  keyPath: string,
): CustomThemeTable {
  const legacySyntaxSource = source.syntax;
  if (legacySyntaxSource !== undefined && !isRecord(legacySyntaxSource)) {
    throw new Error(`Expected ${keyPath}.syntax to contain a TOML table.`);
  }

  const syntaxScopesSource = source.syntax_scopes;
  if (syntaxScopesSource !== undefined && !isRecord(syntaxScopesSource)) {
    throw new Error(`Expected ${keyPath}.syntax_scopes to contain a TOML table.`);
  }

  const theme: NamedCustomThemeConfig = {
    id,
    base: normalizeCustomThemeBase(source.base, keyPath),
  };
  const label = normalizeString(source.label);
  if (label !== undefined) {
    theme.label = label;
  }

  for (const key of CUSTOM_THEME_COLOR_KEYS) {
    const value = normalizeThemeColor(source[key], `${keyPath}.${key}`);
    if (value !== undefined) {
      theme[key] = value;
    }
  }

  const legacySyntax = isRecord(legacySyntaxSource)
    ? readLegacyCustomSyntaxColors(legacySyntaxSource, keyPath)
    : undefined;
  const exactSyntaxScopes = isRecord(syntaxScopesSource)
    ? readCustomSyntaxScopes(syntaxScopesSource, keyPath)
    : undefined;
  const syntaxScopes = resolveSyntaxScopeOverrides(legacySyntax, exactSyntaxScopes);
  if (syntaxScopes) {
    // Normalize legacy config at the boundary so every runtime highlighter uses raw scopes only.
    theme.syntaxScopes = syntaxScopes;
  }

  return {
    theme,
    usesLegacySyntax: Boolean(legacySyntax),
  };
}

interface CustomThemeLayer {
  /** `[custom_theme]` first, then `[themes.<id>]` tables in file order. */
  themes: NamedCustomThemeConfig[];
  usesLegacySyntax: boolean;
  notices: StartupNotice[];
}

/** Read every custom theme one config layer declares, skipping unusable ids with a notice. */
function readCustomThemes(source: Record<string, unknown>): CustomThemeLayer {
  const themes: NamedCustomThemeConfig[] = [];
  const notices: StartupNotice[] = [];
  let usesLegacySyntax = false;

  const legacyThemeSource = source.custom_theme;
  if (legacyThemeSource !== undefined && !isRecord(legacyThemeSource)) {
    throw new Error("Expected custom_theme to contain a TOML table.");
  }

  if (isRecord(legacyThemeSource)) {
    const read = readCustomThemeTable(legacyThemeSource, LEGACY_CUSTOM_THEME_ID, "custom_theme");
    themes.push(read.theme);
    usesLegacySyntax ||= read.usesLegacySyntax;
  }

  const namedThemeSource = source.themes;
  if (namedThemeSource !== undefined && !isRecord(namedThemeSource)) {
    throw new Error("Expected themes to contain named TOML tables.");
  }

  if (isRecord(namedThemeSource)) {
    for (const [id, table] of Object.entries(namedThemeSource)) {
      if (!isRecord(table)) {
        throw new Error(`Expected [themes.${id}] to contain a TOML table.`);
      }

      const issue = describeCustomThemeIdIssue(id);
      if (issue) {
        notices.push(createInvalidThemeIdNotice("config", id, issue));
        continue;
      }

      // The original single-slot table keeps the `custom` id it has always owned.
      if (themes.some((theme) => theme.id === id)) {
        notices.push(createThemeCollisionNotice("config", id, "[custom_theme]"));
        continue;
      }

      const read = readCustomThemeTable(table, id, `themes.${id}`);
      themes.push(read.theme);
      usesLegacySyntax ||= read.usesLegacySyntax;
    }
  }

  return { themes, usesLegacySyntax, notices };
}

/** Merge two layers of one theme while keeping exact syntax scope overrides field-based. */
function mergeCustomTheme(
  base: NamedCustomThemeConfig,
  overrides: NamedCustomThemeConfig,
): NamedCustomThemeConfig {
  return {
    ...base,
    ...overrides,
    id: base.id,
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

/**
 * Layer one config layer's themes over the themes resolved so far.
 *
 * Same-id themes merge field by field with the later layer winning, exactly
 * like every other layered option; new ids keep their declaration order.
 */
function mergeCustomThemeLayer(
  base: NamedCustomThemeConfig[],
  overrides: readonly NamedCustomThemeConfig[],
): NamedCustomThemeConfig[] {
  const merged = [...base];

  for (const override of overrides) {
    const index = merged.findIndex((theme) => theme.id === override.id);
    if (index < 0) {
      merged.push(override);
      continue;
    }

    merged[index] = mergeCustomTheme(merged[index]!, override);
  }

  return merged;
}

/**
 * Combine config-sourced startup notices.
 *
 * Returns the shared legacy-notice array identity when nothing else needs
 * reporting, so unchanged config reloads do not restart the notice queue.
 */
function buildConfigStartupNotices(
  usesLegacyCustomSyntax: boolean,
  configNotices: readonly StartupNotice[],
): readonly StartupNotice[] | undefined {
  if (configNotices.length === 0) {
    return usesLegacyCustomSyntax ? LEGACY_CUSTOM_SYNTAX_NOTICES : undefined;
  }

  return usesLegacyCustomSyntax
    ? [...LEGACY_CUSTOM_SYNTAX_NOTICES, ...configNotices]
    : [...configNotices];
}

/** One config layer's extension settings, before user/repo layers are merged. */
interface ExtensionsLayer {
  enabled?: boolean;
  paths: string[];
  extensionConfigs: Record<string, Record<string, unknown>>;
}

/** Accept only non-empty strings from a TOML string array, ignoring other entries. */
function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * Read one config layer's `[extensions]` section and its `[extension.<id>]` tables.
 *
 * Per-extension tables stay opaque `Record<string, unknown>` payloads: they
 * belong to the extension, not to Hunk, so unknown keys pass straight through.
 */
function readExtensionsLayer(source: Record<string, unknown>): ExtensionsLayer {
  const extensionsSource = source.extensions;
  if (extensionsSource !== undefined && !isRecord(extensionsSource)) {
    throw new Error("Expected extensions to contain a TOML table.");
  }

  const perExtensionSource = source.extension;
  if (perExtensionSource !== undefined && !isRecord(perExtensionSource)) {
    throw new Error("Expected extension to contain per-extension TOML tables.");
  }

  const extensionConfigs: Record<string, Record<string, unknown>> = {};
  if (isRecord(perExtensionSource)) {
    for (const [extensionId, table] of Object.entries(perExtensionSource)) {
      if (!isRecord(table)) {
        throw new Error(`Expected [extension.${extensionId}] to contain a TOML table.`);
      }

      extensionConfigs[extensionId] = table;
    }
  }

  return {
    enabled: isRecord(extensionsSource) ? normalizeBoolean(extensionsSource.enabled) : undefined,
    paths: isRecord(extensionsSource) ? normalizeStringArray(extensionsSource.paths) : [],
    extensionConfigs,
  };
}

/**
 * Report the extensions whose settings the repository under review contributes.
 *
 * `[extension.<id>]` tables merge repo-over-user by id, with no notion of where
 * the extension itself was installed from, so a repository can steer the
 * configuration of a globally installed extension. Repo-level tuning of a
 * shared extension is a legitimate team workflow, so this is surfaced rather
 * than blocked — but it is surfaced, because that config can carry
 * exec-adjacent values such as binary paths.
 */
function createRepoExtensionConfigNotice(
  repoExtensionConfigs: Record<string, Record<string, unknown>>,
): StartupNotice | undefined {
  const ids = Object.entries(repoExtensionConfigs)
    .filter(([, table]) => Object.keys(table).length > 0)
    .map(([extensionId]) => extensionId)
    .sort();
  if (ids.length === 0) {
    return undefined;
  }

  // Table names come from the repo, so they are untrusted terminal-bound text.
  const listed = sanitizeTerminalLine(ids.join(", "));
  return {
    key: `extension:repo-config:${listed}`,
    message: `Repo config overrides settings for extension(s): ${listed}`,
  };
}

/** Merge two per-extension config maps so repo tables override user tables key by key. */
function mergeExtensionConfigs(
  base: Record<string, Record<string, unknown>>,
  overrides: Record<string, Record<string, unknown>>,
) {
  const merged: Record<string, Record<string, unknown>> = { ...base };
  for (const [extensionId, table] of Object.entries(overrides)) {
    merged[extensionId] = { ...merged[extensionId], ...table };
  }

  return merged;
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
    tabWidth: normalizeTabWidth(source.tab_width),
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
    experimental: overrides.experimental ?? base.experimental,
    excludeUntracked: overrides.excludeUntracked ?? base.excludeUntracked,
    lineNumbers: overrides.lineNumbers ?? base.lineNumbers,
    tabWidth: overrides.tabWidth ?? base.tabWidth,
    wrapLines: overrides.wrapLines ?? base.wrapLines,
    hunkHeaders: overrides.hunkHeaders ?? base.hunkHeaders,
    menuBar: overrides.menuBar ?? base.menuBar,
    agentNotes: overrides.agentNotes ?? base.agentNotes,
    copyDecorations: overrides.copyDecorations ?? base.copyDecorations,
    promptSaveViewPreferences:
      overrides.promptSaveViewPreferences ?? base.promptSaveViewPreferences,
    transparentBackground: overrides.transparentBackground ?? base.transparentBackground,
    colorMoved: overrides.colorMoved ?? base.colorMoved,
    extensions: overrides.extensions ?? base.extensions,
    extensionPaths: overrides.extensionPaths ?? base.extensionPaths,
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
  let resolvedCustomThemes: NamedCustomThemeConfig[] = [];
  let usesLegacyCustomSyntax = false;
  const themeNotices = new Map<string, StartupNotice>();
  let userExtensionsLayer: ExtensionsLayer = { paths: [], extensionConfigs: {} };
  let repoExtensionsLayer: ExtensionsLayer = { paths: [], extensionConfigs: {} };

  let resolvedOptions: CommonOptions = {
    mode: DEFAULT_VIEW_PREFERENCES.mode,
    vcs: detectRepoVcsMode(cwd),
    // Keep the built-in theme default explicit so stdin-backed startup paths do not depend on
    // renderer theme-mode detection for their initial palette.
    theme: "github-dark-default",
    agentContext: input.options.agentContext,
    pager: input.options.pager ?? false,
    watch: input.options.watch ?? false,
    experimental: false,
    excludeUntracked: false,
    lineNumbers: DEFAULT_VIEW_PREFERENCES.showLineNumbers,
    tabWidth: DEFAULT_TAB_WIDTH,
    wrapLines: DEFAULT_VIEW_PREFERENCES.wrapLines,
    hunkHeaders: DEFAULT_VIEW_PREFERENCES.showHunkHeaders,
    menuBar: DEFAULT_VIEW_PREFERENCES.showMenuBar,
    agentNotes: DEFAULT_VIEW_PREFERENCES.showAgentNotes,
    copyDecorations: DEFAULT_VIEW_PREFERENCES.copyDecorations,
    promptSaveViewPreferences: true,
    transparentBackground: false,
  };

  /** Fold one parsed config layer's themes into the resolved list and notice set. */
  const applyCustomThemeLayer = (layer: CustomThemeLayer) => {
    resolvedCustomThemes = mergeCustomThemeLayer(resolvedCustomThemes, layer.themes);
    usesLegacyCustomSyntax ||= layer.usesLegacySyntax;
    for (const notice of layer.notices) {
      themeNotices.set(notice.key, notice);
    }
  };

  // The merged `vcs` value loses track of who chose it, so record every layer
  // that names one explicitly, in the same last-layer-wins order options merge.
  let explicitVcsId: string | undefined;

  if (userConfigPath) {
    const userConfig = readTomlRecord(userConfigPath);
    const userLayer = resolveConfigLayer(userConfig, input);
    explicitVcsId = userLayer.vcs ?? explicitVcsId;
    resolvedOptions = mergeOptions(resolvedOptions, userLayer);
    applyCustomThemeLayer(readCustomThemes(userConfig));
    userExtensionsLayer = readExtensionsLayer(userConfig);
  }

  if (repoConfigPath) {
    const repoConfig = readTomlRecord(repoConfigPath);
    const repoLayer = resolveConfigLayer(repoConfig, input);
    explicitVcsId = repoLayer.vcs ?? explicitVcsId;
    resolvedOptions = mergeOptions(resolvedOptions, repoLayer);
    applyCustomThemeLayer(readCustomThemes(repoConfig));
    repoExtensionsLayer = readExtensionsLayer(repoConfig);
  }

  explicitVcsId = input.options.vcs ?? explicitVcsId;
  resolvedOptions = mergeOptions(resolvedOptions, input.options);
  resolvedOptions = {
    ...resolvedOptions,
    agentContext: input.options.agentContext,
    pager: input.options.pager ?? false,
    watch: input.options.watch ?? resolvedOptions.watch ?? false,
    experimental: input.options.experimental ?? false,
    excludeUntracked: resolvedOptions.excludeUntracked ?? false,
    theme: resolvedOptions.theme,
    vcs: resolvedOptions.vcs ?? getDefaultVcsAdapter().id,
    mode: resolvedOptions.mode ?? DEFAULT_VIEW_PREFERENCES.mode,
    lineNumbers: resolvedOptions.lineNumbers ?? DEFAULT_VIEW_PREFERENCES.showLineNumbers,
    tabWidth: resolvedOptions.tabWidth ?? DEFAULT_TAB_WIDTH,
    wrapLines: resolvedOptions.wrapLines ?? DEFAULT_VIEW_PREFERENCES.wrapLines,
    hunkHeaders: resolvedOptions.hunkHeaders ?? DEFAULT_VIEW_PREFERENCES.showHunkHeaders,
    menuBar: resolvedOptions.menuBar ?? DEFAULT_VIEW_PREFERENCES.showMenuBar,
    agentNotes: resolvedOptions.agentNotes ?? DEFAULT_VIEW_PREFERENCES.showAgentNotes,
    copyDecorations: resolvedOptions.copyDecorations ?? DEFAULT_VIEW_PREFERENCES.copyDecorations,
    promptSaveViewPreferences: resolvedOptions.promptSaveViewPreferences ?? true,
    transparentBackground: resolvedOptions.transparentBackground ?? false,
    colorMoved: resolvedOptions.colorMoved,
  };

  // Only the legacy `custom` id is a hard error: every other unknown id may still name a theme an
  // extension contributes later, so those fall back to the default theme instead of failing startup.
  if (
    resolvedOptions.theme === LEGACY_CUSTOM_THEME_ID &&
    !resolvedCustomThemes.some((theme) => theme.id === LEGACY_CUSTOM_THEME_ID)
  ) {
    throw new Error('Expected a [custom_theme] table when config selects theme = "custom".');
  }

  const extensions: ExtensionsConfig = {
    // `--no-extensions` is a hard off switch; otherwise repo config overrides user config
    // exactly like every other layered option.
    enabled:
      input.options.extensions === false
        ? false
        : (repoExtensionsLayer.enabled ?? userExtensionsLayer.enabled ?? true),
    paths: userExtensionsLayer.paths,
    repoPaths: repoExtensionsLayer.paths,
    extensionConfigs: mergeExtensionConfigs(
      userExtensionsLayer.extensionConfigs,
      repoExtensionsLayer.extensionConfigs,
    ),
  };
  const repoExtensionConfigNotice = createRepoExtensionConfigNotice(
    repoExtensionsLayer.extensionConfigs,
  );
  const repoExtensionConfigNotices = repoExtensionConfigNotice ? [repoExtensionConfigNotice] : [];

  return {
    input: {
      ...input,
      options: resolvedOptions,
    },
    customThemes: resolvedCustomThemes,
    extensions,
    explicitVcsId,
    startupNotices: buildConfigStartupNotices(usesLegacyCustomSyntax, [
      ...themeNotices.values(),
      ...repoExtensionConfigNotices,
    ]),
    globalConfigPath: userConfigPath,
    repoConfigPath,
    // Persist in the repo config only when the repo already has one; otherwise keep personal view
    // choices user-scoped so Hunk does not create project policy files from an interactive prompt.
    viewPreferencesConfigPath:
      repoConfigPath && fs.existsSync(repoConfigPath) ? repoConfigPath : userConfigPath,
  };
}
