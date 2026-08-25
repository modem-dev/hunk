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
