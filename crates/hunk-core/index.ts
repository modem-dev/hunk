// Binds the hunk-core cdylib through bun:ffi.
//
// Every call passes caller-owned memory across the boundary, so nothing here needs freeing.
// Batch entry points exist because per-call FFI overhead dominates single-line work: prefer
// measuring a whole changeset in one call over calling once per rendered row.

import { dlopen, FFIType, ptr, suffix } from "bun:ffi";
import { fileURLToPath } from "node:url";

const libraryPath = fileURLToPath(
  new URL(`../../crates/hunk-core/target/release/libhunk_core.${suffix}`, import.meta.url),
);

const { symbols } = dlopen(libraryPath, {
  hunk_measure_width: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
  hunk_measure_widths: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
  hunk_intraline_spans: {
    args: [
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
    ],
    returns: FFIType.i64,
  },
  hunk_intraline_spans_batch: {
    args: [
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
    ],
    returns: FFIType.i64,
  },
});

const encoder = new TextEncoder();

/** Encode text as UTF-8 for the boundary; the crate rejects anything that is not valid UTF-8. */
function encode(text: string) {
  return encoder.encode(text);
}

/** Measure one string in terminal cells. */
export function measureWidth(text: string): number {
  // bun:ffi cannot take a pointer to a zero-length buffer, and empty text is zero cells anyway.
  if (text.length === 0) {
    return 0;
  }

  const bytes = encode(text);
  const result = Number(symbols.hunk_measure_width(ptr(bytes), bytes.byteLength));
  if (result < 0) {
    throw new Error("hunk_measure_width rejected its input");
  }
  return result;
}

/**
 * Measure many lines in one call.
 *
 * Joining with newlines means the boundary is crossed once per changeset rather than once per
 * row, which is the difference between the native path being a win and being a loss.
 */
export function measureWidths(lines: readonly string[]): Uint32Array {
  if (lines.length === 0) {
    return new Uint32Array(0);
  }

  const joined = lines.join("\n");
  // An all-empty input joins to newlines only, or to nothing for a single empty line.
  if (joined.length === 0) {
    return new Uint32Array(lines.length);
  }

  const bytes = encode(joined);
  const out = new Uint32Array(lines.length);
  const count = Number(
    symbols.hunk_measure_widths(ptr(bytes), bytes.byteLength, ptr(out), out.length),
  );
  if (count !== lines.length) {
    throw new Error(`hunk_measure_widths returned ${count} widths for ${lines.length} lines`);
  }
  return out;
}

export interface IntralineSpan {
  side: "before" | "after";
  /** UTF-8 byte offsets into the line as encoded for the boundary, not UTF-16 indexes. */
  start: number;
  end: number;
}

const DEFAULT_MAX_LINE_LENGTH = 10_000;

/** Compute word-level changed spans between two versions of one line. */
export function intralineSpans(
  before: string,
  after: string,
  maxLineLength = DEFAULT_MAX_LINE_LENGTH,
): IntralineSpan[] {
  const beforeBytes = encode(before);
  const afterBytes = encode(after);
  // Every token can change, and a change is at most one span per side per token.
  const capacity = Math.max(16, (beforeBytes.length + afterBytes.length) * 3);
  const out = new Uint32Array(capacity);

  const count = Number(
    symbols.hunk_intraline_spans(
      ptr(beforeBytes),
      beforeBytes.byteLength,
      ptr(afterBytes),
      afterBytes.byteLength,
      maxLineLength,
      ptr(out),
      out.length,
    ),
  );
  if (count < 0) {
    throw new Error("hunk_intraline_spans rejected its input");
  }

  const spans: IntralineSpan[] = [];
  for (let i = 0; i < count; i++) {
    spans.push({
      side: out[i * 3] === 0 ? "before" : "after",
      start: out[i * 3 + 1]!,
      end: out[i * 3 + 2]!,
    });
  }
  return spans;
}

/** Compute intraline spans for many line pairs in one call, indexed by pair position. */
export function intralineSpansBatch(
  before: readonly string[],
  after: readonly string[],
  maxLineLength = DEFAULT_MAX_LINE_LENGTH,
): IntralineSpan[][] {
  if (before.length !== after.length) {
    throw new Error("intralineSpansBatch needs one before line per after line");
  }
  if (before.length === 0) {
    return [];
  }

  const beforeBytes = encode(before.join("\n"));
  const afterBytes = encode(after.join("\n"));
  const capacity = Math.max(64, (beforeBytes.length + afterBytes.length) * 2);
  const out = new Uint32Array(capacity);

  const count = Number(
    symbols.hunk_intraline_spans_batch(
      ptr(beforeBytes),
      beforeBytes.byteLength,
      ptr(afterBytes),
      afterBytes.byteLength,
      maxLineLength,
      ptr(out),
      out.length,
    ),
  );
  if (count < 0) {
    throw new Error("hunk_intraline_spans_batch rejected its input");
  }

  const result: IntralineSpan[][] = before.map(() => []);
  for (let i = 0; i < count; i++) {
    result[out[i * 4]!]!.push({
      side: out[i * 4 + 1] === 0 ? "before" : "after",
      start: out[i * 4 + 2]!,
      end: out[i * 4 + 3]!,
    });
  }
  return result;
}
