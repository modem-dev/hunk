import type { RegisteredTheme } from "../extensions/types";
import { BUNDLED_SHIKI_THEME_IDS } from "../ui/lib/shikiThemes";
import type { StartupNotice } from "./startupNotice";
import type { NamedCustomThemeConfig } from "./types";

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
 * Config themes arrive pre-validated from the config layer; extension themes
 * are validated here against the same rule.
 */
export function collectSessionCustomThemes(
  configThemes: readonly NamedCustomThemeConfig[] = [],
  extensionThemes: readonly RegisteredTheme[] = [],
): SessionCustomThemes {
  const themes = [...configThemes];
  const notices: StartupNotice[] = [];
  const claimedBy = new Map<string, string>(configThemes.map((theme) => [theme.id, "config"]));

  for (const { extensionId, theme } of extensionThemes) {
    const source = `extension ${extensionId}`;
    const issue = describeCustomThemeIdIssue(theme.id);
    if (issue) {
      notices.push(createInvalidThemeIdNotice(source, String(theme.id), issue));
      continue;
    }

    const owner = claimedBy.get(theme.id);
    if (owner) {
      notices.push(createThemeCollisionNotice(source, theme.id, owner));
      continue;
    }

    claimedBy.set(theme.id, source);
    themes.push(theme);
  }

  return { themes, notices };
}
