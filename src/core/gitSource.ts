import { join } from "node:path";
import {
  DEFAULT_SOURCE_TEXT_MAX_BYTES,
  SourceTextTooLargeError,
  logSourceDiagnostic,
  readFileSourceSpec,
  readStreamTextWithLimit,
  type FileSourceSpec,
} from "./fileSource";
import type { GitDiffEndpoint } from "./git";

/**
 * Reading a reviewed file's full contents out of Git.
 *
 * Git can name the exact bytes on each side of a diff — a blob at a commit, the
 * staged entry, the file on disk — which is what lets Hunk expand context and
 * highlight against the real file instead of against the patch. Everything here
 * answers one question: given a resolved source spec, what is that text?
 */

export type GitFileSourceSpec =
  | FileSourceSpec
  | { kind: "git-blob"; repoRoot: string; ref: string; path: string }
  | { kind: "git-index"; repoRoot: string; path: string };

export interface GitFileSourceOptions {
  gitExecutable?: string;
  maxSourceBytes?: number;
}

/** Convert one Git diff endpoint into the corresponding source lookup. */
export function gitEndpointSourceSpec(
  endpoint: GitDiffEndpoint,
  repoRoot: string,
  filePath: string,
): GitFileSourceSpec {
  switch (endpoint.kind) {
    case "none":
      return { kind: "none" };
    case "git-ref":
      return { kind: "git-blob", repoRoot, ref: endpoint.ref, path: filePath };
    case "index":
      return { kind: "git-index", repoRoot, path: filePath };
    case "worktree":
      return { kind: "fs", absolutePath: join(repoRoot, filePath) };
  }
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

/**
 * Read the full text one resolved Git source spec names.
 *
 * Resolves to `null` rather than rejecting whenever a side simply is not there
 * — the old side of an added file, a path the ref never contained — so callers
 * can treat "no source" as an ordinary answer. Only a source too large to read
 * safely rejects.
 */
export function readGitFileSource(
  spec: GitFileSourceSpec,
  {
    gitExecutable = "git",
    maxSourceBytes = DEFAULT_SOURCE_TEXT_MAX_BYTES,
  }: Readonly<GitFileSourceOptions> = {},
): Promise<string | null> {
  switch (spec.kind) {
    case "git-index":
      return readGitObjectSpec(spec.repoRoot, `:${spec.path}`, gitExecutable, maxSourceBytes);
    case "git-blob":
      return readGitObjectSpec(
        spec.repoRoot,
        `${spec.ref}:${spec.path}`,
        gitExecutable,
        maxSourceBytes,
      );
    default:
      return readFileSourceSpec(spec, { maxSourceBytes });
  }
}
