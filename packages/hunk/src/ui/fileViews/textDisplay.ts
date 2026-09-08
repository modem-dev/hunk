import { TextBuffer, TextBufferView } from "@opentui/core";

/** OpenTUI renders each retained tab at a fixed two-cell width. */
export const FILE_VIEW_TAB_WIDTH = 2;

const FILE_VIEW_TEXT_MEASUREMENT_ERROR = "file-view text measurement unavailable";

interface NativeFileViewTextBuffer {
  setText(text: string): void;
  destroy(): void;
}

interface NativeFileViewTextBufferView {
  setWrapMode(mode: "word"): void;
  setWrapWidth(width: number): void;
  measureForDimensions(width: number, height: number): { lineCount: number } | null;
  destroy(): void;
}

interface NativeFileViewTextMeasurement {
  readonly buffer: NativeFileViewTextBuffer;
  readonly view: NativeFileViewTextBufferView;
}

type NativeFileViewTextMeasurementFactory = () => NativeFileViewTextMeasurement;

/** Create the native buffer pair that shares FileView's OpenTUI wrapping behavior. */
function createNativeFileViewTextMeasurement(): NativeFileViewTextMeasurement {
  const buffer = TextBuffer.create("unicode");
  try {
    return { buffer, view: TextBufferView.create(buffer) };
  } catch (error) {
    try {
      buffer.destroy();
    } catch {
      // Preserve the bounded measurement failure rather than surfacing teardown details.
    }
    throw error;
  }
}

/** Reuse OpenTUI's native word-wrap engine while validating every row in one layout. */
export class FileViewTextMeasurer {
  #buffer: NativeFileViewTextBuffer | undefined;
  #view: NativeFileViewTextBufferView | undefined;
  #nativeAvailable = true;

  constructor(
    private readonly createNativeMeasurement: NativeFileViewTextMeasurementFactory = createNativeFileViewTextMeasurement,
  ) {}

  /** Measure retained text exactly as FileView passes it to OpenTUI's word-wrapped renderable. */
  measure(text: string, width: number) {
    if (text.length === 0) return 1;
    if (!this.#nativeAvailable) throw new Error(FILE_VIEW_TEXT_MEASUREMENT_ERROR);

    const usableWidth = Math.max(1, Math.floor(width));
    try {
      if (!this.#buffer || !this.#view) {
        const native = this.createNativeMeasurement();
        this.#buffer = native.buffer;
        this.#view = native.view;
      }
      this.#buffer.setText(text);
      this.#view.setWrapMode("word");
      this.#view.setWrapWidth(usableWidth);
      const measured = this.#view.measureForDimensions(usableWidth, 1_000_001);
      if (
        !measured ||
        !Number.isSafeInteger(measured.lineCount) ||
        measured.lineCount < 0 ||
        measured.lineCount > 1_000_001
      ) {
        throw new Error(FILE_VIEW_TEXT_MEASUREMENT_ERROR);
      }
      return Math.max(1, measured.lineCount);
    } catch {
      this.#nativeAvailable = false;
      this.destroy();
      throw new Error(FILE_VIEW_TEXT_MEASUREMENT_ERROR);
    }
  }

  /** Release native measurement resources after one layout validation. */
  destroy() {
    const view = this.#view;
    const buffer = this.#buffer;
    this.#view = undefined;
    this.#buffer = undefined;
    try {
      view?.destroy();
    } catch {
      // Teardown must not mask validation or renderer failures.
    }
    try {
      buffer?.destroy();
    } catch {
      // Teardown must not mask validation or renderer failures.
    }
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
