// STML — a small, tolerant, HTML-like markup for terminal-rendered agent
// notes, ported from the sideshow-term experiment. The parser is pure
// data-in/data-out so it stays unit-testable and renderer-agnostic; parsing
// never throws — malformed input degrades to a best-effort tree plus a list of
// human-readable `errors`, so a sloppy note still renders something useful.

import { sanitizeTerminalText } from "../../../lib/terminalText";

export interface StmlText {
  type: "text";
  value: string;
}

export interface StmlElement {
  type: "element";
  tag: string;
  attrs: Record<string, string>;
  children: StmlNode[];
}

export type StmlNode = StmlText | StmlElement;

export interface StmlParseResult {
  nodes: StmlNode[];
  errors: string[];
}

export interface StmlParseOptions {
  maxInputBytes?: number;
  maxNodes?: number;
  maxDepth?: number;
  maxErrors?: number;
}

export const DEFAULT_STML_PARSE_LIMITS = {
  maxInputBytes: 64 * 1024,
  maxNodes: 2000,
  maxDepth: 32,
  maxErrors: 20,
} as const satisfies Required<StmlParseOptions>;

// Tags that never have children — they may be written unclosed (`<br>`) or
// self-closed (`<hr/>`); either way any "</tag>" is tolerated and ignored.
const VOID_TAGS = new Set(["br", "hr", "rule", "divider", "spacer", "space"]);

// Tags whose inner text is taken verbatim — no nested tags, whitespace and
// case preserved. This is what makes <code> ergonomic.
const RAW_TAGS = new Set(["code", "pre"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  bull: "•",
  middot: "·",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  check: "✓",
  cross: "✗",
  times: "×",
};

function isValidCodePoint(code: number): boolean {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff;
}

/** Decode a small, predictable entity set; unknown entities stay literal. */
export function decodeStmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (whole, body: string) => {
    if (body[0] !== "#") {
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    }

    const code =
      body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
    return isValidCodePoint(code) ? String.fromCodePoint(code) : whole;
  });
}

/** Neutralize control sequences in agent markup before it reaches the TUI. */
function sanitizeStmlText(text: string): string {
  return sanitizeTerminalText(text, { preserveNewlines: true, preserveTabs: false });
}

const isSpace = (ch: string) =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
const isNameChar = (ch: string) => /[a-zA-Z0-9\-_]/.test(ch);
// A tag name must start with a letter — so "3<4" and "a < b" stay as text.
const isTagStart = (ch: string | undefined) => ch !== undefined && /[a-zA-Z]/.test(ch);

/** Parse STML markup into a tolerant node tree; never throws. */
export function parseStml(input: string, options: StmlParseOptions = {}): StmlParseResult {
  const limits: Required<StmlParseOptions> = { ...DEFAULT_STML_PARSE_LIMITS, ...options };
  const errors: string[] = [];
  const addError = limitedErrorCollector(errors, limits.maxErrors);
  const root: StmlNode[] = [];
  const stack: StmlElement[] = [];
  const top = () => (stack.length > 0 ? stack[stack.length - 1]!.children : root);

  let source = input;
  const bytes = utf8ByteLength(source);
  if (bytes > limits.maxInputBytes) {
    source = truncateUtf8(source, limits.maxInputBytes);
    addError(`input truncated at ${limits.maxInputBytes} byte(s)`);
  }

  let i = 0;
  const n = source.length;
  let nodeCount = 0;
  let nodeLimitReached = false;

  const canAddNode = () => {
    if (nodeCount < limits.maxNodes) {
      nodeCount += 1;
      return true;
    }
    if (!nodeLimitReached) {
      nodeLimitReached = true;
      addError(`node limit reached at ${limits.maxNodes} node(s); remaining markup ignored`);
    }
    return false;
  };

  const pushText = (value: string) => {
    if (value.length === 0 || nodeLimitReached) {
      return;
    }
    const safe = sanitizeStmlText(value);
    if (safe.length === 0) {
      return;
    }
    const siblings = top();
    const last = siblings[siblings.length - 1];
    // Merge adjacent text so a bare "<" doesn't fragment a run into pieces.
    if (last && last.type === "text") {
      last.value += safe;
    } else if (canAddNode()) {
      siblings.push({ type: "text", value: safe });
    }
  };

  while (i < n && !nodeLimitReached) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      pushText(source.slice(i));
      break;
    }
    if (lt > i) {
      pushText(source.slice(i, lt));
    }
    if (nodeLimitReached) {
      break;
    }
    i = lt;

    // Comment
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }

    // Closing tag
    if (source[i + 1] === "/") {
      let j = i + 2;
      let name = "";
      while (j < n && isNameChar(source[j]!)) {
        name += source[j++];
      }
      while (j < n && source[j] !== ">") {
        j++;
      }
      i = j + 1;
      name = name.toLowerCase();
      // Pop to the nearest matching open element; tolerate stray/mismatched
      // closers rather than discarding the whole tree.
      const idx = findOpen(stack, name);
      if (idx === -1) {
        addError(`stray closing tag </${name}>`);
      } else {
        if (idx !== stack.length - 1) {
          addError(`closing </${name}> implicitly closed ${stack.length - 1 - idx} tag(s)`);
        }
        stack.length = idx;
      }
      continue;
    }

    // Not a real tag (a bare "<", or "<" before a digit) — emit as text.
    if (!isTagStart(source[i + 1])) {
      pushText("<");
      i += 1;
      continue;
    }

    // Opening tag
    const open = readOpenTag(source, i);
    if (!open) {
      pushText("<");
      i += 1;
      continue;
    }
    i = open.next;

    if (stack.length >= limits.maxDepth) {
      addError(`depth limit reached at <${open.tag}> (${limits.maxDepth} level(s))`);
      continue;
    }
    if (!canAddNode()) {
      break;
    }

    const el: StmlElement = { type: "element", tag: open.tag, attrs: open.attrs, children: [] };
    top().push(el);

    if (open.selfClosing || VOID_TAGS.has(open.tag)) {
      continue;
    }

    if (RAW_TAGS.has(open.tag)) {
      const close = `</${open.tag}`;
      const end = indexOfCloser(source, i, close);
      const raw = source.slice(i, end === -1 ? n : end);
      if (raw.length > 0 && canAddNode()) {
        el.children.push({ type: "text", value: sanitizeStmlText(raw) });
      }
      if (end === -1) {
        addError(`unclosed <${open.tag}>`);
        i = n;
      } else {
        const gt = source.indexOf(">", end);
        i = gt === -1 ? n : gt + 1;
      }
      continue;
    }

    stack.push(el);
  }

  if (stack.length > 0) {
    addError(`unclosed tag(s): ${stack.map((e) => `<${e.tag}>`).join(", ")}`);
  }
  return { nodes: root, errors };
}

