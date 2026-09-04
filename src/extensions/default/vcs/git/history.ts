import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  HunkExtensionUserError,
  type ExtensionVcsHistoryCommit,
  type ExtensionVcsHistoryDecoration,
  type ExtensionVcsHistoryInput,
  type ExtensionVcsHistorySource,
} from "hunkdiff/extension";

const HISTORY_FIELDS_PER_COMMIT = 8;
const FULL_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ABBREVIATED_OBJECT_ID_PATTERN = /^[0-9a-f]{4,64}$/;
const MAX_SYNC_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DECORATION_REFS = 10_000;
const MAX_HISTORY_STDERR_BYTES = 16 * 1024;

interface GitHistoryOptions {
  cwd: string;
  gitExecutable?: string;
}

/** Run one shell-free bounded Git query and retain byte-exact NUL delimiters. */
function runGit(
  args: string[],
  { cwd, gitExecutable = "git" }: GitHistoryOptions,
  acceptedExitCodes: readonly number[] = [0],
) {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([gitExecutable, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      maxBuffer: MAX_SYNC_OUTPUT_BYTES,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch {
    throw new HunkExtensionUserError(`Could not run ${gitExecutable}.`, {
      suggestions: ["Install Git or configure Hunk to use another VCS backend."],
    });
  }

  if (!acceptedExitCodes.includes(result.exitCode)) {
    const message = result.stderr?.toString().trim().split("\n")[0];
    throw new HunkExtensionUserError(message || "Git could not read this repository.", {
      suggestions: ["Check the revision, filters, and repository, then try again."],
    });
  }
  return result.stdout?.toString() ?? "";
}

/** Resolve the repository root, including a bare repository with no worktree. */
function resolveHistoryRepoRoot(options: GitHistoryOptions) {
  const worktree = runGit(["rev-parse", "--show-toplevel"], options, [0, 128]).trim();
  if (worktree) return worktree;
  const gitDir = runGit(["rev-parse", "--absolute-git-dir"], options).trim();
  if (!gitDir) {
    throw new HunkExtensionUserError("Not inside a Git repository.", {
      suggestions: ["Run `hunk log` from a Git worktree or bare repository."],
    });
  }
  return gitDir;
}

/** Return whether a default HEAD traversal has no first commit yet. */
function hasHead(options: GitHistoryOptions) {
  return runGit(["rev-parse", "--verify", "--quiet", "HEAD"], options, [0, 1]).trim().length > 0;
}

/** Refuse a positional revision that Git could reinterpret as an option. */
function requireRevision(value: string) {
  if (!value || value.startsWith("-")) {
    throw new HunkExtensionUserError(`Refused history revision \`${value}\`.`, {
      suggestions: ["Pass a revision or range such as `HEAD`, `main`, or `main..feature`."],
    });
  }
  return value;
}

/** Snapshot ref labels separately so display punctuation is never parsed as structure. */
function readDecorations(options: GitHistoryOptions) {
  const byCommit = new Map<string, ExtensionVcsHistoryDecoration[]>();
  const add = (revisionId: string, decoration: ExtensionVcsHistoryDecoration) => {
    const entries = byCommit.get(revisionId) ?? [];
    entries.push(decoration);
    byCommit.set(revisionId, entries);
  };

  const raw = runGit(
    [
      "for-each-ref",
      `--count=${MAX_DECORATION_REFS + 1}`,
      "--format=%(objectname)%00%(objecttype)%00%(refname)%00%(*objectname)%00",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ],
    options,
  );
  const records = raw.split("\n").filter(Boolean);
  if (records.length > MAX_DECORATION_REFS) {
    throw new HunkExtensionUserError(
      `Git history has more than ${MAX_DECORATION_REFS.toLocaleString("en-US")} decorated refs.`,
      { suggestions: ["Reduce repository refs before running `hunk log`."] },
    );
  }
  for (const record of records) {
    const [objectId, objectType, refName, peeledId] = record.split("\0");
    if (!objectId || !objectType || !refName) continue;
    const revisionId = objectType === "tag" && peeledId ? peeledId : objectId;
    const decoration: ExtensionVcsHistoryDecoration = refName.startsWith("refs/heads/")
      ? { kind: "local-branch", label: refName.slice("refs/heads/".length) }
      : refName.startsWith("refs/remotes/")
        ? { kind: "remote-branch", label: refName.slice("refs/remotes/".length) }
        : refName.startsWith("refs/tags/")
          ? { kind: "tag", label: refName.slice("refs/tags/".length) }
          : { kind: "ref", label: refName };
    add(revisionId, decoration);
  }

  const headId = runGit(["rev-parse", "--verify", "--quiet", "HEAD"], options, [0, 1]).trim();
  if (headId) {
    const branch = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], options, [0, 1]).trim();
    add(headId, {
      kind: "head",
      label: "HEAD",
      ...(branch ? { attachedLocalBranch: branch } : {}),
    });
  }

  const order = new Map<ExtensionVcsHistoryDecoration["kind"], number>([
    ["head", 0],
    ["local-branch", 1],
    ["remote-branch", 2],
    ["tag", 3],
    ["ref", 4],
  ]);
  for (const entries of byCommit.values()) {
    entries.sort(
      (left, right) =>
        (order.get(left.kind) ?? 9) - (order.get(right.kind) ?? 9) ||
        (left.label < right.label ? -1 : left.label > right.label ? 1 : 0),
    );
  }
  return byCommit;
}

