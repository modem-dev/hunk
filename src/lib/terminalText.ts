export interface SanitizeTerminalTextOptions {
  /** Preserve line feeds for multiline text fields. Defaults to true. */
  preserveNewlines?: boolean;
  /** Preserve horizontal tabs for text fields that intentionally support them. Defaults to true. */
  preserveTabs?: boolean;
}

const controlCodeRegex = /[\x00-\x1f\x7f-\x9f]/;
// Keep these global regexes private and use them only with String#replace below.
// Calling test/exec on shared /g regexes would make lastIndex stateful between calls.
const sevenBitControlStrings =
  /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\|\x9c)|[PX^_][\s\S]*?(?:\x1b\\|\x9c)|\[[0-?]*[ -/]*[@-~])/g;
const c1ControlStrings = /[\x90\x98\x9d\x9e\x9f][\s\S]*?(?:\x07|\x1b\\|\x9c)/g;
const c1Csi = /\x9b[0-?]*[ -/]*[@-~]/g;

/** Normalize untrusted terminal-bound text before rendering it in Hunk UI surfaces. */
export function sanitizeTerminalText(
  text: string,
  { preserveNewlines = true, preserveTabs = true }: SanitizeTerminalTextOptions = {},
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

  return text
    .replace(sevenBitControlStrings, "")
    .replace(c1ControlStrings, "")
    .replace(c1Csi, "")
    .replace(controlCharacters, "");
}

/** Sanitize a single terminal row or cell where newlines must never be preserved. */
export function sanitizeTerminalLine(text: string) {
  return sanitizeTerminalText(text, { preserveNewlines: false, preserveTabs: true });
}

/** Sanitize render spans while preserving their non-text styling metadata. */
export function sanitizeTerminalSpans<T extends { text: string }>(spans: readonly T[]): T[] {
  const sanitized: T[] = [];
  for (const span of spans) {
    const text = sanitizeTerminalLine(span.text);
    if (text.length > 0) {
      sanitized.push({ ...span, text } as T);
    }
  }
  return sanitized;
}
