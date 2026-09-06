import fs from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { BUNDLED_SHIKI_THEME_IDS, LEGACY_THEME_ID_ALIASES } from "../theme/catalog";
import {
  createInvalidThemeIdNotice,
  createThemeCollisionNotice,
  CUSTOM_THEME_COLOR_KEYS,
  describeCustomThemeIdIssue,
  describeThemeColorIssue,
  LEGACY_CUSTOM_THEME_ID,
  normalizeThemeColorValue,
  resolveThemeBase,
} from "../theme/customThemes";
import {
  LEGACY_CUSTOM_SYNTAX_COLOR_KEYS,
  resolveSyntaxScopeOverrides,
} from "../theme/legacySyntaxScopes";
import { resolveGlobalConfigPath } from "./paths";
import { LEGACY_CUSTOM_SYNTAX_NOTICES, type StartupNotice } from "../process/startupNotice";
import {
  DEFAULT_FILE_GAP,
  DEFAULT_HUNK_GAP,
  MAX_REVIEW_GAP,
  MIN_REVIEW_GAP,
  validateReviewGap,
} from "./reviewGap";
import { DEFAULT_TAB_WIDTH, validateTabWidth } from "./tabWidth";
import { findProjectRootCandidate } from "../process/projectRoot";
import { createVcsCatalog, detectVcs } from "../vcs";
import type { VcsCatalog } from "../vcs/types";
import type {
  CustomSyntaxColorsConfig,
  CustomSyntaxScopesConfig,
  NamedCustomThemeConfig,
} from "../../extension-api/types";
import type {
  CliInput,
  CommonOptions,
  CursorLine,
  LayoutMode,
  SidebarVisibility,
  VcsMode,
} from "./commandInputs";

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
 * `packages/hunk/src/ui/lib/keymap.ts`.
 */
export type UserKeyBinding = string | readonly string[] | false;

/** The view options a session persists back to config when the reader saves them. */
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

export const BUILT_IN_THEME_IDS = BUNDLED_SHIKI_THEME_IDS;
// Widen the large literal tuple before formatting it, avoiding TypeScript's deep tuple inference.
const BUILT_IN_THEME_IDS_FOR_MESSAGES: readonly string[] = BUILT_IN_THEME_IDS;
const DEFAULT_THEME_ID = "github-dark-default";
const DEFAULT_VIEW_PREFERENCES: PersistedViewPreferences = {
  mode: "auto",
  showLineNumbers: true,
  wrapLines: false,
  showHunkHeaders: true,
  showMenuBar: true,
  showAgentNotes: false,
  copyDecorations: false,
  cursorLine: "row",
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
  { configKey: "cursor_line", value: (preferences) => preferences.cursorLine },
];

export interface ConfigResolutionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Base catalog available before user extensions load. */
  vcsCatalog?: VcsCatalog;
}

export interface ExtensionBootstrapConfigResolution {
  extensions: ExtensionsConfig;
  projectRoot?: string;
  globalConfigPath?: string;
  repoConfigPath?: string;
  startupNotices?: readonly StartupNotice[];
}

export interface ExtensionBootstrapConfigOptions extends ConfigResolutionOptions {
  /** False when a leading host `--no-extensions` flag hard-disables loading. */
  extensionsEnabled?: boolean;
}

const CONFIG_FALLBACK_VCS_ID = "git";
const EMPTY_CONFIG_VCS_CATALOG = createVcsCatalog([], CONFIG_FALLBACK_VCS_ID, []);

