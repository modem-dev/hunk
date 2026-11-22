import { constants, existsSync } from "node:fs";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/** Default byte ceiling for exact source text loaded for expanded context. */
export const DEFAULT_SOURCE_TEXT_MAX_BYTES = 1_000_000;

/**
 * Default byte ceiling for raw source bytes, such as an image a file view draws.
 *
 * Larger than the text ceiling because binary assets are routinely bigger than source files,
 * yet still bounded so one reviewed file cannot pull an arbitrary amount into memory.
 */
export const DEFAULT_SOURCE_BYTES_MAX_BYTES = 32 * 1024 * 1024;

/** Structural result shared by bounded filesystem source readers. */
export type LimitedSourceTextResult = string | null | { kind: "too-large"; maxBytes: number };

/** Structural result shared by bounded raw-byte source readers. */
export type LimitedSourceBytesResult = Uint8Array | null | { kind: "too-large"; maxBytes: number };

/** Keep source-load diagnostics terse enough to be useful in logs. */
export function logSourceDiagnostic(message: string, detail?: unknown) {
  if (detail instanceof Error) {
    console.error(`hunk: ${message}: ${detail.message}`, detail);
    return;
  }

  const firstLine =
    typeof detail === "string"
      ? detail
          .split("\n")
          .map((line) => line.trim())
          .find(Boolean)
      : undefined;
  console.error(firstLine ? `hunk: ${message}: ${firstLine}` : `hunk: ${message}`);
}

/** Read one filesystem source as text without exceeding the supplied byte ceiling. */
export async function readFileTextWithLimit(
  absolutePath: string,
  maxBytes: number,
): Promise<LimitedSourceTextResult> {
  try {
    const file = Bun.file(absolutePath);
    if (!(await file.exists())) {
      return null;
    }
    if (file.size > maxBytes) {
      return { kind: "too-large", maxBytes };
    }
    return await file.text();
  } catch (error) {
    logSourceDiagnostic(`failed to read source file ${absolutePath}`, error);
    return null;
  }
}

/** Read one filesystem source as raw bytes without exceeding the supplied byte ceiling. */
export async function readFileBytesWithLimit(
  absolutePath: string,
  maxBytes: number,
): Promise<LimitedSourceBytesResult> {
  try {
    const file = Bun.file(absolutePath);
    if (!(await file.exists())) {
      return null;
    }
    if (file.size > maxBytes) {
      return { kind: "too-large", maxBytes };
    }
    return await file.bytes();
  } catch (error) {
    logSourceDiagnostic(`failed to read source file ${absolutePath}`, error);
    return null;
  }
}

/** Read at most `maxBytes + 1` bytes from an open handle so growth past the ceiling is detected. */
async function readHandleBytesWithLimit(
  handle: FileHandle,
  maxBytes: number,
): Promise<LimitedSourceBytesResult> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const chunk = new Uint8Array(Math.min(64 * 1024, maxBytes + 1 - totalBytes));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) {
      break;
    }

    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      return { kind: "too-large", maxBytes };
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/** Return whether a filesystem failure means the entry is absent or not reachable as VCS content. */
function isUnreachableEntryError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // ELOOP: `O_NOFOLLOW` met a symlinked ancestor or a final component swapped for a link.
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

/** Opens files for the working-tree reader; tests substitute it to interleave path swaps. */
export type WorktreeOpen = (path: string, flags: number) => Promise<FileHandle>;

export interface WorktreeEntryReadOptions {
  openPath?: WorktreeOpen;
}

/**
 * Read the entry `entryPath` names without following it: link text for a symlink, bounded bytes
 * for a regular file, `null` for anything else or a file replaced between inspection and open.
 */
async function readEntryWithoutFollowing(
  entryPath: string,
  maxBytes: number,
  openPath: WorktreeOpen,
): Promise<LimitedSourceBytesResult> {
  const info = await lstat(entryPath);
  if (info.isSymbolicLink()) {
    const target = new Uint8Array(await readlink(entryPath, { encoding: "buffer" }));
    return target.byteLength > maxBytes ? { kind: "too-large", maxBytes } : target;
  }
  if (!info.isFile()) {
    return null;
  }
  if (info.size > maxBytes) {
    return { kind: "too-large", maxBytes };
  }

  const handle = await openPath(
    entryPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      logSourceDiagnostic(`source file ${entryPath} changed while it was being opened`);
      return null;
    }
    return await readHandleBytesWithLimit(handle, maxBytes);
  } finally {
    await handle.close();
  }
}

/**
 * Walk to the entry's directory through retained directory handles, then read the entry
 * relative to the last handle (Linux).
 *
 * Every ancestor opens with `O_NOFOLLOW` relative to its parent's handle through `/proc/self/fd`,
 * so replacing an ancestor with a symlink after it was opened cannot redirect the read.
 */
async function readBoundWorktreeEntry(
  repoRoot: string,
  segments: readonly string[],
  maxBytes: number,
  openPath: WorktreeOpen,
): Promise<LimitedSourceBytesResult> {
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY;
  // The repository root itself may sit beneath a symlink (macOS `/tmp`, a symlinked home), so
  // only entries the checkout contains are held to VCS semantics.
  let parent = await openPath(repoRoot, directoryFlags);

  try {
    for (const segment of segments.slice(0, -1)) {
      const child = await openPath(
        `/proc/self/fd/${parent.fd}/${segment}`,
        directoryFlags | constants.O_NOFOLLOW,
      );
      const previous = parent;
      parent = child;
      await previous.close();
    }

    return await readEntryWithoutFollowing(
      `/proc/self/fd/${parent.fd}/${segments.at(-1)}`,
      maxBytes,
      openPath,
    );
  } finally {
    await parent.close();
  }
}

