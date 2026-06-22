import {
  DEFAULT_SOURCE_TEXT_MAX_BYTES,
  SourceTextTooLargeError,
  createFileSourceFetcher,
  logSourceDiagnostic,
  readStreamTextWithLimit,
  type FileSourceFetcher,
  type FileSourceSide,
  type FileSourceSpec,
} from "../fileSource";

export type GitFileSourceSpec =
  | FileSourceSpec
  | { kind: "git-blob"; repoRoot: string; ref: string; path: string }
  | { kind: "git-index"; repoRoot: string; path: string };

export interface GitFileSourceFetcherOptions {
  gitExecutable?: string;
  maxSourceBytes?: number;
}

interface GitResolvedSpecs {
  old: GitFileSourceSpec;
  new: GitFileSourceSpec;
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

function readGitBlobSpec(
  spec: Extract<GitFileSourceSpec, { kind: "git-blob" }>,
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
  spec: Extract<GitFileSourceSpec, { kind: "git-index" }>,
  gitExecutable = "git",
  maxSourceBytes: number,
): Promise<string | null> {
  return readGitObjectSpec(spec.repoRoot, `:${spec.path}`, gitExecutable, maxSourceBytes);
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

async function readGitSpec(
  spec: GitFileSourceSpec,
  options: GitFileSourceFetcherOptions,
): Promise<string | null> {
  const { gitExecutable = "git", maxSourceBytes = DEFAULT_SOURCE_TEXT_MAX_BYTES } = options;
  if (spec.kind === "git-index") {
    return readGitIndexSpec(spec, gitExecutable, maxSourceBytes);
  }

  if (spec.kind === "git-blob") {
    return readGitBlobSpec(spec, gitExecutable, maxSourceBytes);
  }

  return createFileSourceFetcher(
    { old: spec, new: { kind: "none" } },
    { maxSourceBytes },
  ).getFullText("old");
}

/** Build a Git-aware per-file source fetcher that caches each side's resolved text. */
export function createGitFileSourceFetcher(
  specs: GitResolvedSpecs,
  {
    gitExecutable = "git",
    maxSourceBytes = DEFAULT_SOURCE_TEXT_MAX_BYTES,
  }: Readonly<GitFileSourceFetcherOptions> = {},
): FileSourceFetcher {
  const cache = new Map<FileSourceSide, string | null>();

  return {
    async getFullText(side) {
      if (cache.has(side)) {
        return cache.get(side) ?? null;
      }

      const text = await readGitSpec(specs[side], { gitExecutable, maxSourceBytes });
      cache.set(side, text);
      return text;
    },
  };
}
