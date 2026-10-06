import { constants, lstatSync, watch } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { devNull } from "node:os";
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
export async function createFilesystemSource(inputPath: string): Promise<DocumentSource> {
  const input = resolve(inputPath);
  const initial = await lstat(input);
  // Canonicalize the parent, not the final entry: explicitly opened symlinks retain their placeholder.
  const path =
    initial.isDirectory() && !initial.isSymbolicLink()
      ? await realpath(input)
      : join(await realpath(dirname(input)), basename(input));
  const base = initial.isDirectory() && !initial.isSymbolicLink() ? path : dirname(path);
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
    if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink())
      throw new Error("Collection root changed.");
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Symlink traversal is unavailable.");
    }
    if ((await realpath(dirname(key))) !== dirname(key))
      throw new Error("Collection ancestry changed.");
    return key;
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
      const handle = await open(
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
      for await (const child of await opendir(key)) {
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
      const repository = (await git(key, ["rev-parse", "--show-toplevel"], signal))?.trim();
      if (repository && entries.length) {
        const paths = entries.map((entry) => entry.key);
        // Git supplies its own ignore semantics, including tracked files, nested rules and global excludes.
        signal?.throwIfAborted();
        const process = Bun.spawn(
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
        const abort = () => process.kill();
        signal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(abort, 1500);
        let ignored: Set<string>;
        try {
          ignored = new Set((await new Response(process.stdout).text()).split("\0"));
          await process.exited;
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
    async editablePath(key) {
      try {
        await safePath(key);
        return entryKind(await lstat(key)) === "file" ? key : null;
      } catch {
        return null;
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
