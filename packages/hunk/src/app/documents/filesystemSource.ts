import { constants, lstatSync, watch } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  DirectoryReadResult,
  DocumentEntry,
  DocumentReadResult,
  DocumentSource,
} from "../../core/documents/source";
import { DOCUMENT_MAX_BYTES, decodeDocumentBytes, readBoundedDocumentBytes } from "./documentBytes";
import { editDocumentCopy } from "./editDocument";
import { applyDirectoryGitMetadata } from "./gitMetadata";

export { DOCUMENT_MAX_BYTES } from "./documentBytes";
export const DIRECTORY_MAX_ENTRIES = 10_000;

/** Classify entries without following symlinks or opening devices. */
function entryKind(info: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): DocumentEntry["kind"] {
  return info.isSymbolicLink()
    ? "symlink"
    : info.isDirectory()
      ? "directory"
      : info.isFile()
        ? "file"
        : "special";
}

/** Translate filesystem failures into document availability rather than fatal browser errors. */
function unavailable(error: unknown): DocumentReadResult & { kind: "unavailable" } {
  const code = (error as NodeJS.ErrnoException).code;
  return {
    kind: "unavailable",
    reason: code === "ENOENT" ? "missing" : "unreadable",
    detail: code === "ENOENT" ? "File no longer exists." : "Cannot read this entry.",
  };
}

/** Open a bounded filesystem collection for selection, expansion, editing and watch refreshes.
 * Own path confinement and retained-handle opens; byte policies, editor copies and optional Git
 * metadata live in focused neighbors. Directory expansion never scans descendants.
 */
