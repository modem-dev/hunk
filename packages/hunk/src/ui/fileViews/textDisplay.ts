import { TextBuffer, TextBufferView } from "@opentui/core";
import { measureClusterWidth, textClusters } from "../lib/text";

/** OpenTUI renders each retained tab as one indivisible two-cell cluster. */
export const FILE_VIEW_TAB_WIDTH = 2;

interface MeasuredCluster {
  readonly width: number;
  /** OpenTUI wraps whitespace, narrow words, and adjacent wide clusters as distinct flows. */
  readonly wordClass: "whitespace" | "narrow" | "wide";
}

/** Return the display width OpenTUI uses for one retained file-view cluster. */
function fileViewClusterWidth(cluster: string) {
  return cluster === "\t" ? FILE_VIEW_TAB_WIDTH : measureClusterWidth(cluster);
}

/** Count word-wrapped rows if native OpenTUI measurement fails unexpectedly. */
function measureFileViewTextHeightFallback(text: string, width: number) {
  const lineWidth = Math.max(1, Math.floor(width));
  const clusters: MeasuredCluster[] = textClusters(text).map((cluster) => {
    const width = fileViewClusterWidth(cluster);
    return {
      width,
      wordClass: /^\s+$/u.test(cluster) ? "whitespace" : width > 1 ? "wide" : "narrow",
    };
  });
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

  /** Add indivisible clusters with character fallback once a word exceeds a complete row. */
  const addFlow = (flow: readonly MeasuredCluster[]) => {
    for (const cluster of flow) {
      if (cluster.width > lineWidth) {
        commit();
        lines += Math.ceil(cluster.width / lineWidth);
        continue;
      }
      if (currentWidth + cluster.width > lineWidth) commit();
      currentWidth += cluster.width;
      currentHasNonWhitespace ||= cluster.wordClass !== "whitespace";
    }
  };

  for (let index = 0; index < clusters.length; ) {
    const wordClass = clusters[index]!.wordClass;
    let end = index + 1;
    while (end < clusters.length && clusters[end]!.wordClass === wordClass) end += 1;
    const group = clusters.slice(index, end);
    index = end;

    if (wordClass === "whitespace") {
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

  /** Measure retained text exactly as FileView passes it to OpenTUI's word-wrapped renderable. */
  measure(text: string, width: number) {
    if (text.length === 0) return 1;
    const usableWidth = Math.max(1, Math.floor(width));
    if (this.#nativeAvailable) {
      try {
        this.#buffer ??= TextBuffer.create("unicode");
        this.#view ??= TextBufferView.create(this.#buffer);
        this.#buffer.setText(text);
        this.#view.setWrapMode("word");
        this.#view.setWrapWidth(usableWidth);
        const measured = this.#view.measureForDimensions(usableWidth, 1_000_001);
        if (measured) return Math.max(1, measured.lineCount);
      } catch {
        this.#nativeAvailable = false;
        this.destroy();
      }
    }
    return measureFileViewTextHeightFallback(text, usableWidth);
  }

  /** Release native measurement resources after one layout validation. */
  destroy() {
    this.#view?.destroy();
    this.#buffer?.destroy();
    this.#view = undefined;
    this.#buffer = undefined;
  }
}

/** Expose native-failure measurement only for parity tests of the production fallback. */
export function measureFileViewTextHeightFallbackForTest(text: string, width: number) {
  return measureFileViewTextHeightFallback(text, width);
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
