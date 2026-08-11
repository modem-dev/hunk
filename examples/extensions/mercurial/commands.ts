import { spawnSync } from "node:child_process";
import {
  HunkExtensionUserError,
  type ExtensionVcsDiffInput,
  type ExtensionVcsShowInput,
} from "hunkdiff/extension";

export type HgBackedInput = ExtensionVcsDiffInput | ExtensionVcsShowInput;

export interface RunHgTextOptions {
  input: HgBackedInput;
  args: string[];
  cwd?: string;
  hgExecutable?: string;
}

export type HgRange =
  | { kind: "working-copy" }
  | { kind: "revision-to-working-copy"; revision: string }
  | { kind: "revision-pair"; oldRevision: string; newRevision: string };

/** Format the Hunk command represented by an adapter input. */
export function formatHgCommandLabel(input: HgBackedInput) {
  if (input.kind === "show") {
    return input.ref ? `hunk show ${input.ref}` : "hunk show";
  }
  if (input.staged) {
    return "hunk diff --staged";
  }
  return input.range ? `hunk diff ${input.range}` : "hunk diff";
}

/** Parse the example's deliberately narrow `REV` or `REV1:REV2` range syntax. */
export function parseHgRange(range?: string): HgRange {
  if (range === undefined) {
    return { kind: "working-copy" };
  }

  const separator = range.indexOf(":");
  if (separator === -1) {
    if (range.trim().length > 0) {
      return { kind: "revision-to-working-copy", revision: range };
    }
  } else if (separator === range.lastIndexOf(":")) {
    const oldRevision = range.slice(0, separator);
    const newRevision = range.slice(separator + 1);
    if (oldRevision.trim().length > 0 && newRevision.trim().length > 0) {
      return { kind: "revision-pair", oldRevision, newRevision };
    }
  }

  throw new HunkExtensionUserError(
    `Mercurial range \`${range}\` is not supported by this example adapter.`,
    { suggestions: ["Use one revision (REV) or two non-empty revisions (REV1:REV2)."] },
  );
}

/** Append path filters as explicit Mercurial `path:` patterns after `--`. */
function appendHgPathspecs(args: string[], pathspecs?: string[]) {
  if (pathspecs && pathspecs.length > 0) {
    args.push("--", ...pathspecs.map((pathspec) => `path:${pathspec}`));
  }
}

/** Build deterministic working-copy or revision-pair diff arguments. */
export function buildHgDiffArgs(
  input: ExtensionVcsDiffInput,
  range: HgRange = parseHgRange(input.range),
) {
  const args = ["diff", "--git", "--nodates"];
  if (range.kind === "revision-to-working-copy") {
    args.push("--rev", range.revision);
  } else if (range.kind === "revision-pair") {
    args.push("--rev", range.oldRevision, "--rev", range.newRevision);
  }
  appendHgPathspecs(args, input.pathspecs);
  return args;
}

/** Build deterministic `hg diff --change` arguments for `hunk show`. */
export function buildHgShowArgs(input: ExtensionVcsShowInput, revision = input.ref ?? ".") {
  const args = ["diff", "--git", "--nodates", "--change", revision];
  appendHgPathspecs(args, input.pathspecs);
  return args;
}

/** Build the NUL-delimited unknown-file query for a live working-copy review. */
export function buildHgUnknownArgs(input: ExtensionVcsDiffInput) {
  const args = ["status", "--unknown", "--print0"];
  appendHgPathspecs(args, input.pathspecs);
  return args;
}

/** Parse `hg status --unknown --print0` into deterministic repo-relative paths. */
export function parseHgUnknownPaths(statusText: string) {
  return statusText
    .split("\0")
    .filter((entry) => entry.startsWith("? "))
    .map((entry) => entry.slice(2))
    .sort();
}

/** Return whether a diff has the working-copy filesystem as its new endpoint. */
export function hasWorkingCopyEndpoint(input: ExtensionVcsDiffInput) {
  return parseHgRange(input.range).kind !== "revision-pair";
}

/** Return the environment that makes Mercurial output stable UTF-8 text. */
export function buildHgEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  return { ...environment, HGPLAIN: "1", HGENCODING: "utf-8" };
}

/** Return the clean user error for Mercurial's lack of a staging area. */
export function createHgStagedError(input: ExtensionVcsDiffInput) {
  return new HunkExtensionUserError(
    `\`${formatHgCommandLabel(input)}\` is unavailable because Mercurial has no staging area.`,
    { suggestions: ["Remove `--staged` to review the Mercurial working copy."] },
  );
}

