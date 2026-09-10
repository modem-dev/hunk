import { createHash } from "node:crypto";
import { open, stat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildGitIgnoredDirectoryArgs, parseGitIgnoredDirectoryRoots } from "./commands";
import { normalizePathForOS, resolveCanonicalPath } from "@hunk/vcs/path";
import { runAbortableCommand } from "@hunk/vcs/async-process";
import type {
  ExtensionVcsStatusCapability,
  ExtensionVcsStatusFact,
  ExtensionVcsStatusHead,
  ExtensionVcsStatusOperation,
  ExtensionVcsStatusPath,
  ExtensionVcsStatusPathState,
  ExtensionVcsStatusUpstream,
  ExtensionVcsStatusWorktreeSummary,
} from "hunkdiff/extension";

const MAX_PATHS = 20_000;
const MAX_WORKTREES = 100;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const QUERY_TIMEOUT_MS = 5_000;
const SIBLING_CONCURRENCY = 4;

interface GitStatusContext {
  cwd: string;
  gitExecutable: string;
  signal?: AbortSignal;
}

const states: Record<string, ExtensionVcsStatusPathState> = {
  ".": "unchanged",
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
  U: "unmerged",
  "?": "untracked",
};

/** Consume fixed machine fields without splitting whitespace inside the final path. */
function fieldsAndPath(record: string, fieldCount: number) {
  const fields: string[] = [];
  let offset = 0;
  for (let i = 0; i < fieldCount; i++) {
    const end = record.indexOf(" ", offset);
    if (end < 0) throw new Error("Git returned an incomplete status record.");
    fields.push(record.slice(offset, end));
    offset = end + 1;
  }
  const path = record.slice(offset);
  if (!path) {
    throw new Error("Git status contains an empty path.");
  }
  return { fields, path };
}

/** Parse NUL porcelain v2, retaining mixed staging states, rename sources and submodules. */
export function parseGitStatus(text: string) {
  if (text && !text.endsWith("\0")) throw new Error("Git returned truncated status output.");
  const records = text.split("\0");
  records.pop();
  const headers = new Map<string, string>();
  const paths: ExtensionVcsStatusPath[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("# ")) {
      const end = record.indexOf(" ", 2);
      if (end < 0) throw new Error("Git returned an incomplete status header.");
      headers.set(record.slice(2, end), record.slice(end + 1));
      continue;
    }
    const kind = record[0];
    if (!["1", "2", "u", "?"].includes(kind ?? "")) {
      throw new Error("Git returned an unsupported status record.");
    }
    const { fields, path } = fieldsAndPath(
      record,
      kind === "1" ? 8 : kind === "2" ? 9 : kind === "u" ? 10 : 1,
    );
    if (seen.has(path)) throw new Error("Git returned duplicate status paths.");
    seen.add(path);
    if (paths.length >= MAX_PATHS)
      throw new Error(`Git status exceeds ${MAX_PATHS} changed paths.`);
    if (kind === "?") {
      paths.push({ path, index: "unchanged", worktree: "untracked", conflict: false });
      continue;
    }
    const xy = fields[1]!;
    const sub = fields[2]!;
    if (
      xy.length !== 2 ||
      !states[xy[0]!] ||
      !states[xy[1]!] ||
      !/^(N\.\.\.|S[.C][.M][.U])$/.test(sub)
    ) {
      throw new Error("Git returned invalid status states.");
    }
    const previousPath = kind === "2" ? records[++i] : undefined;
    if (kind === "2" && !previousPath) {
      throw new Error("Git returned an incomplete rename source.");
    }
    paths.push({
      path,
      ...(previousPath === undefined ? {} : { previousPath }),
      index: states[xy[0]!]!,
      worktree: states[xy[1]!]!,
      conflict: kind === "u",
      ...(sub[0] === "S"
        ? {
            submodule: {
              commitChanged: sub[1] === "C",
              trackedChanges: sub[2] === "M",
              untrackedChanges: sub[3] === "U",
            },
          }
        : {}),
    });
  }
  const oid = headers.get("branch.oid");
  const branch = headers.get("branch.head");
  if (!oid || !branch || (oid !== "(initial)" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) {
    throw new Error("Git returned incomplete branch identity.");
  }
  const head: ExtensionVcsStatusHead =
    oid === "(initial)"
      ? { kind: "unborn", name: branch }
      : branch === "(detached)"
        ? { kind: "detached", revisionId: oid }
        : { kind: "branch", name: branch, revisionId: oid };
  return {
    paths,
    head,
    upstream: headers.get("branch.upstream"),
    divergence: headers.get("branch.ab"),
  };
}

