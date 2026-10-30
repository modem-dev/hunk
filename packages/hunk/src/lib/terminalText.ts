export interface SanitizeTerminalTextOptions {
  /** Preserve line feeds for multiline text fields. Defaults to true. */
  preserveNewlines?: boolean;
  /** Preserve horizontal tabs for text fields that intentionally support them. Defaults to true. */
  preserveTabs?: boolean;
  /** Preserve ANSI SGR style sequences such as Git color output. Defaults to false. */
  preserveAnsiStyle?: boolean;
}

const controlCodeRegex = /[\x00-\x1f\x7f-\x9f]/;
// Keep these global regexes private and use them only with String#replace below.
// Calling test/exec on shared /g regexes would make lastIndex stateful between calls.
const sevenBitControlStrings =
  /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\|\x9c)|[PX^_][\s\S]*?(?:\x1b\\|\x9c)|\[[0-?]*[ -/]*[@-~])/g;
const c1ControlStrings = /[\x90\x98\x9d\x9e\x9f][\s\S]*?(?:\x07|\x1b\\|\x9c)/g;
const c1Csi = /\x9b[0-?]*[ -/]*[@-~]/g;
const preservedStyleTokenDelimiters = /[\u{f0000}\u{f0001}]/gu;
const preservedStyleTokens = /\u{f0000}(\d+)\u{f0001}/gu;

/** Normalize untrusted terminal-bound text before rendering it in Hunk UI surfaces. */
export function sanitizeTerminalText(
  text: string,
  {
    preserveNewlines = true,
    preserveTabs = true,
    preserveAnsiStyle = false,
  }: SanitizeTerminalTextOptions = {},
) {
  if (!controlCodeRegex.test(text)) {
    return text;
  }

  const controlCharacters = preserveNewlines
    ? preserveTabs
      ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
      : /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g
    : preserveTabs
      ? /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g
      : /[\x00-\x1f\x7f-\x9f]/g;
  const preservedStyles: string[] = [];
  const preserveStyle = (sequence: string) => {
    if (!preserveAnsiStyle || !/^\x1b\[[0-9;:]*m$/.test(sequence)) {
      return "";
    }

    const token = `\u{f0000}${preservedStyles.length}\u{f0001}`;
    preservedStyles.push(sequence);
    return token;
  };

  // Strip placeholder delimiters from untrusted input so authored text cannot spoof
  // an internal token that later restores an ANSI sequence at the wrong location.
  const tokenSafeText = preserveAnsiStyle ? text.replace(preservedStyleTokenDelimiters, "") : text;

  const sanitized = tokenSafeText
    .replace(sevenBitControlStrings, preserveStyle)
    .replace(c1ControlStrings, "")
    .replace(c1Csi, "")
    .replace(controlCharacters, "");

  if (preservedStyles.length === 0) {
    return sanitized;
  }

  // Restore every placeholder in a single pass. Replacing one style at a time rescans and
  // reallocates the whole document per preserved sequence, which is quadratic in ANSI-dense
  // input: a few megabytes of `git log --graph --color=always` piped through `hunk pager`
  // carries ~170k sequences and would peg a core for minutes while churning gigabytes.
  // Input delimiters were stripped above, so every surviving token indexes a captured style.
  return sanitized.replace(
    preservedStyleTokens,
    (_token, index: string) => preservedStyles[Number(index)] ?? "",
  );
}

/** Sanitize a single terminal row or cell where newlines must never be preserved. */
export function sanitizeTerminalLine(text: string) {
  return sanitizeTerminalText(text, { preserveNewlines: false, preserveTabs: true });
}

/** Render an exact filesystem path safely without letting controls alter terminal geometry. */
export function formatTerminalPath(path: string) {
  let formatted = "";
  for (const character of path) {
    const codePoint = character.codePointAt(0)!;
    if (character === "\\") {
      formatted += "\\\\";
    } else if (character === "\t") {
      formatted += "\\t";
    } else if (character === "\n") {
      formatted += "\\n";
    } else if (character === "\r") {
      formatted += "\\r";
    } else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      formatted += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else {
      formatted += character;
    }
  }
  return formatted;
}

/** Sanitize render spans while preserving their non-text styling metadata. */
export function sanitizeTerminalSpans<T extends { text: string }>(spans: T[]): T[] {
  let sanitized: T[] | null = null;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    const text = sanitizeTerminalLine(span.text);
    if (text === span.text && text.length > 0) {
      sanitized?.push(span);
      continue;
    }

    // Delay the output copy until the first actual change so already-safe immutable span arrays can
    // flow through hot rendering paths without allocating either an array or replacement objects.
    sanitized ??= spans.slice(0, index);
    if (text.length > 0) {
      sanitized.push({ ...span, text } as T);
    }
  }
  return sanitized ?? spans;
}
