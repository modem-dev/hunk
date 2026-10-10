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
    saveClaimDirectory,
  }: {
    openDirectory?: typeof opendir;
    spawn?: typeof Bun.spawn;
    saveClaimDirectory?: string;
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

  let editing = false;
  let pendingObservationChange = false;

  return {
    root,
    read,
    list,
    async edit(key, launch) {
      if (editing) return "An editor is already open.";
      editing = true;

      try {
        return await editDocumentCopy(key, launch, {
          safePath,
          openCheckedPath,
          read,
          saveClaimDirectory,
        });
      } finally {
        editing = false;
      }
    },

    observe(keys, onChange) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const changed = () => {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          if (stopped) return;
          // A self-rename can arrive while the path is absent, before its replacement is visible.
          // Reconcile again before delivery so later edits use live handles even if the runtime
          // coalesces the corresponding parent event or cannot report a distinct file ID.
          reconcile();
          pendingRearms.clear();
          onChange();
        }, 100);
      };

      type DirectoryWatch = {
        watcher: ReturnType<typeof watch>;
        dev: bigint;
        ino: bigint;
      };
      const watchers = new Map<string, DirectoryWatch>();
      const pendingRearms = new Set<string>();
      // Keep missing directory candidates so parent events can restore them without new demand.
      // Files and final symlinks never acquire a target watch; their parents observe replacement.
      const targets = new Set(keys.flatMap((key) => [dirname(key), key]));

      /** Match native parent/self events even when the runtime cannot supply a filename or ID. */
      function eventRearmsTarget(target: string, origin?: string, filename?: string | null) {
        const matchesName = filename == null || filename === basename(target);
        return matchesName && (target === origin || dirname(target) === origin);
      }

      /** Repair directory handles after parent/self rename or error without replacing debounce. */
      function reconcile(origin?: string, filename?: string | null) {
        if (stopped) return;

        for (const target of targets) {
          const previous = watchers.get(target);
          const nativeRearm = eventRearmsTarget(target, origin, filename);
          if (nativeRearm) pendingRearms.add(target);
          const rearm = nativeRearm || (origin === undefined && pendingRearms.has(target));
          let info;
          try {
            // BigInt avoids rounding Windows file IDs; relevant native events also force rearm
            // when IDs are unavailable or unchanged, rather than relying on identity alone.
            info = lstatSync(target, { bigint: true });
          } catch {
            /* Missing targets retain their parent anchors. */
          }
          if (!info?.isDirectory() || info.isSymbolicLink()) {
            watchers.delete(target);
            previous?.watcher.close();
            continue;
          }

          if (previous && previous.dev === info.dev && previous.ino === info.ino && !rearm)
            continue;

          // Keep parent anchors and the received-event timer armed while synchronously reopening
          // this target. Bun shares same-path native handles: opening before closing the old watch
          // would retain its inode and closing it would also disable the replacement.
          watchers.delete(target);
          previous?.watcher.close();
          try {
            const watcher = watch(target, (event, name) => {
              // A closed/replaced handle may still have native callbacks queued for its old inode.
              if (stopped || watchers.get(target) !== current) return;
              changed();
              if (event === "rename") reconcile(target, name);
            });
            const current: DirectoryWatch = { watcher, dev: info.dev, ino: info.ino };
            watcher.on("error", () => {
              if (stopped || watchers.get(target) !== current) return;
              changed();
              reconcile(target, null);
            });
            watchers.set(target, current);
          } catch {
            /* A surviving parent can retry a concurrently deleted or unavailable target. */
          }
        }
      }

      reconcile();

      if (pendingObservationChange) {
        pendingObservationChange = false;
        changed();
      }

      return () => {
        if (stopped) return;
        stopped = true;
        if (timer !== undefined) {
          // Transfer only an actual unconsumed event to a synchronous demand handover. Final
          // close cancels delivery; a later observer must not inherit a revoked session's event.
          pendingObservationChange = true;
          queueMicrotask(() => {
            pendingObservationChange = false;
          });
        }
        clearTimeout(timer);
        timer = undefined;
        for (const { watcher } of watchers.values()) watcher.close();
        watchers.clear();
      };
    },
  };
}
