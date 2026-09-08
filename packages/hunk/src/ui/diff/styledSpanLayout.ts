// Plans terminal-cell slicing and wrapping for styled diff spans.
import { sanitizeTerminalSpans } from "../../lib/terminalText";
import {
  isPrintableAsciiText,
  measureSanitizedTextWidth,
  measureSimpleSanitizedTextWidth,
  sliceSanitizedTextByWidth,
  textClusters,
  wrapSanitizedTextByWidth,
} from "../lib/text";
import type { RenderSpan } from "./diffRowModel";

/** Append a styled span while preserving color-run coalescing. */
function appendRenderSpan(target: RenderSpan[], span: RenderSpan) {
  const previous = target.at(-1);
  if (
    previous &&
    previous.fg === span.fg &&
    previous.bg === span.bg &&
    previous.transformFg === span.transformFg
  ) {
    previous.text += span.text;
  } else {
    target.push(span);
  }
}

/** Return the first or last scalar in one non-empty string. */
function boundaryScalar(text: string, first: boolean) {
  if (first) {
    const codePoint = text.codePointAt(0);
    return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
  }

  let scalar = "";
  for (const candidate of text) {
    scalar = candidate;
  }
  return scalar;
}

/** Return whether a styled-span boundary may divide one grapheme cluster. */
function spansMaySplitGrapheme(spans: RenderSpan[]) {
  for (let index = 1; index < spans.length; index += 1) {
    const left = boundaryScalar(spans[index - 1]?.text ?? "", false);
    const right = boundaryScalar(spans[index]?.text ?? "", true);
    if (
      (left && measureSimpleSanitizedTextWidth(left) === null) ||
      (right && measureSimpleSanitizedTextWidth(right) === null)
    ) {
      return true;
    }
  }
  return false;
}

/** Merge indivisible graphemes while preserving the style where each cluster starts. */
function mergeCrossSpanGraphemes(spans: RenderSpan[]) {
  const normalized: RenderSpan[] = [];
  const text = spans.map((span) => span.text).join("");
  let sourceIndex = 0;
  let sourceEnd = spans[0]?.text.length ?? 0;
  let cursor = 0;

  for (const cluster of textClusters(text)) {
    while (cursor >= sourceEnd && sourceIndex < spans.length - 1) {
      sourceIndex += 1;
      sourceEnd += spans[sourceIndex]?.text.length ?? 0;
    }
    const source = spans[sourceIndex];
    if (source) {
      appendRenderSpan(normalized, { ...source, text: cluster });
    }
    cursor += cluster.length;
  }
  return normalized;
}

/** Merge only indivisible graphemes that may cross styled-span boundaries. */
function preserveCrossSpanGraphemes(spans: RenderSpan[]) {
  return spansMaySplitGrapheme(spans) ? mergeCrossSpanGraphemes(spans) : spans;
}

/** Slice styled spans to one visible window while preserving color runs. */
export function sliceSpansWindow(spans: RenderSpan[], offset: number, width: number) {
  if (width <= 0) {
    return {
      spans: [] as RenderSpan[],
      usedWidth: 0,
    };
  }

  const sliced: RenderSpan[] = [];
  let remainingOffset = Math.max(0, offset);
  let remaining = width;
  let usedWidth = 0;

  for (const span of spans) {
    if (remaining <= 0) {
      break;
    }

    const spanWidth = measureSanitizedTextWidth(span.text);
    if (spanWidth === 0) {
      appendRenderSpan(sliced, { ...span });
      continue;
    }

    if (remainingOffset >= spanWidth) {
      remainingOffset -= spanWidth;
      continue;
    }

    if (remainingOffset === 0 && spanWidth <= remaining) {
      // Preserve the full safe span without re-slicing its graphemes. Clone before coalescing so
      // appendRenderSpan can never mutate the caller-owned highlighted span object.
      appendRenderSpan(sliced, { ...span });
      remaining -= spanWidth;
      usedWidth += spanWidth;
      continue;
    }

    const visible = sliceSanitizedTextByWidth(span.text, remainingOffset, remaining);
    remainingOffset = 0;

    if (visible.text.length === 0) {
      continue;
    }

    const nextSpan = {
      ...span,
      text: visible.text,
    };

    appendRenderSpan(sliced, nextSpan);

    remaining -= visible.width;
    usedWidth += visible.width;
  }

  return {
    spans: sliced,
    usedWidth,
  };
}