function limitedErrorCollector(errors: string[], maxErrors: number): (message: string) => void {
  let omitted = false;
  return (message: string) => {
    if (errors.length < maxErrors) {
      errors.push(message);
      return;
    }
    if (!omitted) {
      omitted = true;
      if (errors.length === 0) {
        return;
      }
      errors[errors.length - 1] = `${errors[errors.length - 1]} (further parse errors omitted)`;
    }
  };
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    bytes += utf8CharBytes(ch);
  }
  return bytes;
}

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const next = bytes + utf8CharBytes(ch);
    if (next > maxBytes) {
      break;
    }
    bytes = next;
    out += ch;
  }
  return out;
}

function utf8CharBytes(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code <= 0x7f) {
    return 1;
  }
  if (code <= 0x7ff) {
    return 2;
  }
  if (code <= 0xffff) {
    return 3;
  }
  return 4;
}

function findOpen(stack: StmlElement[], name: string): number {
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k]!.tag === name) {
      return k;
    }
  }
  return -1;
}

// Case-insensitive search for a closing tag whose name matches, e.g. "</code".
function indexOfCloser(input: string, from: number, closer: string): number {
  return input.toLowerCase().indexOf(closer.toLowerCase(), from);
}

interface OpenTag {
  tag: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  next: number;
}

function readOpenTag(input: string, start: number): OpenTag | null {
  const n = input.length;
  let i = start + 1;
  let tag = "";
  while (i < n && isNameChar(input[i]!)) {
    tag += input[i++];
  }
  if (!tag) {
    return null;
  }
  tag = tag.toLowerCase();
  const attrs: Record<string, string> = {};

  while (i < n) {
    while (i < n && isSpace(input[i]!)) {
      i++;
    }
    if (i >= n) {
      break;
    }
    if (input[i] === ">") {
      return { tag, attrs, selfClosing: false, next: i + 1 };
    }
    if (input[i] === "/" && input[i + 1] === ">") {
      return { tag, attrs, selfClosing: true, next: i + 2 };
    }
    // attribute name
    let name = "";
    while (i < n && isNameChar(input[i]!)) {
      name += input[i++];
    }
    if (!name) {
      // unexpected char inside tag — skip it to stay tolerant
      i++;
      continue;
    }
    name = name.toLowerCase();
    while (i < n && isSpace(input[i]!)) {
      i++;
    }
    if (input[i] === "=") {
      i++;
      while (i < n && isSpace(input[i]!)) {
        i++;
      }
      const quote = input[i];
      if (quote === '"' || quote === "'") {
        i++;
        let value = "";
        while (i < n && input[i] !== quote) {
          value += input[i++];
        }
        i++; // closing quote
        attrs[name] = sanitizeStmlText(decodeStmlEntities(value));
      } else {
        let value = "";
        while (
          i < n &&
          !isSpace(input[i]!) &&
          input[i] !== ">" &&
          !(input[i] === "/" && input[i + 1] === ">")
        ) {
          value += input[i++];
        }
        attrs[name] = sanitizeStmlText(decodeStmlEntities(value));
      }
    } else {
      // bare boolean attribute
      attrs[name] = "";
    }
  }
  return { tag, attrs, selfClosing: false, next: n };
}
