import { constants, lstatSync, watch } from "node:fs";
import { lstat, mkdtemp, open, opendir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { devNull, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import type {
  DirectoryReadResult,
  DocumentEntry,
  DocumentReadResult,
  DocumentSource,
} from "../../core/documents/source";

export const DOCUMENT_MAX_BYTES = 1024 * 1024;
export const DIRECTORY_MAX_ENTRIES = 10_000;

/** Prevent metadata inspection from fetching missing objects or launching transport helpers. */
function gitQueryEnvironment() {
  return { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" };
}

/** Run optional Git metadata queries without blocking the renderer or executing repository hooks. */
function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      "git",
      [
        "--no-pager",
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${devNull}`,
        ...args,
      ],
      {
        cwd,
        signal,
        encoding: "utf8",
        timeout: 1500,
        maxBuffer: 2 * 1024 * 1024,
        env: gitQueryEnvironment(),
      },
      (error, output) =>
        done(error && !(error.code === 1 && args.includes("--get-regexp")) ? null : output),
    );
  });
}

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

/** Open a bounded filesystem collection; directory expansion never scans descendants. */
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
        const buffer = Buffer.alloc(DOCUMENT_MAX_BYTES + 1);
        let count = 0;
        while (count < buffer.length) {
          signal?.throwIfAborted();
          const result = await handle.read(buffer, count, buffer.length - count, count);
          if (!result.bytesRead) break;
          count += result.bytesRead;
        }
        signal?.throwIfAborted();
        if (count > DOCUMENT_MAX_BYTES)
          return {
            kind: "unavailable",
            reason: "too-large",
            detail: "File exceeds the 1 MiB viewing limit.",
          };
        const bytes = buffer.subarray(0, count);
        if (bytes.includes(0))
          return {
            kind: "unavailable",
            reason: "binary",
            detail: "Binary file — no text preview.",
          };
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return {
            kind: "unavailable",
            reason: "binary",
            detail: "Non-UTF-8 file — no text preview.",
          };
        }
        return { kind: "text", text, identity: createHash("sha256").update(bytes).digest("hex") };
      } finally {
        await handle.close();
      }
    } catch (error) {
      signal?.throwIfAborted();
      return unavailable(error);
    }
  }

  /** List one directory and attach optional Git visibility/status metadata for its immediate children. */
  async function list(key: string, signal?: AbortSignal): Promise<DirectoryReadResult> {
    signal?.throwIfAborted();
    try {
      await safePath(key);
      const info = await lstat(key);
      if (!info.isDirectory() || info.isSymbolicLink())
        return {
          kind: "unavailable",
          detail: "This directory is unavailable; symlinks are not followed.",
        };
      const entries: DocumentEntry[] = [];
      // Linux exposes a handle-bound directory path. Other platforms validate the path again
      // before publishing; portable Node APIs cannot bind opendir to a directory descriptor.
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
        for await (const child of await openDirectory(
          handle ? `/proc/self/fd/${handle.fd}` : key,
        )) {
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
      } finally {
        await handle?.close();
      }
      const repository = (await git(key, ["rev-parse", "--show-toplevel"], signal))?.trim();
      if (repository && entries.length) {
        const paths = entries.map((entry) => entry.key);
        // Git supplies its own ignore semantics, including tracked files, nested rules and global excludes.
        signal?.throwIfAborted();
        const process = spawn(
          [
            "git",
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            `core.hooksPath=${devNull}`,
            "check-ignore",
            "-z",
            "--stdin",
          ],
          {
            cwd: key,
            env: gitQueryEnvironment(),
            stdin: Buffer.from(paths.join("\0") + "\0"),
            stdout: "pipe",
            stderr: "ignore",
          },
        );
        let interrupted = false;
        const abort = () => {
          interrupted = true;
          process.kill();
        };
        signal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(abort, 1500);
        let ignored: Set<string>;
        try {
          const output = await new Response(process.stdout).text();
          const exitCode = await process.exited;
          signal?.throwIfAborted();
          if (interrupted || (exitCode !== 0 && exitCode !== 1))
            return {
              kind: "unavailable",
              detail: "Git ignore query did not complete; refresh to retry.",
            };
          ignored = new Set(
            output
              .split("\0")
              .filter(Boolean)
              .map((path) => resolve(path)),
          );
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
        }
        // Status can otherwise invoke repository-configured clean/process filters. Browsing never
        // grants that execution authority; disable every declared filter before querying metadata.
        const filterKeys = await git(
          repository,
          [
            "config",
            "--null",
            "--name-only",
            "--get-regexp",
            "^filter\\..*\\.(clean|process|required)$",
          ],
          signal,
        );
        const names = filterKeys?.split("\0").filter(Boolean) ?? [];
        const safeFilterConfig =
          filterKeys !== null &&
          names.every((name) => /^filter\.[^=\r\n]*\.(clean|process|required)$/.test(name));
        const filterOverrides = names.flatMap((name) => [
          "-c",
          `${name}=${name.endsWith(".required") ? "false" : ""}`,
        ]);
        const status = safeFilterConfig
          ? await git(
              repository,
              [
                ...filterOverrides,
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=normal",
                "--ignore-submodules=all",
                "--",
                key,
              ],
              signal,
            )
          : null;
        const markers = new Map<string, string>();
        const records = status?.split("\0") ?? [];
        for (let index = 0; index < records.length; index++) {
          const record = records[index]!;
          if (record.length < 4) continue;
          const code = record.slice(0, 2);
          const changed = resolve(repository, record.slice(3));
          const child = relative(key, changed).split(sep)[0];
          if (child && child !== "..")
            markers.set(join(key, child), code === "??" ? "?" : code.trim().slice(0, 1));
          if (code.includes("R") || code.includes("C")) index++;
        }
        for (const entry of entries) {
          entry.ignored = ignored.has(entry.key);
          entry.status = markers.get(entry.key);
        }
      }
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
    async edit(key, launch) {
      let temporary: string | undefined;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let keepCopy = false;
      try {
        await safePath(key);
        const info = await lstat(key);
        if (!info.isFile() || info.isSymbolicLink() || info.size > DOCUMENT_MAX_BYTES)
          return "No editable regular text file selected.";
        handle = await openCheckedPath(
          key,
          constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
          throw new Error("Document changed during opening.");
        await safePath(key);
        const original = await read(key);
        if (original.kind !== "text") return original.detail;
        // Editors may replace their target atomically or defer opening it. Give them a private
        // copy, never the checked collection path; write back through the retained file handle.
        temporary = await mkdtemp(join(tmpdir(), "hunk-edit-"));
        const copy = join(temporary, basename(key));
        const snapshot = Buffer.alloc(DOCUMENT_MAX_BYTES + 1);
        let snapshotSize = 0;
        while (snapshotSize < snapshot.length) {
          const result = await handle.read(
            snapshot,
            snapshotSize,
            snapshot.length - snapshotSize,
            snapshotSize,
          );
          if (!result.bytesRead) break;
          snapshotSize += result.bytesRead;
        }
        const originalBytes = snapshot.subarray(0, snapshotSize);
        if (createHash("sha256").update(originalBytes).digest("hex") !== original.identity)
          throw new Error("Document changed while preparing editor copy.");
        await writeFile(copy, originalBytes, { mode: 0o600 });
        keepCopy = true;
        const failure = await launch(copy);
        if (failure) throw new Error(failure);
        const edited = await open(
          copy,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        let bytes: Buffer;
        try {
          if (!(await edited.stat()).isFile())
            throw new Error("Editor output is not a regular file.");
          bytes = Buffer.alloc(DOCUMENT_MAX_BYTES + 1);
          let count = 0;
          while (count < bytes.length) {
            const result = await edited.read(bytes, count, bytes.length - count, count);
            if (!result.bytesRead) break;
            count += result.bytesRead;
          }
          bytes = bytes.subarray(0, count);
          if (count > DOCUMENT_MAX_BYTES || bytes.includes(0))
            throw new Error("Editor output exceeds the text viewing policy.");
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } finally {
          await edited.close();
        }
        const current = await read(key);
        const currentInfo = await lstat(key);
        if (
          current.kind !== "text" ||
          current.identity !== original.identity ||
          currentInfo.isSymbolicLink() ||
          currentInfo.dev !== opened.dev ||
          currentInfo.ino !== opened.ino
        )
          throw new Error("Document changed while editing; original was not overwritten.");
        if (createHash("sha256").update(bytes).digest("hex") === original.identity) {
          keepCopy = false;
          return null;
        }
        // Never reopen the collection path for writing after the editor returns.
        let count = 0;
        while (count < bytes.length) {
          const result = await handle.write(bytes, count, bytes.length - count, count);
          if (!result.bytesWritten) throw new Error("Cannot save editor output.");
          count += result.bytesWritten;
        }
        await handle.truncate(bytes.length);
        keepCopy = false;
        return null;
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Cannot edit this entry.";
        return keepCopy ? `${detail} Editor copy retained in ${temporary}.` : detail;
      } finally {
        await handle?.close();
        if (temporary && !keepCopy) await rm(temporary, { recursive: true, force: true });
      }
    },
    observe(keys, onChange) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const changed = () => {
        clearTimeout(timer);
        timer = setTimeout(onChange, 100);
      };
      const watchers: ReturnType<typeof watch>[] = [];
      // Directory watches cover their immediate children. File and symlink watches use only the
      // parent, preserving atomic replacements without ever observing a symlink target.
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