/** Capture each ancestor directory's identity, or `null` when one is a symlink or not a directory. */
async function inspectWorktreeAncestors(repoRoot: string, segments: readonly string[]) {
  const identities: string[] = [];
  let ancestor = repoRoot;
  for (const segment of segments.slice(0, -1)) {
    ancestor = join(ancestor, segment);
    const info = await lstat(ancestor);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return null;
    }
    identities.push(`${info.dev}:${info.ino}`);
  }
  return identities.join("/");
}

/**
 * Read the entry by path between two ancestor checks (platforms without `/proc/self/fd`).
 *
 * An ancestor replaced by a symlink before the read and left in place fails the second check;
 * a swap restored between the read and that check is not detectable without handle-relative
 * opens, which these platforms do not expose to Node.
 */
async function readCheckedWorktreeEntry(
  repoRoot: string,
  segments: readonly string[],
  maxBytes: number,
  openPath: WorktreeOpen,
): Promise<LimitedSourceBytesResult> {
  const ancestors = await inspectWorktreeAncestors(repoRoot, segments);
  if (ancestors === null) {
    return null;
  }

  const result = await readEntryWithoutFollowing(join(repoRoot, ...segments), maxBytes, openPath);
  return (await inspectWorktreeAncestors(repoRoot, segments)) === ancestors ? result : null;
}

/** Whether directory handles can be reopened relative to themselves through procfs. */
let procFdAvailable: boolean | undefined;

/** Return whether this process can open paths relative to a retained directory handle. */
function canOpenRelativeToHandles() {
  procFdAvailable ??= process.platform === "linux" && existsSync("/proc/self/fd");
  return procFdAvailable;
}

/**
 * Read one working-tree entry's bytes the way a VCS records it, without following symlinks.
 *
 * A symlink's content is its link target text, as Git stores a mode-120000 blob, so the
 * served side agrees with the patch and a link can never expose a file outside the checkout.
 * Paths beneath a symlinked directory, paths outside the checkout, and special files (FIFOs,
 * sockets, devices) are not VCS content and resolve to `null`.
 *
 * On Linux the walk to the entry is bound to directory handles, so swapping any component for a
 * symlink during the read cannot redirect it. Elsewhere the ancestors are checked before and
 * after a path-based read. In both cases the final open does not follow a link and must match the
 * entry just inspected, so a file swapped for a symlink fails closed.
 */
export async function readWorktreeEntryBytesWithLimit(
  repoRoot: string,
  filePath: string,
  maxBytes: number,
  { openPath = open }: Readonly<WorktreeEntryReadOptions> = {},
): Promise<LimitedSourceBytesResult> {
  const absolutePath = join(repoRoot, filePath);
  const repoRelativePath = relative(repoRoot, absolutePath);
  const segments = repoRelativePath.split(sep).filter(Boolean);
  if (isAbsolute(repoRelativePath) || segments.length === 0 || segments[0] === "..") {
    return null;
  }

  try {
    return canOpenRelativeToHandles()
      ? await readBoundWorktreeEntry(repoRoot, segments, maxBytes, openPath)
      : await readCheckedWorktreeEntry(repoRoot, segments, maxBytes, openPath);
  } catch (error) {
    if (isUnreachableEntryError(error)) {
      return null;
    }
    logSourceDiagnostic(`failed to read source file ${absolutePath}`, error);
    return null;
  }
}

/** Read one working-tree entry as text with the same no-follow semantics as its byte read. */
export async function readWorktreeEntryTextWithLimit(
  repoRoot: string,
  filePath: string,
  maxBytes: number,
  options: Readonly<WorktreeEntryReadOptions> = {},
): Promise<LimitedSourceTextResult> {
  const result = await readWorktreeEntryBytesWithLimit(repoRoot, filePath, maxBytes, options);
  return result instanceof Uint8Array ? new TextDecoder().decode(result) : result;
}

const SOURCE_SUBPROCESS_GRACE_MS = 100;
const SOURCE_SUBPROCESS_FORCE_WAIT_MS = 250;

/** Wait a bounded interval for a source-reader subprocess to exit. */
function waitForSourceSubprocessExit(proc: Bun.ReadableSubprocess, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    void proc.exited.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

/** Terminate a source-reader subprocess without letting cleanup block indefinitely. */
export async function terminateSourceSubprocess(proc: Bun.ReadableSubprocess) {
  try {
    proc.kill("SIGTERM");
  } catch {
    // The process may have exited between the stream failure and cleanup.
  }
  if (await waitForSourceSubprocessExit(proc, SOURCE_SUBPROCESS_GRACE_MS)) {
    return;
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // A concurrent exit needs no further signal.
  }
  await waitForSourceSubprocessExit(proc, SOURCE_SUBPROCESS_FORCE_WAIT_MS);
}

/** Read a byte stream as text while enforcing a caller-defined resource limit. */
export async function readStreamTextWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onTooLarge?: () => void,
  createLimitError: (maxBytes: number) => Error = (limit) =>
    new Error(`Source text exceeds ${limit} bytes.`),
) {
  return new TextDecoder().decode(
    await readStreamBytesWithLimit(stream, maxBytes, onTooLarge, createLimitError),
  );
}

/** Read a byte stream whole while enforcing a caller-defined resource limit. */
export async function readStreamBytesWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onTooLarge?: () => void,
  createLimitError: (maxBytes: number) => Error = (limit) =>
    new Error(`Source bytes exceed ${limit} bytes.`),
): Promise<Uint8Array> {
  if (!stream) {
    return new Uint8Array();
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

  return combined;
}