/** Build deterministic Git log argv from the deliberately small public grammar. */
export function buildGitHistoryArgs(input: ExtensionVcsHistoryInput) {
  const args = [
    "log",
    "--topo-order",
    "--parents",
    "--no-show-signature",
    "--no-color",
    "--abbrev=8",
    "-z",
    "--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b",
  ];
  if (input.all) args.push("--all");
  if (input.firstParent) args.push("--first-parent");
  if (input.maxCount !== undefined) args.push(`--max-count=${input.maxCount}`);
  if (input.author !== undefined) args.push(`--author=${input.author}`);
  if (input.grep !== undefined) args.push(`--grep=${input.grep}`);
  if (input.since !== undefined) args.push(`--since=${input.since}`);
  if (input.until !== undefined) args.push(`--until=${input.until}`);
  if (input.revision !== undefined) args.push(requireRevision(input.revision));
  if (input.pathspecs?.length) args.push("--", ...input.pathspecs);
  return args;
}

/** Parse fixed NUL-delimited machine fields into immutable commit summaries. */
export function parseGitHistory(
  text: string,
  decorations: ReadonlyMap<string, ExtensionVcsHistoryDecoration[]> = new Map(),
  firstParent = false,
  omitGraphParents = false,
): ExtensionVcsHistoryCommit[] {
  if (!text) return [];
  const fields = text.split("\0");
  if (fields.length % HISTORY_FIELDS_PER_COMMIT === 1 && fields.at(-1) === "") fields.pop();
  if (fields.length % HISTORY_FIELDS_PER_COMMIT !== 0) {
    throw new Error("Git returned a truncated history record.");
  }

  const commits: ExtensionVcsHistoryCommit[] = [];
  for (let offset = 0; offset < fields.length; offset += HISTORY_FIELDS_PER_COMMIT) {
    const revisionId = fields[offset]!;
    const displayId = fields[offset + 1]!;
    const parents = fields[offset + 2]!;
    const authorName = fields[offset + 3]!;
    const authorEmail = fields[offset + 4]!;
    const authoredAt = fields[offset + 5]!;
    const subject = fields[offset + 6]!;
    const body = fields[offset + 7]!;
    if (!revisionId || !displayId || !authoredAt) {
      throw new Error("Git returned an incomplete history record.");
    }
    const allParents = parents ? parents.split(" ").filter(Boolean) : [];
    const parentRevisionIds = firstParent ? allParents.slice(0, 1) : allParents;
    if (
      !FULL_OBJECT_ID_PATTERN.test(revisionId) ||
      !ABBREVIATED_OBJECT_ID_PATTERN.test(displayId) ||
      parentRevisionIds.some((parent) => !FULL_OBJECT_ID_PATTERN.test(parent))
    ) {
      throw new Error("Git returned an invalid history object id.");
    }
    commits.push({
      revisionId,
      displayId,
      parentRevisionIds,
      ...(omitGraphParents ? { graphParentRevisionIds: [] } : {}),
      subject: subject || "(no commit message)",
      ...(body ? { body } : {}),
      authorName: authorName || "Unknown author",
      ...(authorEmail ? { authorEmail } : {}),
      authoredAt,
      decorations: [...(decorations.get(revisionId) ?? [])],
    });
  }
  return commits;
}

