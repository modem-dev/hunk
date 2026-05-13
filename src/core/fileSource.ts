/**
 * Resolve full file contents for one diff file across input modes.
 *
 * Each `DiffFile` may carry a `FileSourceFetcher` that knows how to read the
 * file's "old" and "new" sides without re-running the original diff. Returns
 * `null` when source content is unreachable.
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

async function readFsSpec(spec: Extract<FileSourceSpec, { kind: "fs" }>): Promise<string | null> {
  try {
    const file = Bun.file(spec.absolutePath);
    if (!(await file.exists())) {
      return null;
    }

    return await file.text();
  } catch (error) {
    logSourceDiagnostic(`failed to read source file ${spec.absolutePath}`, error);
    return null;
  }
}

function readGitBlobSpec(
  spec: Extract<FileSourceSpec, { kind: "git-blob" }>,
  gitExecutable = "git",
): string | null {
  return readGitObjectSpec(spec.repoRoot, `${spec.ref}:${spec.path}`, gitExecutable);
}

function readGitIndexSpec(
  spec: Extract<FileSourceSpec, { kind: "git-index" }>,
  gitExecutable = "git",
): string | null {
  return readGitObjectSpec(spec.repoRoot, `:${spec.path}`, gitExecutable);
}

/** Read a blob-like Git object spec such as `HEAD:path` or `:path`. */
function readGitObjectSpec(
  repoRoot: string,
  objectName: string,
  gitExecutable = "git",
): string | null {
  let proc: ReturnType<typeof Bun.spawnSync>;

  try {
    proc = Bun.spawnSync([gitExecutable, "show", objectName], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    logSourceDiagnostic(`failed to run Git while reading source ${objectName}`, error);
    return null;
  }

  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr ?? []).toString("utf8");
    if (!isExpectedMissingGitSource(stderr)) {
      logSourceDiagnostic(`failed to read Git source ${objectName} in ${repoRoot}`, stderr);
    }
    return null;
  }

  return Buffer.from(proc.stdout ?? []).toString("utf8");
}

async function readSpec(spec: FileSourceSpec): Promise<string | null> {
  if (spec.kind === "none") {
    return null;
  }

  if (spec.kind === "fs") {
    return readFsSpec(spec);
  }

  if (spec.kind === "git-index") {
    return readGitIndexSpec(spec);
  }

  return readGitBlobSpec(spec);
}

/** Build a per-file source fetcher that caches each side's resolved text. */
export function createFileSourceFetcher(specs: ResolvedSpecs): FileSourceFetcher {
  const cache = new Map<FileSourceSide, string | null>();

  return {
    async getFullText(side) {
      if (cache.has(side)) {
        return cache.get(side) ?? null;
      }

      const text = await readSpec(specs[side]);
      cache.set(side, text);
      return text;
    },
  };
}