// Repeated offset slicing is faster for short spans, while its repeated grapheme traversal turns
// quadratic once one span crosses many visual lines. Switch only where the linear planner wins
// decisively so ordinary wrapped and nowrap text retain their established fast paths.
const SINGLE_PASS_WRAP_LINE_THRESHOLD = 8;

/** Wrap styled spans into visual lines while preserving color runs across splits. */
export function wrapSpans(spans: RenderSpan[], width: number) {
  if (width <= 0) {
    return [[]] as RenderSpan[][];
  }

  const lines: RenderSpan[][] = [[]];
  let current = lines[0]!;
  let remaining = width;
  const safeSpans = sanitizeTerminalSpans(spans);
  let plannedSpans = safeSpans;
  let hasCompositionSensitiveSpan = false;
  let simpleSpanWidths: Array<number | null> = [];
  for (const span of safeSpans) {
    const spanWidth = measureSimpleSanitizedTextWidth(span.text);
    simpleSpanWidths.push(spanWidth);
    hasCompositionSensitiveSpan ||= spanWidth === null;
  }
  if (safeSpans.length > 1 && hasCompositionSensitiveSpan) {
    plannedSpans = mergeCrossSpanGraphemes(safeSpans);
    simpleSpanWidths = plannedSpans.map((span) => measureSimpleSanitizedTextWidth(span.text));
  }

  for (let spanIndex = 0; spanIndex < plannedSpans.length; spanIndex += 1) {
    const span = plannedSpans[spanIndex]!;
    const simpleSpanWidth = simpleSpanWidths[spanIndex] ?? null;
    const spanWidth = simpleSpanWidth ?? measureSanitizedTextWidth(span.text);
    if (spanWidth === 0) {
      appendRenderSpan(current, { ...span });
      continue;
    }

    if (
      spanWidth > width * SINGLE_PASS_WRAP_LINE_THRESHOLD ||
      simpleSpanWidth === null ||
      (width === 1 && !isPrintableAsciiText(span.text))
    ) {
      for (const chunk of wrapSanitizedTextByWidth(
        span.text,
        width,
        remaining,
        current.length > 0,
      )) {
        if (chunk.startsNewLine) {
          current = [];
          lines.push(current);
          remaining = width;
        }
        if (chunk.text.length > 0) {
          appendRenderSpan(current, { ...span, text: chunk.text });
        }
        remaining -= chunk.width;
      }
      continue;
    }

    let offset = 0;

    while (offset < spanWidth) {
      if (remaining <= 0) {
        current = [];
        lines.push(current);
        remaining = width;
      }

      const visible = sliceSanitizedTextByWidth(span.text, offset, remaining);
      if (visible.width === 0) {
        // Move to a fresh row only when this row already contains content. If the full row itself
        // is too narrow, keep the single attempted continuation aligned with geometry measurement.
        if (current.length > 0 || remaining < width) {
          current = [];
          lines.push(current);
          remaining = width;
        }
        const forced = sliceSanitizedTextByWidth(span.text, offset, width);
        if (forced.width === 0) {
          break;
        }
        const nextSpan = {
          ...span,
          text: forced.text,
        };
        current.push(nextSpan);
        offset += forced.width;
        remaining = Math.max(0, width - forced.width);
        continue;
      }

      const nextSpan = {
        ...span,
        text: visible.text,
      };
      appendRenderSpan(current, nextSpan);

      offset += visible.width;
      remaining -= visible.width;
    }
  }

  return lines;
}

/** Count wrapped visual lines without allocating the styled line arrays used by rendering. */
export function measureWrappedSpansLineCount(spans: RenderSpan[], width: number) {
  if (width <= 0) {
    return 1;
  }

  let lineCount = 1;
  let remaining = width;
  let currentLineHasContent = false;
  const safeSpans = preserveCrossSpanGraphemes(sanitizeTerminalSpans(spans));
  for (const span of safeSpans) {
    // Preserve zero-width span presence across styled runs so a later over-wide grapheme makes the
    // same continuation decision as wrapSpans' concrete line arrays.
    for (const chunk of wrapSanitizedTextByWidth(
      span.text,
      width,
      remaining,
      currentLineHasContent,
    )) {
      if (chunk.startsNewLine) {
        lineCount += 1;
        remaining = width;
        currentLineHasContent = false;
      }
      remaining -= chunk.width;
      currentLineHasContent ||= chunk.text.length > 0;
    }
  }
  return lineCount;
}
