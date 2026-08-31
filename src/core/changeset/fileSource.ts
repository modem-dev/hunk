import { DEFAULT_SOURCE_TEXT_MAX_BYTES, readFileTextWithLimit } from "../../lib/sourceText";

export { DEFAULT_SOURCE_TEXT_MAX_BYTES } from "../../lib/sourceText";

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

/** Exact filesystem paths for the reviewed sides, or null when a side is not filesystem-backed. */
export interface FileSourcePaths {
  readonly old: string | null;
  readonly new: string | null;
}

/** Generic source specs for both sides of one reviewed file. */
export interface FileSourceSpecs {
  old: FileSourceSpec;
  new: FileSourceSpec;
}

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

/** Project source specs to the exact paths of only their filesystem-backed sides. */
export function fileSourcePathsForSpecs(specs: FileSourceSpecs): FileSourcePaths {
  return {
    old: specs.old.kind === "fs" ? specs.old.absolutePath : null,
    new: specs.new.kind === "fs" ? specs.new.absolutePath : null,
  };
}

/** Build a per-file source fetcher that caches each side's resolved text. */
export function createFileSourceFetcher(
  specs: FileSourceSpecs,
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
