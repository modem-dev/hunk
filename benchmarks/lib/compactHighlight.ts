/**
 * Compact wire format for shipping highlighted lines out of a worker.
 *
 * Pierre's HAST is a deep tree, but Hunk's span flattener reads only three things per token: the
 * text, one foreground color, and whether the token is word-diff emphasis. This encodes exactly
 * that, interning colors into a per-file palette so a file's handful of distinct colors travels
 * once instead of once per token.
 *
 * The worker and its driver both import this, so the encode the benchmark verifies is the encode
 * the worker actually runs.
 */
import { cleanLastNewline } from "@pierre/diffs";

export type HastNode =
  | { type: "text"; value: string }
  | {
      type: "element";
      tagName: string;
      properties?: Record<string, unknown>;
      children?: HastNode[];
    };

/** One token: text, palette index (-1 inherits the enclosing color), 1 when word-diff emphasis. */
export type CompactToken = [string, number, 0 | 1];

/** One line's tokens, or undefined where the diff has no line on that side. */
export type CompactLine = CompactToken[] | undefined;

export interface CompactCode {
  deletionLines: CompactLine[];
  additionLines: CompactLine[];
  palette: string[];
}

/** Pull the foreground color out of a Shiki style string. */
export function colorFromStyle(style: unknown) {
  if (typeof style !== "string") {
    return undefined;
  }

  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const name = declaration.slice(0, separator).trim();
    if (name === "color" || name === "--diffs-token-dark" || name === "--diffs-token-light") {
      return declaration.slice(separator + 1).trim();
    }
  }

  return undefined;
}

/** Encode one highlighted line, interning its colors into the shared palette. */
export function encodeLine(node: HastNode | undefined, palette: Map<string, number>): CompactLine {
  if (!node) {
    return undefined;
  }

  const tokens: CompactToken[] = [];

  const visit = (current: HastNode | undefined, color: number, emphasis: 0 | 1) => {
    if (!current) return;

    if (current.type === "text") {
      const text = cleanLastNewline(current.value);
      if (text.length > 0) tokens.push([text, color, emphasis]);
      return;
    }

    const properties = current.properties ?? {};
    const raw = colorFromStyle(properties.style);
    let nextColor = color;
    if (raw != null) {
      let paletteIndex = palette.get(raw);
      if (paletteIndex == null) {
        paletteIndex = palette.size;
        palette.set(raw, paletteIndex);
      }
      nextColor = paletteIndex;
    }
    const nextEmphasis: 0 | 1 = Object.hasOwn(properties, "data-diff-span") ? 1 : emphasis;
    for (const child of current.children ?? []) visit(child, nextColor, nextEmphasis);
  };

  visit(node, -1, 0);
  return tokens;
}

/** Encode both sides of a rendered diff into the compact form. */
export function encodeCompactCode(code: {
  deletionLines: unknown[];
  additionLines: unknown[];
}): CompactCode {
  const palette = new Map<string, number>();
  const deletionLines = (code.deletionLines as Array<HastNode | undefined>).map((line) =>
    encodeLine(line, palette),
  );
  const additionLines = (code.additionLines as Array<HastNode | undefined>).map((line) =>
    encodeLine(line, palette),
  );

  return { deletionLines, additionLines, palette: [...palette.keys()] };
}

/**
 * Rebuild a HAST line from compact tokens: one flat span per token carrying the palette color and
 * the emphasis marker, which is all the span flattener reads.
 *
 * This is the cost a real integration pays on the main thread, so benchmarks must time it.
 */
export function decodeLine(tokens: CompactLine, palette: string[]): HastNode | undefined {
  if (!tokens) {
    return undefined;
  }

  return {
    type: "element",
    tagName: "div",
    properties: {},
    children: tokens.map(([text, color, emphasis]) => ({
      type: "element" as const,
      tagName: "span",
      properties: {
        ...(color >= 0 ? { style: `color:${palette[color]}` } : {}),
        ...(emphasis === 1 ? { "data-diff-span": "" } : {}),
      },
      children: [{ type: "text" as const, value: text }],
    })),
  };
}

/** Rebuild both sides of a compact payload into the HAST shape the row builders consume. */
export function decodeCompactCode(code: CompactCode) {
  return {
    deletionLines: code.deletionLines.map((line) => decodeLine(line, code.palette)),
    additionLines: code.additionLines.map((line) => decodeLine(line, code.palette)),
  };
}

/**
 * Rebuild only the first `rows` lines of each side.
 *
 * A terminal draws tens of rows no matter how many the file has, so a viewport-sized rebuild is
 * what a row-windowed consumer actually needs on arrival. The rest can be rebuilt on demand as the
 * user scrolls, which keeps the arrival cost independent of file size.
 */
export function decodeCompactWindow(code: CompactCode, rows: number) {
  const take = (lines: CompactLine[]) => {
    const out: Array<ReturnType<typeof decodeLine>> = [];
    for (let index = 0; index < Math.min(rows, lines.length); index += 1) {
      out.push(decodeLine(lines[index], code.palette));
    }
    return out;
  };

  return { deletionLines: take(code.deletionLines), additionLines: take(code.additionLines) };
}

