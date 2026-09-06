import { join } from "node:path";
import type {
  ExtensionVcsFileSourceResult,
  ExtensionVcsFileSourceTooLarge,
} from "hunkdiff/extension";
import {
  DEFAULT_SOURCE_TEXT_MAX_BYTES,
  logSourceDiagnostic,
  readFileTextWithLimit,
  readStreamTextWithLimit,
  terminateSourceSubprocess,
} from "../../../../lib/sourceText";
import type { GitDiffEndpoint } from "./commands";

/** A provider-local signal converted to the public structural result at this boundary. */
class GitSourceTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Source text exceeds ${maxBytes} bytes.`);
    this.name = "GitSourceTooLargeError";
  }
}

/** Source locations Git can resolve without consulting Hunk core internals. */
export type GitFileSourceSpec =
  | { kind: "none" }
  | { kind: "fs"; absolutePath: string }
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

/** Represent an exceeded resource limit through the public extension contract. */
function tooLarge(maxBytes: number): ExtensionVcsFileSourceTooLarge {
  return { kind: "too-large", maxBytes };
}

/** Read a blob-like Git object spec such as `HEAD:path` or `:path`. */
async function readGitObjectSpec(
  repoRoot: string,
  objectName: string,
  gitExecutable: string,
  maxSourceBytes: number,
): Promise<ExtensionVcsFileSourceResult> {
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
      readStreamTextWithLimit(
        proc.stdout,
        maxSourceBytes,
        () => proc.kill(),
        (limit) => new GitSourceTooLargeError(limit),
      ),
      readStreamTextWithLimit(
        proc.stderr,
        64 * 1024,
        undefined,
        (limit) => new Error(`Git source diagnostics exceeded ${limit} bytes.`),
      ),
    ]);
  } catch (error) {
    await terminateSourceSubprocess(proc);
    if (error instanceof GitSourceTooLargeError) {
      return tooLarge(error.maxBytes);
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

/** Read the full text one resolved Git source spec names. */
export function readGitFileSource(
  spec: GitFileSourceSpec,
  {
    gitExecutable = "git",
    maxSourceBytes = DEFAULT_SOURCE_TEXT_MAX_BYTES,
  }: Readonly<GitFileSourceOptions> = {},
): Promise<ExtensionVcsFileSourceResult> {
  switch (spec.kind) {
    case "none":
      return Promise.resolve(null);
    case "fs":
      return readFileTextWithLimit(spec.absolutePath, maxSourceBytes);
    case "git-index":
      return readGitObjectSpec(spec.repoRoot, `:${spec.path}`, gitExecutable, maxSourceBytes);
    case "git-blob":
      return readGitObjectSpec(
        spec.repoRoot,
        `${spec.ref}:${spec.path}`,
        gitExecutable,
        maxSourceBytes,
      );
  }
}
