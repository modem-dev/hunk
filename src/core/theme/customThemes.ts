import type { StartupNotice } from "../process/startupNotice";
import type { NamedCustomThemeConfig } from "../../extension-api/types";
import { BUNDLED_SHIKI_THEME_IDS, resolveBundledShikiThemeId } from "./catalog";
import { LEGACY_CUSTOM_SYNTAX_COLOR_KEYS } from "./legacySyntaxScopes";

/** Provider-neutral shape accepted from any custom-theme registration source. */
export interface RegisteredCustomTheme {
  extensionId: string;
  theme: NamedCustomThemeConfig;
}

/** Id of the theme defined by the original single-slot `[custom_theme]` config table. */
export const LEGACY_CUSTOM_THEME_ID = "custom";

/**
 * Ids a custom theme may not claim.
 *
 * Bundled Shiki ids are taken by built-in themes, and `auto` is the reserved
 * request that means "follow the terminal background".
 */
const RESERVED_THEME_IDS: ReadonlySet<string> = new Set<string>([
  "auto",
  ...BUNDLED_SHIKI_THEME_IDS,
]);

// Widen the large literal tuple before formatting it, avoiding TypeScript's deep tuple inference.
const BUNDLED_THEME_IDS_FOR_MESSAGES: readonly string[] = BUNDLED_SHIKI_THEME_IDS;

/** Lowercase words joined by `-` or `_`, so ids stay typeable as a `--theme` value. */
const CUSTOM_THEME_ID_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/**
 * Explain why one custom theme id is unusable, or return undefined when it is fine.
 *
 * Config tables and extension registrations share this one rule so a theme id
 * that is rejected in one source is never quietly accepted from the other.
 */
export function describeCustomThemeIdIssue(id: unknown): string | undefined {
  if (typeof id !== "string" || id.length === 0) {
    return "theme ids must be non-empty strings";
  }

  if (!CUSTOM_THEME_ID_PATTERN.test(id)) {
    return "theme ids must be lowercase words separated by - or _";
  }

  if (RESERVED_THEME_IDS.has(id)) {
    return "that id belongs to a built-in theme";
  }

  return undefined;
}

/** Every color slot a theme table or `registerTheme` call may set, in declaration order. */
export const CUSTOM_THEME_COLOR_KEYS = [
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
] as const satisfies readonly (keyof NamedCustomThemeConfig)[];

/** The only color literal Hunk's renderers — and OpenTUI's FFI beneath them — accept. */
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * Explain why one value cannot be used as a theme color, or return undefined when it can.
 *
 * Every theme source funnels through this one predicate. A color that reaches
 * the renderer without matching it crashes OpenTUI's FFI at parse time, which
 * is why "the extension registered it" is not a reason to skip the check.
 */
export function describeThemeColorIssue(value: unknown): string | undefined {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? undefined
    : "must be a hex color like #112233";
}

/** Canonicalize one already-validated theme color. */
export function normalizeThemeColorValue(value: string) {
  return value.toLowerCase();
}

/**
 * Resolve the built-in theme a custom theme inherits from.
 *
 * Returns the canonical bundled id (legacy aliases resolve to their current
 * name), or an issue string when the value names no bundled theme.
 */
export function resolveThemeBase(value: unknown): { base: string } | { issue: string } {
  const resolved = typeof value === "string" ? resolveBundledShikiThemeId(value) : undefined;
  if (!resolved) {
    return {
      issue: `must be a built-in theme id. Known themes: ${BUNDLED_THEME_IDS_FOR_MESSAGES.join(", ")}`,
    };
  }

  return { base: resolved };
}

/** One theme field that failed validation, named the way the user wrote it. */
export interface CustomThemeFieldIssue {
  /** Field path relative to the theme table, e.g. `accent` or `syntaxScopes.keyword`. */
  key: string;
  reason: string;
}

/** Report whether one value is a plain object rather than null or an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate every color-bearing field of one theme, in the same terms TOML gets.
 *
 * Config themes are validated field by field as their TOML table is read, so
 * they can never reach the theme model malformed. Extension themes arrive as
 * whatever a JavaScript factory handed to `registerTheme`, so they are checked
 * here against the identical rules before they enter the session's theme list —
 * otherwise a wrong-typed color survives all the way to the renderer.
 *
 * Returns the first offending field, so the notice can name one thing to fix.
 */
export function describeCustomThemeFieldIssue(theme: unknown): CustomThemeFieldIssue | undefined {
  if (!isPlainObject(theme)) {
    return { key: "theme", reason: "must be an object" };
  }

  if (theme.label !== undefined && typeof theme.label !== "string") {
    return { key: "label", reason: "must be a string" };
  }

  if (theme.base !== undefined) {
    const resolved = resolveThemeBase(theme.base);
    if ("issue" in resolved) {
      return { key: "base", reason: resolved.issue };
    }
  }

  for (const key of CUSTOM_THEME_COLOR_KEYS) {
    const value = theme[key];
    if (value === undefined) {
      continue;
    }

    const issue = describeThemeColorIssue(value);
    if (issue) {
      return { key, reason: issue };
    }
  }

  const legacySyntax = theme.syntax;
  if (legacySyntax !== undefined) {
    if (!isPlainObject(legacySyntax)) {
      return { key: "syntax", reason: "must be an object" };
    }

    for (const key of LEGACY_CUSTOM_SYNTAX_COLOR_KEYS) {
      const value = legacySyntax[key];
      if (value === undefined) {
        continue;
      }

      const issue = describeThemeColorIssue(value);
      if (issue) {
        return { key: `syntax.${key}`, reason: issue };
      }
    }
  }

  const syntaxScopes = theme.syntaxScopes;
  if (syntaxScopes !== undefined) {
    if (!isPlainObject(syntaxScopes)) {
      return { key: "syntaxScopes", reason: "must be an object" };
    }

    for (const [scope, color] of Object.entries(syntaxScopes)) {
      if (scope.trim().length === 0) {
        return { key: "syntaxScopes", reason: "keys must be non-empty Shiki scopes" };
      }

      const issue = describeThemeColorIssue(color);
      if (issue) {
        return { key: `syntaxScopes.${scope}`, reason: issue };
      }
    }
  }

  return undefined;
}

