import { isAbsolute, relative, resolve } from "node:path";
import { resolveCanonicalPath } from "../../core/run/paths";
import { findProjectRootCandidate } from "../../core/process/projectRoot";
import type { AppBootstrap } from "../../core/bootstrap";
import type { CliInput, CommonOptions } from "../../core/run/commandInputs";
import type { VcsCatalog } from "../../core/vcs/types";

/**
 * Session reload filesystem policy:
 *
 * | Initial session | Reload roots | Rejected reload filesystem reads |
 * | --- | --- | --- |
 * | `hunk diff` / `hunk show` / `hunk stash show` | Initial repo root | Anything outside that repo root. |
 * | `hunk diff --files fileA fileB` inside a repo, both files in repo | The repo root | Anything outside that repo root. |
 * | `hunk difftool fileA fileB` inside a repo, both files in repo | The repo root | Anything outside that repo root. |
 * | `hunk diff --files fileA fileB` outside a repo | None | All session reloads. |
 * | `hunk difftool fileA fileB` outside a repo | None | All session reloads. |
 * | `hunk patch patchfile` inside a repo | The repo root | Anything outside that repo root. |
 * | `hunk patch patchfile` outside a repo | Exact initial patch file | Other files and every repository-backed reload. |
 * | stdin-backed patch startup | None | All session reloads. |
 * | Any session with `--agent-context path` | Same roots as the session | Agent context sidecars outside those roots, symlink escapes, and `--agent-context -`. |
 *
 * All candidate paths are realpath-normalized through existing ancestors so symlinks cannot escape
 * the roots, including paths whose final file does not exist yet.
 *
 * Revision-shaped fields (`vcs` `range`/`rangeEndpoints`, `show`/`stash-show` `ref`) must name
 * revisions, not command options: a value beginning with `-` would let a daemon caller inject flags such as
 * `--output=<path>` into the VCS backend's spawned command. Pathspecs are exempt because every
 * bundled backend appends them after `--`, where the VCS treats them as paths.
 */

export interface SessionReloadBounds {
  roots: string[];
  /** Exact initial resources allowed when startup had no safe directory root. */
  exactFiles: string[];
  defaultCwd: string;
}

/** Return whether the candidate path is the root itself or contained by it. */
function isWithinRoot(root: string, candidate: string) {
  const offset = relative(root, candidate);
  return offset === "" || (offset.length > 0 && !offset.startsWith("..") && !isAbsolute(offset));
}

/** Deduplicate roots and drop sub-roots already covered by an earlier broader root. */
function normalizeRoots(roots: string[]) {
  const normalized = roots.map(resolveCanonicalPath);
  const unique: string[] = [];

  for (const root of normalized) {
    if (unique.some((existing) => isWithinRoot(existing, root))) {
      continue;
    }

    for (let index = unique.length - 1; index >= 0; index -= 1) {
      if (isWithinRoot(root, unique[index]!)) {
        unique.splice(index, 1);
      }
    }

    unique.push(root);
  }

  return unique;
}

/** Return the initial repo root when every requested file is inside that checkout. */
function resolveRepoReloadRoots(initialCwd: string, paths: string[], vcsCatalog?: VcsCatalog) {
  const repoRoot = findProjectRootCandidate(initialCwd, vcsCatalog);
  if (!repoRoot) {
    return [];
  }

  const resolvedRepoRoot = resolveCanonicalPath(repoRoot);
  const filePaths = paths.map((path) => resolveCanonicalPath(resolve(initialCwd, path)));
  return filePaths.every((path) => isWithinRoot(resolvedRepoRoot, path)) ? [resolvedRepoRoot] : [];
}

/** Resolve the filesystem roots the initial Hunk command made available to session reloads. */
export function createSessionReloadBounds(
  bootstrap: AppBootstrap,
  { cwd = process.cwd() }: { cwd?: string } = {},
): SessionReloadBounds {
  const initialCwd = resolveCanonicalPath(cwd);
  let roots: string[] = [];
  let exactFiles: string[] = [];

  switch (bootstrap.input.kind) {
    case "vcs":
    case "show":
    case "stash-show":
      roots = [bootstrap.reloadContext.repoRoot ?? bootstrap.reloadContext.cwd];
      break;
    case "diff":
    case "difftool":
      roots = resolveRepoReloadRoots(
        initialCwd,
        [bootstrap.input.left, bootstrap.input.right],
        bootstrap.reloadContext.vcsCatalog,
      );
      break;
    case "patch":
      if (bootstrap.input.file && bootstrap.input.file !== "-") {
        roots = resolveRepoReloadRoots(
          initialCwd,
          [bootstrap.input.file],
          bootstrap.reloadContext.vcsCatalog,
        );
        if (roots.length === 0) {
          exactFiles = [resolveCanonicalPath(resolve(initialCwd, bootstrap.input.file))];
        }
      }
      break;
  }

  return {
    roots: normalizeRoots(roots),
    exactFiles: [...new Set(exactFiles.map(resolveCanonicalPath))],
    defaultCwd: initialCwd,
  };
}

