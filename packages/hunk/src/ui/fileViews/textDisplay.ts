import { TextBuffer, TextBufferView } from "@opentui/core";
import { measureClusterWidth, measureSanitizedTextWidth, textClusters } from "../lib/text";

/** OpenTUI's text buffer expands each tab to two cells rather than positional tab stops. */
export const FILE_VIEW_TAB_WIDTH = 2;

/** Expand retained tabs only for terminal display, after syntax ranges have used original offsets. */
export function fileViewDisplayText(text: string) {
  return text.includes("\t") ? text.replaceAll("\t", " ".repeat(FILE_VIEW_TAB_WIDTH)) : text;
}

/** Expand tabs independently inside styled chunks without changing their paint metadata. */
export function fileViewDisplaySpans<T extends { text: string }>(spans: readonly T[]): T[] {
  let expanded: T[] | null = null;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    const text = fileViewDisplayText(span.text);
    if (text === span.text) {
      expanded?.push(span);
      continue;
    }
    expanded ??= spans.slice(0, index);
    expanded.push({ ...span, text });
  }
  return expanded ?? [...spans];
}

interface MeasuredCluster {
  readonly text: string;
  readonly width: number;
  readonly whitespace: boolean;
}

/** Count word-wrapped rows without native state when OpenTUI measurement is unavailable. */
function measureFileViewDisplayTextHeightFallback(text: string, width: number) {
  const lineWidth = Math.max(1, Math.floor(width));
  const clusters: MeasuredCluster[] = textClusters(fileViewDisplayText(text)).map((cluster) => ({
    text: cluster,
    width: measureClusterWidth(cluster),
    whitespace: /^\s+$/u.test(cluster),
  }));
  if (clusters.length === 0) return 1;

  let lines = 0;
  let currentWidth = 0;
  let currentHasNonWhitespace = false;

  /** Finish one visual row, including rows that contain only display whitespace. */
  const commit = () => {
    if (currentWidth <= 0) return;
    lines += 1;
    currentWidth = 0;
    currentHasNonWhitespace = false;
  };

  /** Add clusters with character fallback once a word exceeds the complete row. */
  const addFlow = (flow: readonly MeasuredCluster[]) => {
    for (const cluster of flow) {
      if (cluster.width > lineWidth) {
        commit();
        lines += 1;
        continue;
      }
      if (currentWidth + cluster.width > lineWidth) commit();
      currentWidth += cluster.width;
      currentHasNonWhitespace ||= !cluster.whitespace;
    }
  };

  for (let index = 0; index < clusters.length; ) {
    const whitespace = clusters[index]!.whitespace;
    let end = index + 1;
    while (end < clusters.length && clusters[end]!.whitespace === whitespace) end += 1;
    const group = clusters.slice(index, end);
    index = end;

    if (whitespace) {
      addFlow(group);
      continue;
    }

    const wordWidth = group.reduce((total, cluster) => total + cluster.width, 0);
    const remaining = lineWidth - currentWidth;
    if (wordWidth <= remaining) {
      currentWidth += wordWidth;
      currentHasNonWhitespace = true;
      continue;
    }
    if (wordWidth <= lineWidth) {
      commit();
      currentWidth = wordWidth;
      currentHasNonWhitespace = true;
      continue;
    }

    // An oversized word continues after real content, but leading whitespace occupies its own row.
    if (currentWidth > 0 && !currentHasNonWhitespace) commit();
    addFlow(group);
  }

  commit();
  return Math.max(1, lines);
}

/** Reuse OpenTUI's native word-wrap engine while validating every row in one layout. */
export class FileViewTextMeasurer {
  #buffer: TextBuffer | undefined;
  #view: TextBufferView | undefined;
  #nativeAvailable = true;

  /** Measure the exact display text that FileView passes to its word-wrapped text renderable. */
  measure(text: string, width: number) {
    const usableWidth = Math.max(1, Math.floor(width));
    const displayText = fileViewDisplayText(text);
    if (displayText.length === 0 || measureSanitizedTextWidth(displayText) <= usableWidth) return 1;
    // With no breakable whitespace, OpenTUI word wrapping is identical to character fallback.
    if (!/\s/u.test(displayText)) {
      return measureFileViewDisplayTextHeightFallback(displayText, usableWidth);
    }
    if (this.#nativeAvailable) {
      try {
        this.#buffer ??= TextBuffer.create("unicode");
        this.#view ??= TextBufferView.create(this.#buffer);
        this.#buffer.setText(displayText);
        this.#view.setWrapMode("word");
        this.#view.setWrapWidth(usableWidth);
        const measured = this.#view.measureForDimensions(usableWidth, 1_000_001);
        if (measured) return Math.max(1, measured.lineCount);
      } catch {
        this.#nativeAvailable = false;
        this.destroy();
      }
    }
    return measureFileViewDisplayTextHeightFallback(text, usableWidth);
  }

  /** Release native measurement resources after one layout validation. */
  destroy() {
    this.#view?.destroy();
    this.#buffer?.destroy();
    this.#view = undefined;
    this.#buffer = undefined;
  }
}

/** Measure one standalone row with the same native word-wrap engine as FileView paint. */
export function measureFileViewDisplayTextHeight(text: string, width: number) {
  const measurer = new FileViewTextMeasurer();
  try {
    return measurer.measure(text, width);
  } finally {
    measurer.destroy();
  }
}