/**
 * Columnar payload: the same information as `CompactCode`, but as one text blob plus flat typed
 * arrays instead of an array-of-arrays object graph.
 *
 * Structured clone walks every object and array it is given, so a compact payload still costs
 * deserialization time proportional to token count before any of our code runs. Typed arrays can
 * instead be handed over with a transfer list, which moves the buffer rather than copying it, and
 * one large string clones far faster than millions of small arrays.
 */
export interface ColumnarCode {
  /** Every token's text, concatenated. */
  text: string;
  /** Four ints per token: text offset, text length, palette index, emphasis flag. */
  tokens: Int32Array;
  /** Two ints per line: first token index, then token count, or -1 for an absent line. */
  deletionIndex: Int32Array;
  additionIndex: Int32Array;
  palette: string[];
}

/** The buffers in a columnar payload, for `postMessage`'s transfer list. */
export function columnarTransferList(code: ColumnarCode) {
  return [code.tokens.buffer, code.deletionIndex.buffer, code.additionIndex.buffer];
}

/** Encode a rendered diff into the columnar shape. */
export function encodeColumnarCode(code: {
  deletionLines: unknown[];
  additionLines: unknown[];
}): ColumnarCode {
  const palette = new Map<string, number>();
  const textParts: string[] = [];
  const tokenRecords: number[] = [];
  let textLength = 0;

  const encodeSide = (lines: Array<HastNode | undefined>) => {
    const index = new Int32Array(lines.length * 2);

    lines.forEach((node, lineIndex) => {
      if (!node) {
        index[lineIndex * 2 + 1] = -1;
        return;
      }

      const firstToken = tokenRecords.length / 4;
      let count = 0;

      const visit = (current: HastNode | undefined, color: number, emphasis: number) => {
        if (!current) return;

        if (current.type === "text") {
          const value = cleanLastNewline(current.value);
          if (value.length === 0) return;
          textParts.push(value);
          tokenRecords.push(textLength, value.length, color, emphasis);
          textLength += value.length;
          count += 1;
          return;
        }

        const properties = current.properties ?? {};
        const raw = colorFromStyle(properties.style);
        let nextColor = color;
        if (raw != null) {
          let paletteIndex = palette.get(raw);
          if (paletteIndex == null) {
            paletteIndex = palette.size;
            palette.set(raw, paletteIndex);
          }
          nextColor = paletteIndex;
        }
        const nextEmphasis = Object.hasOwn(properties, "data-diff-span") ? 1 : emphasis;
        for (const child of current.children ?? []) visit(child, nextColor, nextEmphasis);
      };

      visit(node, -1, 0);
      index[lineIndex * 2] = firstToken;
      index[lineIndex * 2 + 1] = count;
    });

    return index;
  };

  const deletionIndex = encodeSide(code.deletionLines as Array<HastNode | undefined>);
  const additionIndex = encodeSide(code.additionLines as Array<HastNode | undefined>);

  return {
    text: textParts.join(""),
    tokens: Int32Array.from(tokenRecords),
    deletionIndex,
    additionIndex,
    palette: [...palette.keys()],
  };
}

/** Rebuild one line out of a columnar payload. */
export function decodeColumnarLine(
  code: ColumnarCode,
  index: Int32Array,
  lineIndex: number,
): HastNode | undefined {
  const count = index[lineIndex * 2 + 1] ?? -1;
  if (count < 0) {
    return undefined;
  }

  const firstToken = index[lineIndex * 2] ?? 0;
  const children: HastNode[] = [];

  for (let token = 0; token < count; token += 1) {
    const base = (firstToken + token) * 4;
    const offset = code.tokens[base] ?? 0;
    const length = code.tokens[base + 1] ?? 0;
    const color = code.tokens[base + 2] ?? -1;
    const emphasis = code.tokens[base + 3] ?? 0;
    children.push({
      type: "element",
      tagName: "span",
      properties: {
        ...(color >= 0 ? { style: `color:${code.palette[color]}` } : {}),
        ...(emphasis === 1 ? { "data-diff-span": "" } : {}),
      },
      children: [{ type: "text", value: code.text.slice(offset, offset + length) }],
    });
  }

  return { type: "element", tagName: "div", properties: {}, children };
}

/** Rebuild only the first `rows` lines of each side from a columnar payload. */
export function decodeColumnarWindow(code: ColumnarCode, rows: number) {
  const take = (index: Int32Array) => {
    const out: Array<HastNode | undefined> = [];
    const lines = index.length / 2;
    for (let lineIndex = 0; lineIndex < Math.min(rows, lines); lineIndex += 1) {
      out.push(decodeColumnarLine(code, index, lineIndex));
    }
    return out;
  };

  return { deletionLines: take(code.deletionIndex), additionLines: take(code.additionIndex) };
}

/** Rebuild every line from a columnar payload, for equivalence checking. */
export function decodeColumnarCode(code: ColumnarCode) {
  const take = (index: Int32Array) => {
    const out: Array<HastNode | undefined> = [];
    for (let lineIndex = 0; lineIndex < index.length / 2; lineIndex += 1) {
      out.push(decodeColumnarLine(code, index, lineIndex));
    }
    return out;
  };

  return { deletionLines: take(code.deletionIndex), additionLines: take(code.additionIndex) };
}