/** Reject session reloads for startup inputs that did not establish a repository root. */
function assertReloadableBounds(bounds: SessionReloadBounds) {
  if (bounds.roots.length === 0 && bounds.exactFiles.length === 0) {
    throw new Error(
      "Session reload requires the initial Hunk session to be rooted in a repository.",
    );
  }
}

/** Resolve a candidate path and reject it when it escapes the initial session roots. */
function assertReloadFileWithinBounds(
  bounds: SessionReloadBounds,
  cwd: string,
  path: string,
  description: string,
  allowExactFile = false,
) {
  const candidate = resolveCanonicalPath(resolve(cwd, path));
  const withinRoot = bounds.roots.some((root) => isWithinRoot(root, candidate));
  const exactMatch = allowExactFile && bounds.exactFiles.includes(candidate);
  if (!withinRoot && !exactMatch) {
    throw new Error(
      `Session reload refused ${description} outside the initial Hunk root: ${candidate}`,
    );
  }

  return candidate;
}

/** Resolve a reload cwd and reject it when it escapes the initial session root. */
function assertReloadSourceWithinBounds(bounds: SessionReloadBounds, cwd: string, path: string) {
  const candidate = resolveCanonicalPath(resolve(cwd, path));
  const allowed = bounds.roots.some((root) => isWithinRoot(root, candidate));
  if (!allowed) {
    throw new Error(
      `Session reload refused source path outside the initial Hunk root: ${candidate}`,
    );
  }

  return candidate;
}

/** Reject daemon-supplied revision fields that a VCS backend would parse as command options. */
function assertReloadRevisionNotOptionLike(description: string, value: string) {
  if (value.startsWith("-")) {
    throw new Error(`Session reload refused ${description} that looks like a VCS option: ${value}`);
  }
}

/** Validate common reload options that may cause filesystem reads. */
function validateCommonReloadOptions(
  bounds: SessionReloadBounds,
  cwd: string,
  options: CommonOptions,
) {
  if (!options.agentContext) {
    return;
  }

  if (options.agentContext === "-") {
    throw new Error("Session reload does not support `--agent-context -`.");
  }

  assertReloadFileWithinBounds(bounds, cwd, options.agentContext, "agent context path");
}

/**
 * Validate one daemon-driven reload request before it can read files from disk.
 * Returns the cwd that should be used for config layering and content loading.
 */
export function validateSessionReloadWithinBounds(
  bounds: SessionReloadBounds,
  nextInput: CliInput,
  options: { sourcePath?: string } = {},
) {
  assertReloadableBounds(bounds);

  const sourceCwd = options.sourcePath
    ? assertReloadSourceWithinBounds(bounds, bounds.defaultCwd, options.sourcePath)
    : bounds.defaultCwd;

  validateCommonReloadOptions(bounds, sourceCwd, nextInput.options);

  switch (nextInput.kind) {
    case "diff":
    case "difftool":
      assertReloadFileWithinBounds(bounds, sourceCwd, nextInput.left, "left file");
      assertReloadFileWithinBounds(bounds, sourceCwd, nextInput.right, "right file");
      break;
    case "patch":
      if (nextInput.file && nextInput.file !== "-") {
        assertReloadFileWithinBounds(bounds, sourceCwd, nextInput.file, "patch file", true);
        break;
      }

      if (nextInput.text === undefined) {
        throw new Error("Session reload does not support stdin-backed patch input.");
      }
      break;
    case "vcs":
      if (bounds.roots.length === 0) {
        throw new Error(
          "Session reload requires repository-backed input to stay inside the initial Hunk root.",
        );
      }
      if (nextInput.range) {
        assertReloadRevisionNotOptionLike("diff range", nextInput.range);
      }
      if (nextInput.rangeEndpoints) {
        assertReloadRevisionNotOptionLike("diff from revision", nextInput.rangeEndpoints.from);
        assertReloadRevisionNotOptionLike("diff to revision", nextInput.rangeEndpoints.to);
      }
      break;
    case "show":
    case "stash-show":
      if (bounds.roots.length === 0) {
        throw new Error(
          "Session reload requires repository-backed input to stay inside the initial Hunk root.",
        );
      }
      if (nextInput.ref) {
        assertReloadRevisionNotOptionLike(`${nextInput.kind} ref`, nextInput.ref);
      }
      break;
  }

  return { cwd: sourceCwd };
}
