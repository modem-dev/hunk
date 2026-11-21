/**
 * The STML tag vocabulary, as roles rather than tag names.
 *
 * STML notes are authored once and rendered by every review surface. A renderer that
 * switches on tag names grows its own subset — the prototype's browser handled a dozen
 * tags and flattened the rest, while inventing an alias the terminal never had
 * (`docs/browser-review-seam-audit.md`, A9). Switching on roles instead means a new tag
 * is registered once and every renderer sees it, or is unknown everywhere.
 *
 * A role says what a tag *means*, not how it looks: the terminal draws a `heading` bold,
 * a browser might draw it large. Aliases collapse here, so `<box>` and `<section>` cannot
 * drift apart in one renderer.
 */

export type StmlInlineRole =
  | "strong"
  | "emphasis"
  | "underline"
  | "strike"
  | "muted"
  | "key"
  | "badge"
  | "link"
  // Text whose appearance comes from its own attributes (`<c fg="success">`)
  // rather than from a fixed meaning like `strong`.
  | "styled"
  | "line-break";

export type StmlBlockRole =
  | "container"
  | "card"
  | "row"
  | "paragraph"
  | "heading"
  | "title"
  | "divider"
  | "spacer"
  | "list"
  | "ordered-list"
  | "list-item"
  | "code";

export type StmlTagRole = StmlInlineRole | StmlBlockRole;

const TAG_ROLES: Readonly<Record<string, StmlTagRole>> = {
  b: "strong",
  strong: "strong",
  i: "emphasis",
  em: "emphasis",
  u: "underline",
  s: "strike",
  strike: "strike",
  del: "strike",
  dim: "muted",
  muted: "muted",
  kbd: "key",
  badge: "badge",
  a: "link",
  link: "link",
  c: "styled",
  color: "styled",
  span: "styled",
  br: "line-break",
  box: "container",
  col: "container",
  column: "container",
  stack: "container",
  section: "container",
  card: "card",
  row: "row",
  text: "paragraph",
  p: "paragraph",
  h: "heading",
  h2: "heading",
  h3: "heading",
  heading: "heading",
  h1: "title",
  title: "title",
  hr: "divider",
  rule: "divider",
  divider: "divider",
  spacer: "spacer",
  space: "spacer",
  list: "list",
  ul: "list",
  ol: "ordered-list",
  item: "list-item",
  li: "list-item",
  code: "code",
  pre: "code",
};

const INLINE_ROLES: ReadonlySet<StmlTagRole> = new Set<StmlInlineRole>([
  "strong",
  "emphasis",
  "underline",
  "strike",
  "muted",
  "key",
  "badge",
  "link",
  "styled",
  "line-break",
]);

// Roles with no children: written unclosed (`<br>`) or self-closed (`<hr/>`).
const VOID_ROLES: ReadonlySet<StmlTagRole> = new Set<StmlTagRole>([
  "line-break",
  "divider",
  "spacer",
]);

// Roles whose inner text is taken verbatim — no nested tags, whitespace preserved.
const RAW_TEXT_ROLES: ReadonlySet<StmlTagRole> = new Set<StmlTagRole>(["code"]);

/** Resolve one lowercase tag name to its role, or undefined when the tag is unknown. */
export function stmlTagRole(tag: string): StmlTagRole | undefined {
  return TAG_ROLES[tag];
}

/** Return whether one role participates in inline flow rather than block layout. */
export function isInlineStmlRole(role: StmlTagRole | undefined): role is StmlInlineRole {
  return role !== undefined && INLINE_ROLES.has(role);
}

/** Return whether one tag never has children, so a closing tag for it is noise. */
export function isVoidStmlTag(tag: string) {
  const role = stmlTagRole(tag);
  return role !== undefined && VOID_ROLES.has(role);
}

/** Return whether one tag's content is verbatim text rather than nested markup. */
export function isRawTextStmlTag(tag: string) {
  const role = stmlTagRole(tag);
  return role !== undefined && RAW_TEXT_ROLES.has(role);
}

// -- Colors -----------------------------------------------------------------------------

/** Fixed fallback palette for ANSI-style color names in agent markup. */
const STML_NAMED_COLORS: ReadonlyMap<string, string> = new Map([
  ["black", "#1c1c1c"],
  ["red", "#e05252"],
  ["green", "#4fb469"],
  ["yellow", "#d9a331"],
  ["blue", "#4f8fd9"],
  ["magenta", "#b969d9"],
  ["cyan", "#3fb5b5"],
  ["white", "#e8e8e8"],
  ["gray", "#8a8a8a"],
  ["grey", "#8a8a8a"],
  ["orange", "#e0873d"],
  ["purple", "#9a6fd0"],
  ["pink", "#d9699a"],
]);

/** The semantic theme tokens STML colors may name, by Hunk's theme token name. */
export type StmlThemeColorKey =
  | "accent"
  | "accentMuted"
  | "addedSignColor"
  | "removedSignColor"
  | "fileModified"
  | "muted"
  | "panelAlt"
  | "text"
  | "panel"
  | "noteBorder"
  | "background";

/** Theme token selected by each semantic STML color word. */
const STML_THEME_COLOR_KEY_BY_TOKEN: ReadonlyMap<string, StmlThemeColorKey> = new Map([
  ["accent", "accent"],
  ["info", "accentMuted"],
  ["success", "addedSignColor"],
  ["danger", "removedSignColor"],
  ["error", "removedSignColor"],
  ["warning", "fileModified"],
  ["muted", "muted"],
  ["subtle", "panelAlt"],
  ["heading", "text"],
  ["text", "text"],
  ["panel", "panel"],
  ["bg", "panel"],
  ["note-border", "noteBorder"],
  // Badge glyphs sit on a bright background and need the highest-contrast text color in both
  // theme modes, which is the app background.
  ["badge-text", "background"],
]);

const STML_HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** What one STML color value names: a theme token, or a literal color. */
export type StmlColorTarget =
  | { kind: "theme"; key: StmlThemeColorKey }
  | { kind: "literal"; color: string };

/**
 * Resolve one STML color value to what it names, independent of any theme.
 *
 * Semantic words follow the sideshow-term vocabulary (`accent`, `success`, `warning`,
 * `danger`, `info`, `muted`, `subtle`, `heading`) plus internal words a layout emits
 * (`note-border`, `badge-text`); a hex value and the fixed named palette are literal. Unknown
 * values resolve to nothing, so a renderer falls back to its default text color. Each renderer
 * turns a theme key into its own concrete color at render time.
 */
export function stmlColorTarget(token: string | undefined): StmlColorTarget | undefined {
  if (!token) return undefined;
  const value = token.trim().toLowerCase();
  const key = STML_THEME_COLOR_KEY_BY_TOKEN.get(value);
  if (key !== undefined) return { kind: "theme", key };
  if (STML_HEX_COLOR.test(value)) return { kind: "literal", color: value };
  const named = STML_NAMED_COLORS.get(value);
  return named ? { kind: "literal", color: named } : undefined;
}
