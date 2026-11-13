/**
 * Renders an STML note body to DOM for the browser page.
 *
 * Markup is parsed by the shared parser (`core/stml/parse.ts`) and every tag is interpreted by
 * its shared role (`core/review/stml.ts`, audit A9), so a tag means the same thing here as in
 * the terminal and an unknown tag is unknown in both. Colors resolve through the shared
 * vocabulary (`stmlColorTarget`): a theme word becomes the page's matching `--hunk-*` custom
 * property, so a note follows the active theme like the terminal's does.
 *
 * Layout is the browser's own. The terminal lays STML out deterministically in cells because
 * its windowed stream must know a note's height before mounting it; the page lets CSS lay
 * boxes, rows, and lists out and measures the result. Everything is built with
 * `textContent` and element constructors — never HTML strings — and links render as text with
 * their target in a tooltip, so a note can neither run script nor navigate the page.
 */
import { parseStml, type StmlElement, type StmlNode } from "../../core/stml/parse";
import { stmlColorTarget, stmlTagRole, type StmlTagRole } from "../../core/review/stml";

/** The CSS color one STML color value names on this page, or nothing for an unknown value. */
export function stmlCssColor(token: string | undefined) {
  const target = stmlColorTarget(token);
  if (!target) return undefined;
  if (target.kind === "literal") return target.color;
  return `var(--hunk-${target.key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)})`;
}

/** Elements each role renders as. */
const ROLE_ELEMENTS: Record<StmlTagRole, string> = {
  strong: "strong",
  emphasis: "em",
  underline: "u",
  strike: "s",
  muted: "span",
  key: "kbd",
  badge: "span",
  link: "span",
  styled: "span",
  "line-break": "br",
  container: "div",
  card: "div",
  row: "div",
  paragraph: "p",
  heading: "h4",
  title: "h3",
  divider: "hr",
  spacer: "div",
  list: "ul",
  "ordered-list": "ol",
  "list-item": "li",
  code: "pre",
};

/** A positive cell count from an attribute, clamped to something a note can afford. */
function cells(value: string | undefined, max = 8) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), max) : undefined;
}

/** Apply the attributes a box-like role takes: border, colors, title, padding, width. */
function applyBoxAttributes(element: HTMLElement, attrs: Record<string, string>, card: boolean) {
  const borderColor = stmlCssColor(attrs["border-color"]);
  if (card || "border" in attrs || attrs["border-style"] || borderColor) {
    element.dataset.border = attrs["border-style"] ?? "single";
    if (borderColor) element.style.borderColor = borderColor;
  }
  const background = stmlCssColor(attrs.bg);
  if (background) element.style.background = background;
  const padding = cells(attrs.padding);
  const paddingX = cells(attrs["padding-x"]) ?? padding;
  const paddingY = cells(attrs["padding-y"]) ?? padding;
  if (paddingX !== undefined) element.style.paddingInline = `${paddingX}ch`;
  if (paddingY !== undefined) element.style.paddingBlock = `${paddingY * 1.4}em`;
  const width = attrs.width?.trim();
  if (width && /^\d{1,3}%$/.test(width)) element.style.width = width;
  else if (width && /^\d{1,3}$/.test(width)) element.style.width = `${width}ch`;
  if (attrs.title) {
    const title = document.createElement("div");
    title.className = "stml-box-title";
    title.textContent = attrs.title;
    const titleColor = stmlCssColor(attrs["title-color"]);
    if (titleColor) title.style.color = titleColor;
    element.append(title);
  }
}

/** Apply the inline style attributes any styled run may carry. */
function applyInlineAttributes(element: HTMLElement, attrs: Record<string, string>) {
  const color = stmlCssColor(attrs.fg ?? attrs.color);
  if (color) element.style.color = color;
  const background = stmlCssColor(attrs.bg);
  if (background) element.style.background = background;
  if ("bold" in attrs) element.style.fontWeight = "600";
  if ("italic" in attrs) element.style.fontStyle = "italic";
  if ("underline" in attrs) element.style.textDecoration = "underline";
  if ("strike" in attrs) element.style.textDecoration = "line-through";
  if ("dim" in attrs) element.style.opacity = "0.7";
}

/** Build the DOM for one parsed element by its role. */
function renderElement(node: StmlElement): Node {
  const role = stmlTagRole(node.tag);
  if (!role) {
    // Unknown tags keep their content and lose their meaning, as in the terminal.
    const fragment = document.createDocumentFragment();
    for (const child of node.children) fragment.append(renderNode(child));
    return fragment;
  }
  const element = document.createElement(ROLE_ELEMENTS[role]);
  element.className = `stml-${role}`;
  switch (role) {
    case "container":
    case "card":
      applyBoxAttributes(element, node.attrs, role === "card");
      break;
    case "row": {
      const gap = cells(node.attrs.gap);
      if (gap !== undefined) element.style.gap = `${gap}ch`;
      break;
    }
    case "spacer":
      element.style.height = `${(cells(node.attrs.size, 4) ?? 1) * 1.4}em`;
      break;
    case "badge": {
      const color = stmlCssColor(node.attrs.color ?? node.attrs.bg) ?? "var(--hunk-accent)";
      element.style.background = color;
      break;
    }
    case "link":
      if (node.attrs.href) element.title = node.attrs.href;
      break;
    case "list":
      if (node.attrs.marker) element.dataset.marker = node.attrs.marker;
      break;
    case "code":
      if (node.attrs.title) element.dataset.title = node.attrs.title;
      break;
    default:
      break;
  }
  // A badge's `color` is its fill, set above; every other run's is its text color.
  if (role === "badge") {
    applyInlineAttributes(element, { ...node.attrs, color: "", bg: "" });
  } else if (role !== "container" && role !== "card") {
    applyInlineAttributes(element, node.attrs);
  }
  if (role === "code") {
    element.textContent = node.children
      .map((child) => (child.type === "text" ? child.value : ""))
      .join("");
    return element;
  }
  for (const child of node.children) element.append(renderNode(child));
  return element;
}

/** Build the DOM for one parsed node. */
function renderNode(node: StmlNode): Node {
  return node.type === "text" ? document.createTextNode(node.value) : renderElement(node);
}

/**
 * Render one note's markup, or return nothing when it parses to nothing visible, so the
 * caller falls back to the plain summary and rationale as the terminal does.
 */
export function renderStmlNoteBody(markup: string): HTMLElement | undefined {
  const { nodes } = parseStml(markup);
  const visible = nodes.some((node) => node.type === "element" || node.value.trim().length > 0);
  if (!visible) return undefined;
  const body = document.createElement("div");
  body.className = "stml";
  for (const node of nodes) body.append(renderNode(node));
  return body;
}