/** Remove Mercurial's standard prefix from one diagnostic line. */
function trimHgPrefix(message: string) {
  return message.replace(/^(abort|error):\s*/i, "").trim();
}

/** Select a concise diagnostic suitable for a user-error suggestion. */
function firstHgErrorLine(stderr: string) {
  const first = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return trimHgPrefix(first ?? (stderr.trim() || "Mercurial command failed."));
}

/** Translate a process-spawn failure into Hunk's public user-error shape. */
export function translateHgSpawnFailure(
  input: HgBackedInput,
  error: unknown,
  hgExecutable: string,
): Error {
  if (error instanceof HunkExtensionUserError) {
    return error;
  }
  if (
    error instanceof Error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      /not found|cannot find/i.test(error.message))
  ) {
    return new HunkExtensionUserError(
      `Mercurial is required for \`${formatHgCommandLabel(input)}\`, but \`${hgExecutable}\` was not found in PATH.`,
      { suggestions: ["Install Mercurial, then try the command again."] },
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new HunkExtensionUserError(`\`${formatHgCommandLabel(input)}\` failed.`, {
    suggestions: [detail || "Mercurial could not be started."],
  });
}

/** Translate Mercurial stderr into stable, actionable Hunk user errors. */
export function translateHgExitFailure(input: HgBackedInput, stderr: string): Error {
  const lower = stderr.toLowerCase();
  if (
    lower.includes("no repository found") ||
    lower.includes("not inside a repository") ||
    lower.includes("not a repository")
  ) {
    return new HunkExtensionUserError(
      `\`${formatHgCommandLabel(input)}\` must be run inside a Mercurial repository.`,
      { suggestions: ["Run the command from a Mercurial working copy and try again."] },
    );
  }
  if (
    lower.includes("unknown revision") ||
    lower.includes("unknown identifier") ||
    lower.includes("ambiguous revision") ||
    lower.includes("parse error") ||
    lower.includes("cannot follow file not in parent revision")
  ) {
    const revision = input.kind === "show" ? (input.ref ?? ".") : (input.range ?? ".");
    return new HunkExtensionUserError(
      `\`${formatHgCommandLabel(input)}\` could not resolve Mercurial revision \`${revision}\`.`,
      { suggestions: ["Check the revision name and try again."] },
    );
  }
  return new HunkExtensionUserError(`\`${formatHgCommandLabel(input)}\` failed.`, {
    suggestions: [firstHgErrorLine(stderr)],
  });
}

/** Run one Mercurial command with argv spawning and translated failures. */
export function runHgText({
  input,
  args,
  cwd = process.cwd(),
  hgExecutable = "hg",
}: RunHgTextOptions) {
  let result;
  try {
    result = spawnSync(hgExecutable, args, {
      cwd,
      encoding: "utf8",
      env: buildHgEnvironment(),
      input: "",
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw translateHgSpawnFailure(input, error, hgExecutable);
  }

  if (result.error) {
    throw translateHgSpawnFailure(input, result.error, hgExecutable);
  }
  if (result.status !== 0) {
    throw translateHgExitFailure(
      input,
      result.stderr.trim() || `Mercurial exited with status ${result.status ?? "unknown"}.`,
    );
  }
  return result.stdout;
}

/** Resolve the canonical repository root reported by Mercurial itself. */
export function resolveHgRepoRoot(
  input: HgBackedInput,
  options: Omit<RunHgTextOptions, "input" | "args"> = {},
) {
  return runHgText({ input, args: ["root"], ...options }).trim();
}

/** Resolve a revision expression to its immutable full node id. */
export function resolveHgNode(
  input: HgBackedInput,
  revision: string,
  options: Omit<RunHgTextOptions, "input" | "args"> = {},
) {
  return runHgText({
    input,
    args: ["log", "--rev", revision, "--template", "{node}\n"],
    ...options,
  }).trim();
}

/** Read one committed file, returning null when that revision has no such path. */
export function readHgCommittedFile(
  input: HgBackedInput,
  revision: string | null,
  filePath: string,
  options: Omit<RunHgTextOptions, "input" | "args"> = {},
) {
  if (revision === null || revision.length === 0) {
    return null;
  }
  try {
    return runHgText({
      input,
      args: ["cat", "--rev", revision, "--", `path:${filePath}`],
      ...options,
    });
  } catch {
    // Source readers are optional capabilities. A path absent from this side,
    // or a repository changed between load and lazy read, means unavailable.
    return null;
  }
}