export interface GitStatusWorktreeRecord {
  path: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
}

/** Parse `worktree list --porcelain -z`; newlines and spaces remain literal path bytes. */
export function parseGitStatusWorktrees(text: string): GitStatusWorktreeRecord[] {
  if (text && !text.endsWith("\0\0")) throw new Error("Git returned truncated worktree output.");
  const result: GitStatusWorktreeRecord[] = [];
  let current: GitStatusWorktreeRecord | undefined;
  for (const field of text.split("\0")) {
    if (!field) {
      if (current) result.push(current);
      current = undefined;
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);
    if (key === "worktree") {
      if (current || !value) throw new Error("Git returned invalid worktree identity.");
      current = { path: value, detached: false, bare: false };
    } else {
      if (!current) throw new Error("Git returned incomplete worktree metadata.");
      if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "detached") current.detached = true;
      else if (key === "bare") current.bare = true;
      else if (key === "locked") current.locked = value;
      else if (key === "prunable") current.prunable = value;
      else if (key !== "HEAD") throw new Error("Git returned unsupported worktree metadata.");
    }
  }
  return result;
}

/** Run read-only Git with explicit time/output limits and process-tree cancellation. */
async function query(args: string[], context: GitStatusContext, accepted = [0]) {
  const result = await runAbortableCommand([context.gitExecutable, ...args], {
    cwd: context.cwd,
    signal: context.signal,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxOutputBytes: MAX_OUTPUT_BYTES,
    timeoutMs: QUERY_TIMEOUT_MS,
    strictUtf8: true,
  });
  if (!accepted.includes(result.exitCode)) {
    throw new Error(result.stderr.trim().split("\n")[0] || "Git could not read workspace status.");
  }
  return result;
}

/** Remove only Git's record terminator, never whitespace belonging to a directory name. */
function outputPath(text: string) {
  const path = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!path) throw new Error("Git returned an invalid metadata path.");
  return path;
}

/** Resolve linked-worktree metadata independently of the launch authority's working directory. */
async function metadata(context: GitStatusContext) {
  const bare =
    (await query(["rev-parse", "--is-bare-repository"], context)).stdout.trim() === "true";
  if (bare) throw new Error("Status requires a worktree; this Git repository is bare.");
  // Require readable metadata before canonicalization, whose missing-leaf fallback serves sibling rows.
  const path = resolveCanonicalPath(
    await realpath(
      normalizePathForOS(
        outputPath((await query(["rev-parse", "--show-toplevel"], context)).stdout),
      ),
    ),
  );
  const gitDir = resolveCanonicalPath(
    await realpath(
      normalizePathForOS(
        outputPath((await query(["rev-parse", "--absolute-git-dir"], context)).stdout),
      ),
    ),
  );
  const commonDir = resolveCanonicalPath(
    await realpath(
      resolve(
        context.cwd,
        normalizePathForOS(
          outputPath((await query(["rev-parse", "--git-common-dir"], context)).stdout),
        ),
      ),
    ),
  );
  context.signal?.throwIfAborted();
  return { path, gitDir, commonDir };
}

/** Distinguish missing optional metadata from unreadable metadata. */
async function optionalStat(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read a small optional operation file without retaining an unbounded metadata payload. */
async function operationText(path: string) {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(65_537);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > 65_536) throw new Error("Git operation metadata exceeds 64 KiB.");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await file.close();
  }
}

