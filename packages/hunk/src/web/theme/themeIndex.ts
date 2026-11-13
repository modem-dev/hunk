/**
 * The built-in themes as the page receives them, and how they become page styles.
 *
 * `scripts/build/build-web.ts` resolves every built-in theme with the terminal's own
 * derivation (`ui/themes.ts`) and writes the finished tokens to one hashed JSON asset that
 * the document names in a `<meta>` tag, so the browser shows each theme exactly as the
 * terminal does without carrying a second derivation. This module reads that index, turns a
 * theme's tokens into CSS custom properties for the page chrome, Pierre's diff renderer, and
 * the file tree, and remembers the reader's choice per browser.
 *
 * The choice never reaches the session: a theme picked here does not change the terminal.
 */

/** `<meta name>` the document carries the theme index's URL in. */
export const WEB_THEME_INDEX_META_NAME = "hunk-theme-index";

/** Theme picked when nothing is stored, by the browser's color-scheme preference. */
export const DEFAULT_WEB_THEME_IDS = {
  dark: "github-dark-default",
  light: "github-light-default",
} as const;

/** One built-in theme, resolved. */
export interface WebThemeV1 {
  id: string;
  label: string;
  appearance: "light" | "dark";
  /** The Shiki theme Pierre highlights with. */
  syntaxTheme: string;
  /** Every color token of the terminal's `AppTheme`, by token name. */
  tokens: Record<string, string>;
}

export interface WebThemeIndexV1 {
  formatVersion: 1;
  themes: WebThemeV1[];
}

const STORAGE_KEY = "hunk.review.theme";

/** Parse a fetched index, refusing anything that is not one. */
export function parseWebThemeIndex(value: unknown): WebThemeIndexV1 | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { formatVersion?: unknown; themes?: unknown };
  if (record.formatVersion !== 1 || !Array.isArray(record.themes)) return undefined;
  const valid = record.themes.every(
    (theme: Partial<WebThemeV1>) =>
      typeof theme?.id === "string" &&
      typeof theme.label === "string" &&
      (theme.appearance === "light" || theme.appearance === "dark") &&
      typeof theme.syntaxTheme === "string" &&
      typeof theme.tokens === "object" &&
      theme.tokens !== null,
  );
  return valid ? (record as WebThemeIndexV1) : undefined;
}

/** Fetch the index the document names. */
export async function loadWebThemeIndex(
  doc: Document = document,
): Promise<WebThemeIndexV1 | undefined> {
  const href = doc
    .querySelector(`meta[name="${WEB_THEME_INDEX_META_NAME}"]`)
    ?.getAttribute("content");
  if (!href) return undefined;
  try {
    const response = await fetch(href, { credentials: "omit" });
    return response.ok ? parseWebThemeIndex(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}

/** The reader's stored theme id, if storage is available and holds one. */
export function readStoredThemeId(): string | undefined {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Remember the reader's theme for this browser; silently skipped when storage is blocked. */
export function storeThemeId(themeId: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, themeId);
  } catch {
    // A private window or blocked storage only loses the preference.
  }
}

/** Pick the theme to show: the stored one if it still exists, else the color-scheme default. */
export function resolveWebTheme(
  index: WebThemeIndexV1,
  storedId: string | undefined,
  prefersDark: boolean,
): WebThemeV1 | undefined {
  const fallback = prefersDark ? DEFAULT_WEB_THEME_IDS.dark : DEFAULT_WEB_THEME_IDS.light;
  return (
    index.themes.find((theme) => theme.id === storedId) ??
    index.themes.find((theme) => theme.id === fallback) ??
    index.themes[0]
  );
}

/** `addedBg` → `--hunk-added-bg`. */
export function themeTokenProperty(token: string) {
  return `--hunk-${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/**
 * The CSS custom properties one theme sets on the page.
 *
 * Every token becomes a `--hunk-*` property for the page's own chrome. Pierre's and the file
 * tree's documented override properties are set from the same tokens, so the diff body and
 * the sidebar use the terminal's added/removed rows, emphasis, line numbers, and file-state
 * colors rather than their own palettes. Custom properties inherit into their shadow roots.
 */
export function themeCustomProperties(theme: WebThemeV1): Record<string, string> {
  const token = (name: string) => theme.tokens[name] ?? "";
  const properties: Record<string, string> = {};
  for (const [name, value] of Object.entries(theme.tokens)) {
    properties[themeTokenProperty(name)] = value;
  }
  Object.assign(properties, {
    "--diffs-bg-addition-override": token("addedBg"),
    "--diffs-bg-deletion-override": token("removedBg"),
    "--diffs-bg-addition-emphasis-override": token("addedContentBg"),
    "--diffs-bg-deletion-emphasis-override": token("removedContentBg"),
    "--diffs-addition-color-override": token("addedSignColor"),
    "--diffs-deletion-color-override": token("removedSignColor"),
    "--diffs-fg-number-override": token("lineNumberFg"),
    "--diffs-bg-separator-override": token("panelAlt"),
    "--trees-bg-override": token("panel"),
    "--trees-fg-override": token("text"),
    "--trees-fg-muted-override": token("muted"),
    "--trees-selected-bg-override": token("panelAlt"),
    "--trees-selected-fg-override": token("text"),
    "--trees-accent-override": token("accent"),
    "--trees-focus-ring-color-override": token("accent"),
    "--trees-git-added-color-override": token("fileNew"),
    "--trees-git-deleted-color-override": token("fileDeleted"),
    "--trees-git-modified-color-override": token("fileModified"),
    "--trees-git-renamed-color-override": token("fileRenamed"),
    "--trees-git-untracked-color-override": token("fileUntracked"),
  });
  return properties;
}

/** Apply one theme's properties to an element (the page root). */
export function applyWebTheme(element: HTMLElement, theme: WebThemeV1) {
  for (const [property, value] of Object.entries(themeCustomProperties(theme))) {
    if (value) element.style.setProperty(property, value);
  }
  element.style.colorScheme = theme.appearance;
  element.dataset.themeAppearance = theme.appearance;
}