export async function createFilesystemSource(
  inputPath: string,
  {
    openDirectory = opendir,
    spawn = Bun.spawn,
  }: {
    openDirectory?: typeof opendir;
    spawn?: typeof Bun.spawn;
  } = {},
): Promise<DocumentSource> {
  const input = resolve(inputPath);
  const initial = await lstat(input);

  // Canonicalize the parent, not the final entry: explicitly opened symlinks retain their placeholder.
  const path =
    initial.isDirectory() && !initial.isSymbolicLink()
      ? await realpath(input)
      : join(await realpath(dirname(input)), basename(input));
  const base = initial.isDirectory() && !initial.isSymbolicLink() ? path : dirname(path);
  const baseIdentity = await lstat(base);
  const root: DocumentEntry = {
    key: path,
    name: basename(path) || path,
    displayPath: path,
    kind: entryKind(initial),
    hidden: basename(path).startsWith("."),
  };

  /** Refuse root escapes and symlinked ancestors before any collection read. */
  async function safePath(key: string) {
    const rel = relative(base, key);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
      throw new Error("Path escapes document collection.");
    if (root.kind !== "directory" && key !== root.key) throw new Error("Unknown document.");

    const segments = rel.split(sep).filter(Boolean);
    let parent = base;
    const baseInfo = await lstat(base);
    if (
      !baseInfo.isDirectory() ||
      baseInfo.isSymbolicLink() ||
      baseInfo.dev !== baseIdentity.dev ||
      baseInfo.ino !== baseIdentity.ino
    )
      throw new Error("Collection root changed.");

    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Symlink traversal is unavailable.");
    }

    if (relative(dirname(key), await realpath(dirname(key))) !== "")
      throw new Error("Collection ancestry changed.");
    return key;
  }

  /** Bind Linux opens to the collection handle and walk ancestors without following links. */
  async function openCheckedPath(key: string, flags: number) {
    await safePath(key);
    if (process.platform !== "linux") return open(key, flags);

    let parent = await open(
      base,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let transferred = false;

    try {
      const opened = await parent.stat();
      if (opened.dev !== baseIdentity.dev || opened.ino !== baseIdentity.ino)
        throw new Error("Collection root changed during opening.");

      const segments = relative(base, key).split(sep).filter(Boolean);
      for (const segment of segments.slice(0, -1)) {
        const child = await open(
          `/proc/self/fd/${parent.fd}/${segment}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        await parent.close();
        parent = child;
      }

      if (!segments.length) {
        transferred = true;
        return parent;
      }

      return await open(
        `/proc/self/fd/${parent.fd}/${segments.at(-1)}`,
        flags | constants.O_NOFOLLOW,
      );
    } finally {
      if (!transferred) await parent.close();
    }
  }

  /** Read one regular file through a bounded handle, including files that grow during reading. */
  async function read(key: string, signal?: AbortSignal): Promise<DocumentReadResult> {
    signal?.throwIfAborted();
    try {
      await safePath(key);
      const info = await lstat(key);
      const kind = entryKind(info);
      if (kind !== "file")
        return {
          kind: "unavailable",
          reason: kind === "symlink" ? "symlink" : "special",
          detail:
            kind === "symlink" ? "Symlinks are not followed." : "This entry is not a regular file.",
        };
      if (info.size > DOCUMENT_MAX_BYTES)
        return {
          kind: "unavailable",
          reason: "too-large",
          detail: "File exceeds the 1 MiB viewing limit.",
        };

      const handle = await openCheckedPath(
        key,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const openedInfo = await handle.stat();
        if (openedInfo.dev !== info.dev || openedInfo.ino !== info.ino)
          throw new Error("Document changed during opening.");
        await safePath(key);
        if (!openedInfo.isFile())
          return {
            kind: "unavailable",
            reason: "special",
            detail: "This entry is not a regular file.",
          };
        return decodeDocumentBytes(await readBoundedDocumentBytes(handle, signal));
      } finally {
        await handle.close();
      }
    } catch (error) {
      signal?.throwIfAborted();
      return unavailable(error);
    }
  }

  /** Enumerate a checked directory without releasing its Linux handle before validation finishes. */
  async function enumerate(key: string, signal?: AbortSignal): Promise<DirectoryReadResult> {
    await safePath(key);
    const info = await lstat(key);
    if (!info.isDirectory() || info.isSymbolicLink())
      return {
        kind: "unavailable",
        detail: "This directory is unavailable; symlinks are not followed.",
      };

    const entries: DocumentEntry[] = [];
    // Portable Node APIs cannot bind opendir to a directory descriptor on other platforms.
    const handle =
      process.platform === "linux"
        ? await openCheckedPath(
            key,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          )
        : null;
    try {
      if (handle) {
        const opened = await handle.stat();
        if (opened.dev !== info.dev || opened.ino !== info.ino)
          throw new Error("Directory changed during opening.");
      }
      await safePath(key);
      for await (const child of await openDirectory(handle ? `/proc/self/fd/${handle.fd}` : key)) {
        signal?.throwIfAborted();
        if (entries.length === DIRECTORY_MAX_ENTRIES)
          return {
            kind: "unavailable",
            detail: "Directory exceeds the 10,000-entry browsing limit.",
          };
        entries.push({
          key: join(key, child.name),
          name: child.name,
          displayPath: relative(base, join(key, child.name)),
          kind: entryKind(child),
          hidden: child.name.startsWith("."),
        });
      }

      await safePath(key);
      const current = await lstat(key);
      if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino)
        throw new Error("Directory changed during enumeration.");
      return { kind: "entries", entries };
    } finally {
      await handle?.close();
    }
  }

  /** List one bounded directory and attach optional metadata before publishing sorted children. */
  async function list(key: string, signal?: AbortSignal): Promise<DirectoryReadResult> {
    signal?.throwIfAborted();
    try {
      const result = await enumerate(key, signal);
      if (result.kind !== "entries") return result;

      const entries = [...result.entries];
      const failure = await applyDirectoryGitMetadata(key, entries, spawn, signal);
      if (failure) return failure;

      signal?.throwIfAborted();
      entries.sort(
        (a, b) =>
          Number(b.kind === "directory") - Number(a.kind === "directory") ||
          a.name.localeCompare(b.name),
      );
      return { kind: "entries", entries };
    } catch (error) {
      signal?.throwIfAborted();
      return { kind: "unavailable", detail: unavailable(error).detail };
    }
  }

  return {
    root,
    read,
    list,
    edit: (key, launch) => editDocumentCopy(key, launch, { safePath, openCheckedPath, read }),

    observe(keys, onChange) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const changed = () => {
        clearTimeout(timer);
        timer = setTimeout(onChange, 100);
      };

      const watchers: ReturnType<typeof watch>[] = [];
      // Parent watches preserve atomic replacement observation without following file symlinks.
      const targets = new Set<string>();
      for (const key of keys) {
        targets.add(dirname(key));
        try {
          const info = lstatSync(key);
          if (info.isDirectory() && !info.isSymbolicLink()) targets.add(key);
        } catch {
          /* Missing entries retain parent observation. */
        }
      }

      for (const target of targets) {
        try {
          const watcher = watch(target, changed);
          watcher.on("error", changed);
          watchers.push(watcher);
        } catch {
          /* Deleted entries retain their parent's observation. */
        }
      }

      return () => {
        clearTimeout(timer);
        for (const watcher of watchers) watcher.close();
      };
    },
  };
}
