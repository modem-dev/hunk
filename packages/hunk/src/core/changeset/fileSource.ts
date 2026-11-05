import {
  DEFAULT_SOURCE_BYTES_MAX_BYTES,
  DEFAULT_SOURCE_TEXT_MAX_BYTES,
  readFileBytesWithLimit,
  readFileTextWithLimit,
} from "@hunk/vcs/source";

export { DEFAULT_SOURCE_BYTES_MAX_BYTES, DEFAULT_SOURCE_TEXT_MAX_BYTES } from "@hunk/vcs/source";

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
  /** Stable identity for source state not already represented by the file's patch. */
  readonly cacheKey?: string;
  /**
   * Returns the file's full source text on the requested side, or `null` when
   * the side is not reachable (deleted side, missing path, provider error).
   * Built-in fetchers resolve `null` instead of rejecting, but UI callers still
   * handle custom fetcher rejection defensively.
   */
  getFullText(side: FileSourceSide): Promise<string | null>;
}

/**
 * Reads a file's exact bytes on either side, for presentations of content that is not text.
 *
 * Separate from `FileSourceFetcher` because it also serves binary files, which deliberately have
 * no text fetcher: attaching one would make every text-source consumer (context expansion,
 * highlighting) treat images as readable documents.
 */
export interface FileByteFetcher {
  /**
   * Returns the side's exact bytes, or `null` when the side is unreachable or over the byte
   * ceiling. Built-in fetchers resolve `null` instead of rejecting.
   */
  getBytes(side: FileSourceSide): Promise<Uint8Array | null>;
}

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

async function readFsSpec(
  spec: Extract<FileSourceSpec, { kind: "fs" }>,
  maxSourceBytes: number,
): Promise<string | null> {
  const result = await readFileTextWithLimit(spec.absolutePath, maxSourceBytes);
  if (typeof result === "object" && result !== null) {
    throw new SourceTextTooLargeError(result.maxBytes);
  }
  return result;
}

/** Read the text one filesystem-backed source spec names, or null when there is none. */
export async function readFileSourceSpec(
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

      const text = await readFileSourceSpec(specs[side], { maxSourceBytes });
      cache.set(side, text);
      return text;
    },
  };
}

/** Read the bytes one filesystem-backed source spec names, or null when there is none or too many. */
async function readFileSourceSpecBytes(spec: FileSourceSpec, maxBytes: number) {
  if (spec.kind === "none") {
    return null;
  }

  const result = await readFileBytesWithLimit(spec.absolutePath, maxBytes);
  return result instanceof Uint8Array ? result : null;
}

/** Build a per-file byte fetcher over filesystem specs that caches each side's bytes. */
export function createFileByteFetcher(
  specs: ResolvedSpecs,
  { maxBytes = DEFAULT_SOURCE_BYTES_MAX_BYTES }: Readonly<{ maxBytes?: number }> = {},
): FileByteFetcher {
  const cache = new Map<FileSourceSide, Promise<Uint8Array | null>>();

  return {
    getBytes(side) {
      let read = cache.get(side);
      if (!read) {
        read = readFileSourceSpecBytes(specs[side], maxBytes);
        cache.set(side, read);
      }
      return read;
    },
  };
}
