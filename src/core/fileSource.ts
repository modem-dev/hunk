/**
 * Low-level readers for full file contents used by input and VCS adapters.
 *
 * Each `DiffFile` may carry a `FileSourceFetcher` that knows how to read the
 * file's "old" and "new" sides without re-running the original diff. VCS
 * adapters own VCS-specific source-spec construction; this module only executes
 * the concrete reads and returns `null` when source content is unreachable.
 */

export type FileSourceSpec =
  | { kind: "none" }
  | { kind: "fs"; absolutePath: string }
  | { kind: "git-blob"; repoRoot: string; ref: string; path: string }
  | { kind: "git-index"; repoRoot: string; path: string };

export type FileSourceSide = "old" | "new";

export interface FileSourceFetcher {
  /**
   * Returns the file's full source text on the requested side, or `null` when
   * the side is not reachable (deleted side, missing path, git error). Built-in
   * fetchers resolve `null` instead of rejecting, but UI callers still handle
   * custom fetcher rejection defensively.
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
  gitExecutable?: string;
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
function logSourceDiagnostic(message: string, detail?: unknown) {
  if (detail instanceof Error) {
    console.error(`hunk: ${message}: ${detail.message}`, detail);
    return;
  }

  const detailText = typeof detail === "string" ? firstDiagnosticLine(detail) : undefined;
  console.error(detailText ? `hunk: ${message}: ${detailText}` : `hunk: ${message}`);
}

/** Return whether a Git failure is an expected missing source side/path. */
function isExpectedMissingGitSource(stderr: string) {
  const normalized = stderr.toLowerCase();
  return [
    "exists on disk, but not in",
    "does not exist in",
    "invalid object name",
    "needed a single revision",
    "unknown revision or path not in the working tree",
  ].some((fragment) => normalized.includes(fragment));
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

function readGitBlobSpec(
  spec: Extract<FileSourceSpec, { kind: "git-blob" }>,
  gitExecutable = "git",
  maxSourceBytes: number,
): Promise<string | null> {
  return readGitObjectSpec(
    spec.repoRoot,
    `${spec.ref}:${spec.path}`,
    gitExecutable,
    maxSourceBytes,
  );
}

function readGitIndexSpec(
  spec: Extract<FileSourceSpec, { kind: "git-index" }>,
  gitExecutable = "git",
  maxSourceBytes: number,
): Promise<string | null> {
  return readGitObjectSpec(spec.repoRoot, `:${spec.path}`, gitExecutable, maxSourceBytes);
}

async function readStreamTextWithLimit(
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

/** Read a blob-like Git object spec such as `HEAD:path` or `:path`. */
async function readGitObjectSpec(
  repoRoot: string,
  objectName: string,
  gitExecutable = "git",
  maxSourceBytes: number,
): Promise<string | null> {
  let proc: Bun.ReadableSubprocess;

  try {
    proc = Bun.spawn([gitExecutable, "show", objectName], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    logSourceDiagnostic(`failed to run Git while reading source ${objectName}`, error);
    return null;
  }

  let output: [number, string, string];
  try {
    output = await Promise.all([
      proc.exited,
      readStreamTextWithLimit(proc.stdout, maxSourceBytes, () => proc.kill()),
      readStreamTextWithLimit(
        proc.stderr,
        64 * 1024,
        undefined,
        (maxBytes) => new Error(`Git source diagnostics exceeded ${maxBytes} bytes.`),
      ),
    ]);
  } catch (error) {
    if (error instanceof SourceTextTooLargeError) {
      proc.kill();
      await proc.exited.catch(() => undefined);
      throw error;
    }

    logSourceDiagnostic(`failed to collect Git source ${objectName}`, error);
    return null;
  }

  const [exitCode, stdout, stderr] = output;

  if (exitCode !== 0) {
    if (!isExpectedMissingGitSource(stderr)) {
      logSourceDiagnostic(`failed to read Git source ${objectName} in ${repoRoot}`, stderr);
    }
    return null;
  }

  return stdout;
}

async function readSpec(
  spec: FileSourceSpec,
  {
    gitExecutable = "git",
    maxSourceBytes = DEFAULT_SOURCE_TEXT_MAX_BYTES,
  }: FileSourceFetcherOptions = {},
): Promise<string | null> {
  if (spec.kind === "none") {
    return null;
  }

  if (spec.kind === "fs") {
    return readFsSpec(spec, maxSourceBytes);
  }

  if (spec.kind === "git-index") {
    return readGitIndexSpec(spec, gitExecutable, maxSourceBytes);
  }

  return readGitBlobSpec(spec, gitExecutable, maxSourceBytes);
}

/** Build a per-file source fetcher that caches each side's resolved text. */
export function createFileSourceFetcher(
  specs: ResolvedSpecs,
  {
    gitExecutable = "git",
    maxSourceBytes = DEFAULT_SOURCE_TEXT_MAX_BYTES,
  }: Readonly<FileSourceFetcherOptions> = {},
): FileSourceFetcher {
  const cache = new Map<FileSourceSide, string | null>();

  return {
    async getFullText(side) {
      if (cache.has(side)) {
        return cache.get(side) ?? null;
      }

      const text = await readSpec(specs[side], { gitExecutable, maxSourceBytes });
      cache.set(side, text);
      return text;
    },
  };
}
