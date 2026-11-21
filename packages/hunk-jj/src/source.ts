import type {
  ExtensionVcsFileBytesResult,
  ExtensionVcsFileSourceResult,
  ExtensionVcsFileSourceTooLarge,
} from "hunkdiff/extension";
import {
  DEFAULT_SOURCE_BYTES_MAX_BYTES,
  DEFAULT_SOURCE_TEXT_MAX_BYTES,
  logSourceDiagnostic,
  readStreamBytesWithLimit,
  readStreamTextWithLimit,
  terminateSourceSubprocess,
} from "@hunk/vcs/source";

/** Stops a Jujutsu source read as soon as it crosses Hunk's byte limit. */
class JjSourceTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Source text exceeds ${maxBytes} bytes.`);
    this.name = "JjSourceTooLargeError";
  }
}

/** Names one file in an already-resolved Jujutsu commit. */
export interface JjFileSourceSpec {
  repoRoot: string;
  commitId: string;
  path: string;
}

export interface JjFileSourceOptions {
  jjExecutable?: string;
  maxSourceBytes?: number;
}

export interface JjFileBytesOptions {
  jjExecutable?: string;
  maxBytes?: number;
}

/** Return whether Jujutsu reported that the requested path has no source at this revision. */
function isExpectedMissingJjSource(stderr: string) {
  const normalized = stderr.toLowerCase();
  return ["no such path:", "path does not exist:", "path doesn't exist:"].some((fragment) =>
    normalized.includes(fragment),
  );
}

/** Tell Hunk that expansion is unavailable because the source exceeded its byte limit. */
function tooLarge(maxBytes: number): ExtensionVcsFileSourceTooLarge {
  return { kind: "too-large", maxBytes };
}

/** Encode a repo-relative path as one alias-insensitive literal Jujutsu fileset. */
function jjFilePathFileset(path: string) {
  const literalPath = Array.from(path, (character) => {
    switch (character) {
      case "*":
        return "[*]";
      case "?":
        return "[?]";
      case "[":
        return "[[]";
      case "]":
        return "[]]";
      case "{":
        return "[{]";
      case "}":
        return "[}]";
      case "\\":
        return process.platform === "win32" ? "/" : "[\\\\]";
      default:
        return character;
    }
  }).join("");
  return JSON.stringify(literalPath);
}

/**
 * Read one complete file from the commit that produced the patch under review.
 *
 * Hunk calls this lazily when it needs lines that `jj diff` left out of the patch. The
 * caller has already resolved a moving name such as `@` to a full commit ID. Passing
 * that ID to `-r` fixes which commit supplies the file, while `--ignore-working-copy`
 * separately prevents this later read from snapshotting unrelated workspace changes.
 *
 * The process runs at the repository root, and the path is escaped and encoded as a
 * bare quoted fileset passed as one command argument. Avoiding a named fileset pattern
 * prevents a user alias from broadening the selection. An explicit empty metadata
 * template also prevents `templates.file_show` from injecting bytes into the file contents.
 *
 * Standard output is streamed only up to `maxSourceBytes`. Crossing that limit stops JJ
 * and returns Hunk's explicit `too-large` result instead of holding an unexpectedly
 * large file in memory.
 */
export async function readJjFileSource(
  spec: JjFileSourceSpec,
  {
    jjExecutable = "jj",
    maxSourceBytes = DEFAULT_SOURCE_TEXT_MAX_BYTES,
  }: Readonly<JjFileSourceOptions> = {},
): Promise<ExtensionVcsFileSourceResult> {
  const result = await readJjFileBytes(spec, { jjExecutable, maxBytes: maxSourceBytes });
  return result instanceof Uint8Array ? new TextDecoder().decode(result) : result;
}

/**
 * Read one file's exact bytes from the commit that produced the patch under review.
 *
 * `readJjFileSource` is this read decoded as text; a byte consumer such as an image preview
 * calls it directly, including for binary files. Commit pinning, fileset escaping, and the byte
 * limit work exactly as described there.
 */
export async function readJjFileBytes(
  spec: JjFileSourceSpec,
  {
    jjExecutable = "jj",
    maxBytes = DEFAULT_SOURCE_BYTES_MAX_BYTES,
  }: Readonly<JjFileBytesOptions> = {},
): Promise<ExtensionVcsFileBytesResult> {
  let proc: Bun.ReadableSubprocess;
  const command = [
    jjExecutable,
    "--no-pager",
    "--color",
    "never",
    "file",
    "show",
    "--ignore-working-copy",
    "-r",
    spec.commitId,
    "-T",
    '""',
    "--",
    jjFilePathFileset(spec.path),
  ];

  try {
    proc = Bun.spawn(command, {
      cwd: spec.repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    logSourceDiagnostic(
      `failed to run Jujutsu while reading source ${spec.commitId}:${spec.path} in ${spec.repoRoot}`,
      error,
    );
    return null;
  }

  let output: [number, Uint8Array, string];
  try {
    output = await Promise.all([
      proc.exited,
      readStreamBytesWithLimit(
        proc.stdout,
        maxBytes,
        () => proc.kill(),
        (limit) => new JjSourceTooLargeError(limit),
      ),
      readStreamTextWithLimit(
        proc.stderr,
        64 * 1024,
        undefined,
        (limit) => new Error(`Jujutsu source diagnostics exceeded ${limit} bytes.`),
      ),
    ]);
  } catch (error) {
    await terminateSourceSubprocess(proc);
    if (error instanceof JjSourceTooLargeError) {
      return tooLarge(error.maxBytes);
    }

    logSourceDiagnostic(
      `failed to collect Jujutsu source ${spec.commitId}:${spec.path} in ${spec.repoRoot}`,
      error,
    );
    return null;
  }

  const [exitCode, stdout, stderr] = output;
  if (exitCode !== 0) {
    if (!isExpectedMissingJjSource(stderr)) {
      logSourceDiagnostic(
        `failed to read Jujutsu source ${spec.commitId}:${spec.path} in ${spec.repoRoot}`,
        stderr,
      );
    }
    return null;
  }

  return stdout;
}
