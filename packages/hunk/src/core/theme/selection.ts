export type ThemeSelectionMode = "light" | "dark";

export interface AdaptiveThemeSelection {
  dark: string;
  light: string;
  /** Theme used when the terminal never answered the background probe. Defaults to `dark`. */
  fallback?: string;
}

export type ThemeSelection = string | AdaptiveThemeSelection;

export const AUTO_THEME_ID = "auto";

export const ADAPTIVE_THEME_SELECTION_KEYS = ["dark", "light", "fallback"] as const;

export function isAdaptiveThemeSelection(
  selection: ThemeSelection | undefined,
): selection is AdaptiveThemeSelection {
  return typeof selection === "object" && selection !== null && !Array.isArray(selection);
}

export function chooseThemeSelectionId(
  selection: ThemeSelection | undefined,
  mode: ThemeSelectionMode | null | undefined,
): string | undefined {
  if (!isAdaptiveThemeSelection(selection)) {
    return selection;
  }

  if (mode === "light") return selection.light;
  if (mode === "dark") return selection.dark;
  return selection.fallback ?? selection.dark;
}

export function themeSelectionNeedsTerminalMode(selection: ThemeSelection | undefined): boolean {
  return selection === AUTO_THEME_ID || isAdaptiveThemeSelection(selection);
}

export function themeSelectionsEqual(
  left: ThemeSelection | undefined,
  right: ThemeSelection | undefined,
): boolean {
  if (isAdaptiveThemeSelection(left) && isAdaptiveThemeSelection(right)) {
    return (
      left.dark === right.dark && left.light === right.light && left.fallback === right.fallback
    );
  }

  return left === right;
}

/** Read a `theme` config value into a selection, or explain why the table is unusable. */
export function readThemeSelection(
  value: unknown,
  keyPath = "theme",
): { selection: ThemeSelection } | { issue: string } | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value.length > 0 ? { selection: value } : undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { issue: `Expected ${keyPath} to be a theme id or a table of theme ids.` };
  }

  const table = value as Record<string, unknown>;
  const unknownKeys = Object.keys(table).filter(
    (key) => !(ADAPTIVE_THEME_SELECTION_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    return {
      issue: `Expected [${keyPath}] to contain only ${ADAPTIVE_THEME_SELECTION_KEYS.join(", ")}. Unexpected: ${unknownKeys
        .map((key) => `\`${key}\``)
        .join(", ")}.`,
    };
  }

  const readId = (key: string) => {
    const entry = table[key];
    return typeof entry === "string" && entry.length > 0 ? entry : undefined;
  };
  const dark = readId("dark");
  const light = readId("light");
  if (dark === undefined || light === undefined) {
    return {
      issue: `Expected [${keyPath}] to set both \`dark\` and \`light\` to theme ids.`,
    };
  }

  if ("fallback" in table && readId("fallback") === undefined) {
    return { issue: `Expected ${keyPath}.fallback to be a theme id.` };
  }

  const fallback = readId("fallback");
  return { selection: fallback === undefined ? { dark, light } : { dark, light, fallback } };
}
