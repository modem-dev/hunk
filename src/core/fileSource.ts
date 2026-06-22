/**
 * Generic full-file source fetcher primitives used by input loaders and VCS adapters.
 *
 * Each `DiffFile` may carry a `FileSourceFetcher` that knows how to read the
 * file's "old" and "new" sides without re-running the original diff. Provider-
 * specific object reads live beside their VCS adapters; this module only owns
 * provider-neutral fetcher contracts and filesystem reads.
 */

export type FileSourceSpec = { kind: "none" } | { kind: "fs"; absolutePath: string };

export type FileSourceSide = "old" | "new";

export interface FileSourceFetcher {
  /**
   * Returns the file's full source text on the requested side, or `null` when
   * the side is not reachable (deleted side, missing path, provider error).
   * Built-in fetchers resolve `null` instead of rejecting, but UI callers still
   * handle custom fetcher rejection defensively.
   */
  getFullText(side: FileSourceSide): Promise<string | null>;
}

export const DEFAULT_SOURCE_TEXT_MAX_BYTES = 1_000_000;

/** Raised when expanded-context source would require reading an unsafe amount of text. */
export class SourceTextTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Source text exceeds ${maxBytes} bytes.`);
    this.name = "SourceTextTooLargeError";
  }
}

export interface FileSourceFetcherOptions {
  maxSourceBytes?: number;
}

interface ResolvedSpecs {
  old: FileSourceSpec;
  new: FileSourceSpec;
}

/** Return the first useful diagnostic line from a failed source read. */
function firstDiagnosticLine(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

/** Keep source-load diagnostics terse enough to be useful in logs. */
export function logSourceDiagnostic(message: string, detail?: unknown) {
  if (detail instanceof Error) {
    console.error(`hunk: ${message}: ${detail.message}`, detail);
    return;
  }

  const detailText = typeof detail === "string" ? firstDiagnosticLine(detail) : undefined;
  console.error(detailText ? `hunk: ${message}: ${detailText}` : `hunk: ${message}`);
}

async function readFsSpec(
  spec: Extract<FileSourceSpec, { kind: "fs" }>,
  maxSourceBytes: number,
): Promise<string | null> {
  try {
    const file = Bun.file(spec.absolutePath);
    if (!(await file.exists())) {
      return null;
    }

    if (file.size > maxSourceBytes) {
      throw new SourceTextTooLargeError(maxSourceBytes);
    }

    return await file.text();
  } catch (error) {
    if (error instanceof SourceTextTooLargeError) {
      throw error;
    }

    logSourceDiagnostic(`failed to read source file ${spec.absolutePath}`, error);
    return null;
  }
}

export async function readStreamTextWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onTooLarge?: () => void,
  createLimitError: (maxBytes: number) => Error = (maxBytes) =>
    new SourceTextTooLargeError(maxBytes),
) {
  if (!stream) {
    return "";
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      onTooLarge?.();
      await reader.cancel().catch(() => undefined);
      throw createLimitError(maxBytes);
    }

    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(combined);
}

async function readSpec(
  spec: FileSourceSpec,
  { maxSourceBytes = DEFAULT_SOURCE_TEXT_MAX_BYTES }: FileSourceFetcherOptions = {},
): Promise<string | null> {
  if (spec.kind === "none") {
    return null;
  }

  return readFsSpec(spec, maxSourceBytes);
}

/** Build a per-file source fetcher that caches each side's resolved text. */
export function createFileSourceFetcher(
  specs: ResolvedSpecs,
  { maxSourceBytes = DEFAULT_SOURCE_TEXT_MAX_BYTES }: Readonly<FileSourceFetcherOptions> = {},
): FileSourceFetcher {
  const cache = new Map<FileSourceSide, string | null>();

  return {
    async getFullText(side) {
      if (cache.has(side)) {
        return cache.get(side) ?? null;
      }

      const text = await readSpec(specs[side], { maxSourceBytes });
      cache.set(side, text);
      return text;
    },
  };
}