/** Observe operation markers in the per-worktree directory, retaining access failures. */
async function operations(
  gitDir: string,
): Promise<ExtensionVcsStatusFact<ExtensionVcsStatusOperation[]>> {
  const markers: [string, ExtensionVcsStatusOperation][] = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply/rebasing", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"],
  ];
  try {
    const found = await Promise.all(
      markers.map(async ([name, operation]) =>
        (await optionalStat(join(gitDir, name))) ? operation : undefined,
      ),
    );
    // Sequencers may remain active between commits without CHERRY_PICK_HEAD or REVERT_HEAD.
    const todo = await operationText(join(gitDir, "sequencer", "todo"));
    const next = todo?.split("\n").find((line) => line.trim() && !line.startsWith("#"));
    if (next?.startsWith("pick ")) found.push("cherry-pick");
    else if (next?.startsWith("revert ")) found.push("revert");
    else if (todo !== undefined)
      return { state: "unknown", reason: "Git sequencer operation could not be identified." };
    if (await optionalStat(join(gitDir, "rebase-apply", "applying"))) {
      return { state: "unknown", reason: "Git is applying mailbox patches." };
    }
    return {
      state: "ready",
      value: [
        ...new Set(
          found.filter((value): value is ExtensionVcsStatusOperation => value !== undefined),
        ),
      ],
    };
  } catch (error) {
    return { state: "error", message: String(error) };
  }
}

/** Read divergence and local FETCH_HEAD mtime without attributing it to an individual upstream. */
async function upstream(
  parsed: ReturnType<typeof parseGitStatus>,
  gitDir: string,
): Promise<ExtensionVcsStatusFact<ExtensionVcsStatusUpstream>> {
  if (parsed.head.kind !== "branch") return { state: "ready", value: { kind: parsed.head.kind } };
  if (!parsed.upstream) return { state: "ready", value: { kind: "none" } };
  if (!parsed.divergence)
    return { state: "ready", value: { kind: "missing", name: parsed.upstream } };
  const counts = /^\+(\d+) -(\d+)$/.exec(parsed.divergence);
  if (!counts) return { state: "error", message: "Git returned invalid upstream divergence." };
  let fetch: Extract<ExtensionVcsStatusUpstream, { kind: "tracked" }>["fetch"];
  try {
    const fetched = await optionalStat(join(gitDir, "FETCH_HEAD"));
    fetch =
      fetched && fetched.size > 0
        ? {
            state: "ready",
            value: { timestamp: fetched.mtime.toISOString(), provenance: "local-fetch-head-mtime" },
          }
        : { state: "unknown", reason: "No local FETCH_HEAD metadata." };
  } catch (error) {
    fetch = { state: "error", message: String(error) };
  }
  return {
    state: "ready",
    value: {
      kind: "tracked",
      name: parsed.upstream,
      ahead: Number(counts[1]),
      behind: Number(counts[2]),
      fetch,
    },
  };
}