/** Report one theme skipped because a field failed the shared color rules. */
export function createInvalidThemeFieldNotice(
  source: string,
  id: string,
  issue: CustomThemeFieldIssue,
): StartupNotice {
  return {
    key: `theme:invalid-field:${source}:${id}:${issue.key}`,
    message: `Skipped theme "${id}" from ${source} • ${issue.key} ${issue.reason}`,
  };
}

/**
 * Canonicalize one validated theme's colors the way config normalization does.
 *
 * TOML themes are lowercased and base-resolved as they are read, so extension
 * themes are put through the same normalization here rather than reaching the
 * theme model in whatever casing the factory happened to write.
 */
function normalizeValidatedTheme(theme: NamedCustomThemeConfig): NamedCustomThemeConfig {
  const normalized: NamedCustomThemeConfig = { ...theme };

  if (theme.base !== undefined) {
    const resolved = resolveThemeBase(theme.base);
    if ("base" in resolved) {
      normalized.base = resolved.base;
    }
  }

  for (const key of CUSTOM_THEME_COLOR_KEYS) {
    const value = normalized[key];
    if (typeof value === "string") {
      normalized[key] = normalizeThemeColorValue(value);
    }
  }

  if (isPlainObject(theme.syntax)) {
    normalized.syntax = Object.fromEntries(
      Object.entries(theme.syntax).map(([key, value]) => [
        key,
        typeof value === "string" ? normalizeThemeColorValue(value) : value,
      ]),
    );
  }

  if (isPlainObject(theme.syntaxScopes)) {
    normalized.syntaxScopes = Object.fromEntries(
      Object.entries(theme.syntaxScopes).map(([scope, value]) => [
        scope,
        typeof value === "string" ? normalizeThemeColorValue(value) : value,
      ]),
    );
  }

  return normalized;
}

/** Report one theme skipped because its id is invalid or reserved. */
export function createInvalidThemeIdNotice(
  source: string,
  id: string,
  reason: string,
): StartupNotice {
  return {
    key: `theme:invalid-id:${source}:${id}`,
    message: `Skipped theme "${id}" from ${source} • ${reason}`,
  };
}

/** Report one theme skipped because a higher-precedence source already defined its id. */
export function createThemeCollisionNotice(
  source: string,
  id: string,
  winner: string,
): StartupNotice {
  return {
    key: `theme:collision:${source}:${id}`,
    message: `Skipped theme "${id}" from ${source} • ${winner} already defines it`,
  };
}

/** Themes one session can select, plus anything worth telling the user about. */
export interface SessionCustomThemes {
  /** Config themes in declaration order, then extension themes in registry order. */
  themes: NamedCustomThemeConfig[];
  notices: StartupNotice[];
}

/**
 * Merge config-defined themes with extension-contributed ones.
 *
 * Precedence is deliberate and one-directional: config themes are the user's
 * own file and always win, extension themes fill the remaining ids in load
 * order, and every loser is reported once instead of silently disappearing.
 *
 * Config themes arrive pre-validated from the config layer, which checks every
 * color as it reads the TOML table. Extension themes are validated here against
 * those same rules — id *and* every color-bearing field — because `registerTheme`
 * accepts whatever a JavaScript factory passes it, and a wrong-typed color that
 * survives this far crashes OpenTUI's FFI the moment the theme is selected.
 */
export function collectSessionCustomThemes(
  configThemes: readonly NamedCustomThemeConfig[] = [],
  extensionThemes: readonly RegisteredCustomTheme[] = [],
): SessionCustomThemes {
  const themes = [...configThemes];
  const notices: StartupNotice[] = [];
  const claimedBy = new Map<string, string>(configThemes.map((theme) => [theme.id, "config"]));

  for (const { extensionId, theme } of extensionThemes) {
    const source = `extension ${extensionId}`;
    const idIssue = describeCustomThemeIdIssue(theme?.id);
    if (idIssue) {
      notices.push(createInvalidThemeIdNotice(source, String(theme?.id), idIssue));
      continue;
    }

    const fieldIssue = describeCustomThemeFieldIssue(theme);
    if (fieldIssue) {
      notices.push(createInvalidThemeFieldNotice(source, theme.id, fieldIssue));
      continue;
    }

    const owner = claimedBy.get(theme.id);
    if (owner) {
      notices.push(createThemeCollisionNotice(source, theme.id, owner));
      continue;
    }

    claimedBy.set(theme.id, source);
    themes.push(normalizeValidatedTheme(theme));
  }

  return { themes, notices };
}