/** Return whether traversal filters can omit direct parents from the emitted commit stream. */
export function gitHistoryUsesBoundaryTopology(input: ExtensionVcsHistoryInput) {
  return Boolean(
    input.author !== undefined ||
    input.grep !== undefined ||
    input.since !== undefined ||
    input.until !== undefined ||
    input.pathspecs?.length,
  );
}

/** Open a cancellable streaming history cursor over one long-lived Git process. */
export function openGitHistory(
  input: ExtensionVcsHistoryInput,
  { cwd, gitExecutable = "git" }: GitHistoryOptions,
): ExtensionVcsHistorySource & { repoRoot: string } {
  const repoRoot = resolveHistoryRepoRoot({ cwd, gitExecutable });
  const queryOptions = { cwd: repoRoot, gitExecutable };
  const empty = input.maxCount === 0 || (!input.revision && !input.all && !hasHead(queryOptions));
  if (empty) {
    return {
      repoRoot,
      async read() {
        return { commits: [], done: true };
      },
      close() {},
    };
  }

  const decorations = readDecorations(queryOptions);
  const omitGraphParents = gitHistoryUsesBoundaryTopology(input);

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(gitExecutable, buildGitHistoryArgs(input), {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      windowsHide: true,
    });
  } catch {
    throw new HunkExtensionUserError(`Could not run ${gitExecutable}.`, {
      suggestions: ["Install Git or configure Hunk to use another VCS backend."],
    });
  }

  const decoder = new StringDecoder("utf8");
  const queue: ExtensionVcsHistoryCommit[] = [];
  const fields: string[] = [];
  const waiters = new Set<() => void>();
  let buffered = "";
  let stderr = "";
  let completed = false;
  let closed = false;
  let failure: unknown;
  let reading = false;
  const wake = () => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  const consume = (text: string) => {
    buffered += text;
    for (;;) {
      const delimiter = buffered.indexOf("\0");
      if (delimiter < 0) break;
      fields.push(buffered.slice(0, delimiter));
      buffered = buffered.slice(delimiter + 1);
      if (fields.length === HISTORY_FIELDS_PER_COMMIT) {
        queue.push(
          ...parseGitHistory(
            `${fields.join("\0")}\0`,
            decorations,
            input.firstParent,
            omitGraphParents,
          ),
        );
        fields.length = 0;
      }
    }
    wake();
  };

  child.stdout!.on("data", (chunk: Buffer) => {
    consume(decoder.write(chunk));
    if (queue.length >= 512) child.stdout!.pause();
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    if (stderr.length < MAX_HISTORY_STDERR_BYTES) {
      stderr += chunk.slice(0, MAX_HISTORY_STDERR_BYTES - stderr.length);
    }
  });
  child.once("error", (error) => {
    failure = error;
    completed = true;
    wake();
  });
  child.once("close", (code) => {
    consume(decoder.end());
    if (!failure && (fields.length > 0 || buffered.length > 0)) {
      failure = new Error("Git returned a truncated history record.");
    } else if (!failure && code !== 0 && !closed) {
      failure = new HunkExtensionUserError(
        stderr.trim().split("\n")[0] || "Git could not read this history.",
        {
          suggestions: ["Check the revision, filters, and repository, then try again."],
        },
      );
    }
    completed = true;
    wake();
  });

  const waitForData = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("History read aborted."));
        return;
      }
      const ready = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        waiters.delete(ready);
        reject(signal?.reason ?? new Error("History read aborted."));
      };
      waiters.add(ready);
      signal?.addEventListener("abort", abort, { once: true });
    });

  return {
    repoRoot,
    async read({ limit, signal }) {
      if (reading) throw new Error("Concurrent Git history reads are not supported.");
      reading = true;
      try {
        const target = Math.min(limit, 256);
        while (queue.length < target && !completed && !closed) await waitForData(signal);
        if (signal?.aborted) throw signal.reason ?? new Error("History read aborted.");
        if (failure) throw failure;
        const commits = queue.splice(0, target);
        if (!completed && !closed && queue.length < 256) child.stdout!.resume();
        return { commits, done: (completed || closed) && queue.length === 0 };
      } finally {
        reading = false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (!completed) child.kill();
      wake();
    },
  };
}