/** Create bounded Git status reads; callers own refresh scheduling and coherent generations. */
export function createGitStatusCapability(gitExecutable = "git"): ExtensionVcsStatusCapability {
  /** Verify every inspected target still belongs to the launch repository. */
  const targetMetadata = async (targetPath: string | undefined, context: GitStatusContext) => {
    const origin = await metadata(context);
    const target =
      targetPath && resolveCanonicalPath(targetPath) !== origin.path
        ? await metadata({ ...context, cwd: targetPath })
        : origin;
    if (target.commonDir !== origin.commonDir)
      throw new Error("Status target is no longer in the same Git repository.");
    return target;
  };
  const capability: ExtensionVcsStatusCapability = {
    async read({ targetPath }, context) {
      const options = { ...context, gitExecutable };
      const target = await targetMetadata(targetPath, options);
      const raw = (
        await query(
          [
            "-c",
            "status.relativePaths=false",
            "status",
            "--porcelain=v2",
            "--branch",
            "--ahead-behind",
            "--renames",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
          ],
          { ...options, cwd: target.path },
        )
      ).stdout;
      const parsed = parseGitStatus(raw);
      const [operationState, upstreamState] = await Promise.all([
        operations(target.gitDir),
        upstream(parsed, target.gitDir),
      ]);
      context.signal?.throwIfAborted();
      const reviewActions = [
        ...(parsed.paths.some((path) => path.index !== "unchanged")
          ? [{ id: "staged", label: "Staged changes" }]
          : []),
        ...(parsed.paths.some((path) => path.worktree !== "unchanged")
          ? [{ id: "unstaged", label: "Working tree changes" }]
          : []),
      ];
      return {
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        worktree: { id: target.path, path: target.path, repositoryId: target.commonDir },
        token: createHash("sha256")
          .update(target.path)
          .update("\0")
          .update(target.commonDir)
          .update("\0")
          .update(raw)
          .update(JSON.stringify(operationState))
          .digest("hex"),
        head: parsed.head,
        upstream: upstreamState,
        operations: operationState,
        paths: parsed.paths,
        changedPathCount: parsed.paths.length,
        reviewActions,
        siblings: { state: "loading" },
      };
    },
    async readSiblings(snapshot, context) {
      const options = { ...context, gitExecutable };
      const target = await targetMetadata(snapshot.worktree.path, options);
      if (target.commonDir !== snapshot.worktree.repositoryId)
        throw new Error("Status repository identity changed.");
      const records = parseGitStatusWorktrees(
        (await query(["worktree", "list", "--porcelain", "-z"], { ...options, cwd: target.path }))
          .stdout,
      )
        .map((record) => ({
          ...record,
          path: resolveCanonicalPath(normalizePathForOS(record.path)),
        }))
        .filter((record) => record.path !== target.path);
      const selected = records.slice(0, MAX_WORKTREES);
      const results: ExtensionVcsStatusWorktreeSummary[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(SIBLING_CONCURRENCY, selected.length) }, async () => {
          for (;;) {
            context.signal?.throwIfAborted();
            const index = next++;
            const record = selected[index];
            if (!record) return;
            const summary: ExtensionVcsStatusWorktreeSummary = {
              branch: record.branch,
              detached: record.detached,
              bare: record.bare,
              locked: record.locked,
              prunable: record.prunable,
              worktree: { id: record.path, path: record.path, repositoryId: target.commonDir },
              inspectable: false,
              status: { state: "unavailable", message: "Worktree unavailable." },
            };
            if (record.bare || record.prunable !== undefined) {
              summary.status = {
                state: "unavailable",
                message: record.bare
                  ? "Bare repository has no worktree."
                  : record.prunable || "Prunable worktree.",
              };
            } else {
              try {
                const sibling = await capability.read({ targetPath: record.path }, context);
                summary.worktree = sibling.worktree;
                summary.inspectable = true;
                summary.branch = sibling.head.kind === "detached" ? undefined : sibling.head.name;
                summary.detached = sibling.head.kind === "detached";
                summary.status = {
                  state: "ready",
                  observedAt: sibling.observedAt,
                  changedPathCount: sibling.changedPathCount,
                  conflictCount: sibling.paths.filter((path) => path.conflict).length,
                  operations: sibling.operations,
                };
              } catch (error) {
                context.signal?.throwIfAborted();
                summary.status = { state: "error", message: String(error) };
              }
            }
            results[index] = summary;
          }
        }),
      );
      return { worktrees: results, truncated: records.length > selected.length };
    },
    async planReview(snapshot, actionId, context) {
      const current = await capability.read({ targetPath: snapshot.worktree.path }, context);
      if (
        current.token !== snapshot.token ||
        current.worktree.repositoryId !== snapshot.worktree.repositoryId
      ) {
        throw new Error("Workspace status changed; refresh before opening this review.");
      }
      if (!current.reviewActions.some((action) => action.id === actionId))
        throw new Error("This status review action is unavailable.");
      return {
        cwd: current.worktree.path,
        input: { kind: "vcs", staged: actionId === "staged", options: {} },
      };
    },
    async watchPlan(snapshot, context) {
      const target = await targetMetadata(snapshot.worktree.path, { ...context, gitExecutable });
      if (target.commonDir !== snapshot.worktree.repositoryId)
        throw new Error("Status repository identity changed.");
      const ignored = await query(buildGitIgnoredDirectoryArgs(), {
        ...context,
        cwd: target.path,
        gitExecutable,
      });
      return {
        coverage: "hybrid",
        targets: [
          {
            kind: "directory-tree",
            directory: target.path,
            ignoredRoots: [
              join(target.path, ".git"),
              ...parseGitIgnoredDirectoryRoots(ignored.stdout, target.path),
            ],
            sources: ["worktree"],
          },
          ...[...new Set([target.gitDir, target.commonDir])].map((directory) => ({
            kind: "directory-tree" as const,
            directory,
            ignoredRoots: [join(directory, "objects")],
            sources: ["vcs-metadata" as const],
          })),
        ],
      };
    },
  };
  return capability;
}
