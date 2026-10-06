import { execFile } from "node:child_process";
import { devNull } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { DocumentEntry } from "../../core/documents/source";

/** Prevent metadata inspection from fetching objects or launching transport helpers. */
function gitQueryEnvironment() {
  return { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" };
}

/** Run optional metadata queries with bounded output and repository hooks disabled. */
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

/** Accept Git ignore results only after normal completion; interruption never grants visibility. */
async function readIgnoredPaths(
  key: string,
  entries: readonly DocumentEntry[],
  spawn: typeof Bun.spawn,
  signal?: AbortSignal,
) {
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
      stdin: Buffer.from(entries.map((entry) => entry.key).join("\0") + "\0"),
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
  try {
    const output = await new Response(process.stdout).text();
    const exitCode = await process.exited;
    signal?.throwIfAborted();
    if (interrupted || (exitCode !== 0 && exitCode !== 1)) return null;
    return new Set(
      output
        .split("\0")
        .filter(Boolean)
        .map((path) => resolve(path)),
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

/** Disable declared filters before querying status; malformed or failed config queries omit status. */
async function readStatus(repository: string, key: string, signal?: AbortSignal) {
  const filterKeys = await git(
    repository,
    ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"],
    signal,
  );
  const names = filterKeys?.split("\0").filter(Boolean) ?? [];
  if (
    filterKeys === null ||
    !names.every((name) => /^filter\.[^=\r\n]*\.(clean|process|required)$/.test(name))
  )
    return null;
  const overrides = names.flatMap((name) => [
    "-c",
    `${name}=${name.endsWith(".required") ? "false" : ""}`,
  ]);
  return git(
    repository,
    [
      ...overrides,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
      "--ignore-submodules=all",
      "--",
      key,
    ],
    signal,
  );
}

/** Map NUL-delimited Git status records to immediate children, skipping rename-source records. */
export function directoryStatusMarkers(repository: string, key: string, status: string | null) {
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
  return markers;
}

/** Attach optional status and complete ignore metadata to an already bounded directory listing. */
export async function applyDirectoryGitMetadata(
  key: string,
  entries: DocumentEntry[],
  spawn: typeof Bun.spawn,
  signal?: AbortSignal,
) {
  const repository = (await git(key, ["rev-parse", "--show-toplevel"], signal))?.trim();
  if (!repository || !entries.length) return null;
  const ignored = await readIgnoredPaths(key, entries, spawn, signal);
  if (ignored === null)
    return {
      kind: "unavailable" as const,
      detail: "Git ignore query did not complete; refresh to retry.",
    };
  const markers = directoryStatusMarkers(
    repository,
    key,
    await readStatus(repository, key, signal),
  );
  for (const entry of entries) {
    entry.ignored = ignored.has(entry.key);
    entry.status = markers.get(entry.key);
  }
  return null;
}