export interface HunkConfigResolution {
  input: CliInput;
  /** Config-defined custom themes in declaration order, user layer before repo layer. */
  customThemes: NamedCustomThemeConfig[];
  extensions: ExtensionsConfig;
  /**
   * The user's `[keybindings]` table: command id to chord(s), or `false` to unbind.
   *
   * User layer only. Keys are a property of the machine a person types on, not
   * of the repository under review, so a checkout cannot rearrange the reader's
   * keyboard.
   */
  keybindings: Record<string, UserKeyBinding>;
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
  /** Project root selected from `.hunk` or the base VCS catalog. */
  projectRoot?: string;
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

/** Accept only the current-line styles the review stream can draw. */
function normalizeCursorLine(value: unknown): CursorLine | undefined {
  return value === "row" || value === "number" || value === "off" ? value : undefined;
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

/** Accept a plain boolean, or `auto` for responsive behavior. */
function normalizeSidebarVisibility(value: unknown): SidebarVisibility | undefined {
  return typeof value === "boolean" || value === "auto" ? value : undefined;
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

/** Accept a bounded integer file or hunk gap from TOML configuration. */
function normalizeReviewGap(value: unknown, key: "file_gap" | "hunk_gap") {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `Expected ${key} to be an integer from ${MIN_REVIEW_GAP} to ${MAX_REVIEW_GAP}.`,
    );
  }

  return validateReviewGap(value, key);
}

/** One top-level configuration key shared by runtime parsing and generated reference docs. */
export interface ConfigReferenceOption {
  readonly key: string;
  readonly property: keyof CommonOptions;
  readonly type: string;
  readonly accepted: string;
  /** Concrete built-in value consumed by runtime resolution and rendered by generated docs. */
  readonly runtimeDefault?: string | number | boolean;
  /** Human-readable default for dynamic behavior such as VCS detection. */
  readonly defaultValue?: string;
  readonly description: string;
  readonly aliases?: readonly { key: string; deprecated?: boolean }[];
  /** Ordered source keys preserve compatibility precedence where an old alias historically won. */
  readonly runtimeKeys?: readonly string[];
}

/**
 * Authoritative top-level preference catalog. Runtime parsing iterates this table, while the docs
 * generator renders the same keys, accepted values, defaults, aliases, and descriptions.
 */
export const CONFIG_REFERENCE_OPTIONS: readonly ConfigReferenceOption[] = [
  {
    key: "mode",
    property: "mode",
    type: "string",
    accepted: "`auto`, `split`, or `stack`",
    runtimeDefault: DEFAULT_VIEW_PREFERENCES.mode,
    description: "Choose responsive, side-by-side, or stacked diff layout.",
  },
  {
    key: "cursor_line",
    property: "cursorLine",
    type: "string",
    accepted: "`row`, `number`, or `off`",
    runtimeDefault: DEFAULT_VIEW_PREFERENCES.cursorLine,
    description:
      "Mark the current line as a full-row highlight or on its line number. `off` restores plain `j`/`k` scrolling.",
  },
  {
    key: "vcs",
    property: "vcs",
    type: "string",
    accepted: "`git`, `jj`, `sl`, or an id a loaded extension backend registers",
    defaultValue: "detected from the checkout (Git fallback)",
    description:
      "Select the version-control adapter explicitly. An explicit id outranks detection; an id no loaded backend owns falls back to detection with a startup notice.",
  },
  {
    key: "theme",
    property: "theme",
    type: "string",
    accepted: "a built-in theme id or `custom`",
    runtimeDefault: DEFAULT_THEME_ID,
    description: "Select the active color theme.",
  },
  {
    key: "watch",
    property: "watch",
    type: "boolean",
    accepted: "`true` or `false`",
    runtimeDefault: false,
    description: "Reload supported review inputs when their source changes.",
  },
  {
    key: "exclude_untracked",
    property: "excludeUntracked",
    type: "boolean",
    accepted: "`true` or `false`",
    runtimeDefault: false,
    description: "Hide untracked files from working-tree reviews.",
  },
  {
    key: "line_numbers",
    property: "lineNumbers",
    type: "boolean",
    accepted: "`true` or `false`",
    runtimeDefault: DEFAULT_VIEW_PREFERENCES.showLineNumbers,
    description: "Show old and new line-number columns.",
  },
  {
    key: "tab_width",
    property: "tabWidth",
    type: "integer",
    accepted: "1 through 16",
    runtimeDefault: DEFAULT_TAB_WIDTH,
    description: "Set terminal-cell tab stops used for display and wrapping.",
  },
  {
    key: "file_gap",
    property: "fileGap",
    type: "integer",
    accepted: `${MIN_REVIEW_GAP} through ${MAX_REVIEW_GAP}`,
    runtimeDefault: DEFAULT_FILE_GAP,
    description:
      "Rows between files in the review stream, including the `─` rule. `1` keeps the current rule; `0` hides it; larger values add blank rows above it.",
  },
  {
    key: "hunk_gap",
    property: "hunkGap",
    type: "integer",
    accepted: `${MIN_REVIEW_GAP} through ${MAX_REVIEW_GAP}`,
    runtimeDefault: DEFAULT_HUNK_GAP,
    description: "Blank rows before each hunk after the first in a file.",
  },
  {
    key: "wrap_lines",
    property: "wrapLines",
    type: "boolean",
    accepted: "`true` or `false`",
    runtimeDefault: DEFAULT_VIEW_PREFERENCES.wrapLines,
    description: "Wrap long diff lines instead of keeping one visual row.",
  },
  {
    key: "hunk_headers",
    property: "hunkHeaders",
    type: "boolean",
    accepted: "`true` or `false`",
    runtimeDefault: DEFAULT_VIEW_PREFERENCES.showHunkHeaders,
    description: "Show hunk metadata rows in the review stream.",
  },
  {
    key: "menu_bar",
    property: "menuBar",
    type: "boolean",
    accepted: "`true` or `false`",
    runtimeDefault: DEFAULT_VIEW_PREFERENCES.showMenuBar,
    description: "Show the top application menu bar.",
  },
  {
    key: "sidebar",
    property: "sidebar",
    type: "string or boolean",
    accepted: '`"auto"`, `true`, or `false`',
    runtimeDefault: "auto",
    description:
      "Show the files pane if it fits, keep it closed, or let the responsive layout decide. Pager sessions always open with the files pane closed.",
  },
  {
    key: "agent_notes",
    property: "agentNotes",
    type: "boolean",
    accepted: "`true` or `false`",
    runtimeDefault: DEFAULT_VIEW_PREFERENCES.showAgentNotes,
    description: "Show agent notes when a review opens.",
  },
  {
    key: "copy_decorations",
    property: "copyDecorations",
    type: "boolean",
    accepted: "`true` or `false`",
    runtimeDefault: DEFAULT_VIEW_PREFERENCES.copyDecorations,
    description: "Include diff signs and line numbers in copied selections.",
  },
  {
    key: VIEW_PREFERENCES_PROMPT_CONFIG_KEY,
    property: "promptSaveViewPreferences",
    type: "boolean",
    accepted: "`true` or `false`",
    runtimeDefault: true,
    description: "Ask before discarding view changes that can be persisted.",
  },
  {
    key: "transparent_background",
    property: "transparentBackground",
    type: "boolean",
    accepted: "`true` or `false`",
    runtimeDefault: false,
    description: "Let the terminal background show through Hunk surfaces.",
    aliases: [{ key: "transparentBackground", deprecated: true }],
    runtimeKeys: ["transparentBackground", "transparent_background"],
  },
  {
    key: "color_moved",
    property: "colorMoved",
    type: "boolean",
    accepted: "`true` or `false`",
    description: "Enable moved-line coloring when the renderer supports it.",
  },
] as const;

/** Command-specific TOML tables accepted by the runtime resolver. */
export const CONFIG_COMMAND_SECTIONS = {
  vcs: "working-tree and target reviews (`hunk diff`)",
  show: "commit and target display reviews (`hunk show`)",
  "stash-show": "stash reviews (`hunk stash show`)",
  diff: "two-file comparisons (`hunk diff --files <left> <right>`)",
  patch: "patch-file reviews (`hunk patch`)",
  difftool: "Git difftool pair reviews (`hunk difftool`)",
} as const satisfies Record<CliInput["kind"], string>;

/** Reference metadata for the root-only custom-theme tables. */
export const CONFIG_REFERENCE_CUSTOM_THEME = {
  table: "custom_theme",
  baseValues: BUILT_IN_THEME_IDS,
  defaultBase: DEFAULT_THEME_ID,
  legacyBaseAliases: LEGACY_THEME_ID_ALIASES,
  colorKeys: CUSTOM_THEME_COLOR_KEYS,
  legacySyntaxColorKeys: LEGACY_CUSTOM_SYNTAX_COLOR_KEYS,
  syntaxScopesTable: "custom_theme.syntax_scopes",
  legacySyntaxTable: "custom_theme.syntax",
  /** Multi-theme tables; each `[themes.<id>]` accepts the same keys as `[custom_theme]`. */
  namedThemeTable: "themes",
} as const;

/** One TOML key inside a named section table, shared by runtime parsing and generated docs. */
export interface ConfigReferenceSectionKey {
  readonly key: string;
  readonly type: string;
  readonly accepted: string;
  readonly defaultValue?: string;
  readonly description: string;
}

/**
 * Reference metadata for the extension tables `readExtensionsLayer` parses.
 *
 * These live outside `CONFIG_REFERENCE_OPTIONS` because they are section tables
 * rather than layered `CommonOptions` preference keys, but they are cataloged
 * here for the same reason: the generated reference and the parser should never
 * be able to disagree about which extension settings exist.
 */
export const CONFIG_REFERENCE_EXTENSIONS = {
  table: "extensions",
  perExtensionTable: "extension",
  keys: [
    {
      key: "extensions.enabled",
      type: "boolean",
      accepted: "`true` or `false`",
      defaultValue: "`true`",
      description:
        "Load user extensions. `--no-extensions` forces this off for one run, and bundled VCS backends stay loaded either way.",
    },
    {
      key: "extensions.paths",
      type: "array of strings",
      accepted: "entry file or directory paths",
      defaultValue: "`[]`",
      description:
        "Extension entry points loaded at startup. Paths a repository config contributes are trust-gated before they run.",
    },
  ] as const satisfies readonly ConfigReferenceSectionKey[],
} as const;

/**
 * Accept only #rrggbb theme colors and report the failing TOML key path.
 *
 * The rule itself lives in `./theme/customThemes` so config tables and extension
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
      `Expected ${keyPath}.base to be a built-in theme id. Known themes: ${BUILT_IN_THEME_IDS_FOR_MESSAGES.join(", ")}.`,
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
    base: overrides.base ?? base.base ?? DEFAULT_THEME_ID,
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

/** One config layer's `[keybindings]` table, with the entries it could not use. */
interface KeybindingsLayer {
  bindings: Record<string, UserKeyBinding>;
  /** Command ids whose value was neither a chord, a list of chords, nor `false`. */
  unusableIds: string[];
}

/**
 * Read one config layer's `[keybindings]` table.
 *
 * Values stay close to what TOML can express: a chord, a list of chords, or
 * `false` to unbind. Whether the ids name real commands is not knowable here —
 * extension commands do not exist until extensions load — so id validation
 * belongs to keymap resolution, and this layer only rejects shapes.
 */
function readKeybindingsLayer(source: Record<string, unknown>): KeybindingsLayer {
  const keybindingsSource = source.keybindings;
  if (keybindingsSource !== undefined && !isRecord(keybindingsSource)) {
    throw new Error("Expected keybindings to contain a TOML table.");
  }

  const bindings: Record<string, UserKeyBinding> = {};
  const unusableIds: string[] = [];
  if (!isRecord(keybindingsSource)) {
    return { bindings, unusableIds };
  }

  for (const [commandId, value] of Object.entries(keybindingsSource)) {
    if (value === false || typeof value === "string") {
      bindings[commandId] = value;
      continue;
    }

    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      bindings[commandId] = value as string[];
      continue;
    }

    unusableIds.push(commandId);
  }

