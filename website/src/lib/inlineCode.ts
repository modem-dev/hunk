/**
 * Render authored prose that carries Markdown-style `inline code` spans.
 *
 * Comparison copy is stored once and rendered three ways — as HTML, as the `.md`
 * variant agents read, and as structured-data strings — so it is authored in the
 * lowest common denominator: plain text with backticks. These are the two
 * conversions the other renderings need.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/**
 * Escape one string for HTML, then promote `backtick spans` to `<code>`.
 *
 * Escaping runs first so authored text can never introduce an element; the
 * `<code>` tags are added afterward against already-safe content.
 */
export function withInlineCode(text: string): string {
  const escaped = text.replace(/[&<>"]/g, (character) => ESCAPES[character] ?? character);
  return escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** Drop the backticks, for contexts that take plain text (JSON-LD, meta tags). */
export function withoutInlineCode(text: string): string {
  return text.replaceAll("`", "");
}