  return { bindings, unusableIds };
}

/** Report `[keybindings]` entries whose value Hunk could not read as a binding. */
function createUnusableKeybindingNotice(unusableIds: readonly string[]): StartupNotice | undefined {
  if (unusableIds.length === 0) {
    return undefined;
  }

  const listed = sanitizeTerminalLine([...unusableIds].sort().join(", "));
  return {
    key: `keybindings:unusable:${listed}`,
    message:
      `Ignored [keybindings] entries with unsupported values: ${listed}. ` +
      "Use a chord string, a list of chords, or false to unbind.",
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

/** Merge user and repo extension layers while honoring the invocation hard-off switch. */
function resolveExtensionsConfig(
  userLayer: ExtensionsLayer,
  repoLayer: ExtensionsLayer,
  extensionsEnabled: boolean | undefined,
): ExtensionsConfig {
  return {
    enabled: extensionsEnabled === false ? false : (repoLayer.enabled ?? userLayer.enabled ?? true),
    paths: userLayer.paths,
    repoPaths: repoLayer.paths,
    extensionConfigs: mergeExtensionConfigs(userLayer.extensionConfigs, repoLayer.extensionConfigs),
  };
}

/** Normalize one cataloged config value according to its runtime property. */
function normalizeConfigReferenceValue(property: keyof CommonOptions, value: unknown) {
  switch (property) {
    case "mode":
      return normalizeLayoutMode(value);
    case "cursorLine":
      return normalizeCursorLine(value);
    case "vcs":
      return normalizeVcsMode(value);
    case "theme":
      return normalizeString(value);
    case "tabWidth":
      return normalizeTabWidth(value);
    case "fileGap":
      return normalizeReviewGap(value, "file_gap");
    case "hunkGap":
      return normalizeReviewGap(value, "hunk_gap");
    case "sidebar":
      return normalizeSidebarVisibility(value);
    default:
      return normalizeBoolean(value);
  }
}

/** Read the view preferences stored at one TOML object level. */
function readConfigPreferences(source: Record<string, unknown>): CommonOptions {
  const preferences: CommonOptions = {};
  const mutable = preferences as Record<string, unknown>;

  for (const option of CONFIG_REFERENCE_OPTIONS) {
    const runtimeKeys = option.runtimeKeys ?? [
      option.key,
      ...(option.aliases?.map(({ key }) => key) ?? []),
    ];
    let normalized: unknown;
    for (const key of runtimeKeys) {
      normalized = normalizeConfigReferenceValue(option.property, source[key]);
      if (normalized !== undefined) {
        break;
      }
    }
    mutable[option.property] = normalized;
  }

  return preferences;
}

/** Build concrete preference defaults from the same catalog rendered by generated docs. */
function buildDefaultConfigPreferences(cwd: string, vcsCatalog: VcsCatalog): CommonOptions {
  const defaults: CommonOptions = { vcs: detectRepoVcsMode(cwd, vcsCatalog) };
  const mutable = defaults as Record<string, unknown>;
  for (const option of CONFIG_REFERENCE_OPTIONS) {
    if (option.runtimeDefault !== undefined) {
      mutable[option.property] = option.runtimeDefault;
    }
  }
  return defaults;
}

/** Merge partial preference layers with right-hand overrides taking precedence. */
function mergeOptions(base: CommonOptions, overrides: CommonOptions): CommonOptions {
  return {
    ...base,
    mode: overrides.mode ?? base.mode,
    cursorLine: overrides.cursorLine ?? base.cursorLine,
    vcs: overrides.vcs ?? base.vcs,
    theme: overrides.theme ?? base.theme,
    agentContext: overrides.agentContext ?? base.agentContext,
    pager: overrides.pager ?? base.pager,
    watch: overrides.watch ?? base.watch,
    experimental: overrides.experimental ?? base.experimental,
    fast: overrides.fast ?? base.fast,
    excludeUntracked: overrides.excludeUntracked ?? base.excludeUntracked,
    lineNumbers: overrides.lineNumbers ?? base.lineNumbers,
    tabWidth: overrides.tabWidth ?? base.tabWidth,
    fileGap: overrides.fileGap ?? base.fileGap,
    hunkGap: overrides.hunkGap ?? base.hunkGap,
    wrapLines: overrides.wrapLines ?? base.wrapLines,
    hunkHeaders: overrides.hunkHeaders ?? base.hunkHeaders,
    menuBar: overrides.menuBar ?? base.menuBar,
    sidebar: overrides.sidebar ?? base.sidebar,
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

  const commandSection = CONFIG_COMMAND_SECTIONS[input.kind] ? source[input.kind] : undefined;
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
function detectRepoVcsMode(cwd: string, vcsCatalog: VcsCatalog): VcsMode {
  return detectVcs(cwd, vcsCatalog)?.id ?? vcsCatalog.defaultAdapterId;
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

interface ConfigSources {
  projectRoot?: string;
  globalConfigPath?: string;
  repoConfigPath?: string;
  userConfig?: Record<string, unknown>;
  repoConfig?: Record<string, unknown>;
}

/** Read the user and selected-project config sources once for one resolution pass. */
function readConfigSources(
  cwd: string,
  env: NodeJS.ProcessEnv,
  vcsCatalog: VcsCatalog,
): ConfigSources {
  const projectRoot = findProjectRootCandidate(cwd, vcsCatalog);
  const repoConfigPath = projectRoot ? join(projectRoot, ".hunk", "config.toml") : undefined;
  const globalConfigPath = resolveGlobalConfigPath(env);
  return {
    projectRoot,
    globalConfigPath,
    repoConfigPath,
    userConfig: globalConfigPath ? readTomlRecord(globalConfigPath) : undefined,
    repoConfig: repoConfigPath ? readTomlRecord(repoConfigPath) : undefined,
  };
}

/** Resolve only the config needed to discover an unknown extension CLI command. */
export function resolveExtensionBootstrapConfig({
  cwd = process.cwd(),
  env = process.env,
  vcsCatalog = EMPTY_CONFIG_VCS_CATALOG,
  extensionsEnabled,
}: ExtensionBootstrapConfigOptions = {}): ExtensionBootstrapConfigResolution {
  const sources = readConfigSources(cwd, env, vcsCatalog);
  const userLayer = sources.userConfig
    ? readExtensionsLayer(sources.userConfig)
    : { paths: [], extensionConfigs: {} };
  const repoLayer = sources.repoConfig
    ? readExtensionsLayer(sources.repoConfig)
    : { paths: [], extensionConfigs: {} };
  const repoNotice = createRepoExtensionConfigNotice(repoLayer.extensionConfigs);

  return {
    extensions: resolveExtensionsConfig(userLayer, repoLayer, extensionsEnabled),
    projectRoot: sources.projectRoot,
    globalConfigPath: sources.globalConfigPath,
    repoConfigPath: sources.repoConfigPath,
    startupNotices: repoNotice ? [repoNotice] : undefined,
  };
}

/** Resolve CLI input against global and repo-local config files. */
export function resolveConfiguredCliInput(
  input: CliInput,
  {
    cwd = process.cwd(),
    env = process.env,
    vcsCatalog = EMPTY_CONFIG_VCS_CATALOG,
  }: ConfigResolutionOptions = {},
): HunkConfigResolution {
  const sources = readConfigSources(cwd, env, vcsCatalog);
  const repoRoot = sources.projectRoot;
  const repoConfigPath = sources.repoConfigPath;
  const userConfigPath = sources.globalConfigPath;
  let resolvedCustomThemes: NamedCustomThemeConfig[] = [];
  let usesLegacyCustomSyntax = false;
  const themeNotices = new Map<string, StartupNotice>();
  let userExtensionsLayer: ExtensionsLayer = { paths: [], extensionConfigs: {} };
  let repoExtensionsLayer: ExtensionsLayer = { paths: [], extensionConfigs: {} };
  // Keybindings are read from the user layer only; see `HunkConfigResolution`.
  let keybindingsLayer: KeybindingsLayer = { bindings: {}, unusableIds: [] };

  let resolvedOptions: CommonOptions = {
    ...buildDefaultConfigPreferences(cwd, vcsCatalog),
    agentContext: input.options.agentContext,
    pager: input.options.pager ?? false,
    experimental: false,
    ...(input.options.pager ? { menuBar: false } : {}),
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

  if (userConfigPath && sources.userConfig) {
    const userConfig = sources.userConfig;
    const userLayer = resolveConfigLayer(userConfig, input);
    explicitVcsId = userLayer.vcs ?? explicitVcsId;
    resolvedOptions = mergeOptions(resolvedOptions, userLayer);
    applyCustomThemeLayer(readCustomThemes(userConfig));
    userExtensionsLayer = readExtensionsLayer(userConfig);
    keybindingsLayer = readKeybindingsLayer(userConfig);
  }

  if (repoConfigPath && sources.repoConfig) {
    const repoConfig = sources.repoConfig;
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
    fast: input.options.fast ?? false,
    excludeUntracked: resolvedOptions.excludeUntracked ?? false,
    theme: resolvedOptions.theme,
    vcs: resolvedOptions.vcs ?? vcsCatalog.defaultAdapterId,
    mode: resolvedOptions.mode ?? DEFAULT_VIEW_PREFERENCES.mode,
    lineNumbers: resolvedOptions.lineNumbers ?? DEFAULT_VIEW_PREFERENCES.showLineNumbers,
    tabWidth: resolvedOptions.tabWidth ?? DEFAULT_TAB_WIDTH,
    fileGap: resolvedOptions.fileGap ?? DEFAULT_FILE_GAP,
    hunkGap: resolvedOptions.hunkGap ?? DEFAULT_HUNK_GAP,
    wrapLines: resolvedOptions.wrapLines ?? DEFAULT_VIEW_PREFERENCES.wrapLines,
    hunkHeaders: resolvedOptions.hunkHeaders ?? DEFAULT_VIEW_PREFERENCES.showHunkHeaders,
    menuBar: resolvedOptions.menuBar ?? DEFAULT_VIEW_PREFERENCES.showMenuBar,
    sidebar: resolvedOptions.sidebar ?? "auto",
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

  const extensions = resolveExtensionsConfig(
    userExtensionsLayer,
    repoExtensionsLayer,
    input.options.extensions,
  );
  const repoExtensionConfigNotice = createRepoExtensionConfigNotice(
    repoExtensionsLayer.extensionConfigs,
  );
  const repoExtensionConfigNotices = repoExtensionConfigNotice ? [repoExtensionConfigNotice] : [];
  const unusableKeybindingNotice = createUnusableKeybindingNotice(keybindingsLayer.unusableIds);
  const keybindingNotices = unusableKeybindingNotice ? [unusableKeybindingNotice] : [];

  return {
    input: {
      ...input,
      options: resolvedOptions,
    },
    customThemes: resolvedCustomThemes,
    extensions,
    keybindings: keybindingsLayer.bindings,
    explicitVcsId,
    startupNotices: buildConfigStartupNotices(usesLegacyCustomSyntax, [
      ...themeNotices.values(),
      ...repoExtensionConfigNotices,
      ...keybindingNotices,
    ]),
    globalConfigPath: userConfigPath,
    projectRoot: repoRoot,
    repoConfigPath,
    // Persist in the repo config only when the repo already has one; otherwise keep personal view
    // choices user-scoped so Hunk does not create project policy files from an interactive prompt.
    viewPreferencesConfigPath:
      repoConfigPath && fs.existsSync(repoConfigPath) ? repoConfigPath : userConfigPath,
  };
}
