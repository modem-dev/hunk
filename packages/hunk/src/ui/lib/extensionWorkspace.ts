/**
 * The one policy behind `ctx.workspace`: whether a reviewed file may be written
 * back to disk and where that write would land, and which read answers a
 * request for one of a reviewed file's document sides.
 *
 * Free of React and of the filesystem on purpose. `canWriteDocument` is meant
 * to be exactly the question `writeDocument` asks itself before prompting, so
 * both go through this module and neither re-derives the answer — an affordance
 * that disagreed with the action it advertises would be worse than no
 * affordance at all. Reads resolve to the fetcher that would answer them rather
 * than performing the read, which keeps the whole module a pure decision.
 *
 * Confinement here is therefore lexical, and lexical confinement is only as
 * true as the assumption that a reviewed path names a real file inside the
 * root. `./workspaceWriteGuard` is the syscall half that checks that assumption
 * before a write is ever proposed to the user; a `writable: true` answer from
 * this module is a policy verdict, not yet a permit.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeDiffPath } from "../../core/changeset/diffPaths";
import type { FileSourceSide } from "../../core/changeset/fileSource";
import { canReloadInput } from "../../core/run/inputReload";
import type { CliInput } from "../../core/run/commandInputs";
import { readMetadataChangeType } from "../../extensions/events";

/**
 * The slice of one reviewed file the workspace policy inspects.
 *
 * Structural like `SidebarFileSource`: Hunk's internal `DiffFile` satisfies it
 * as it is, and the policy never needs the parsed diff itself — only which file
 * this is, where it lives, whether it has writable new-side text at all, and
 * how its source would be read.
 */
export interface WorkspaceFileSource {
  id: string;
  path: string;
  metadata?: unknown;
  isBinary?: boolean;
  isTooLarge?: boolean;
  /** Absent when the loader had no reachable source for this file. */
  sourceFetcher?: { getFullText(side: FileSourceSide): Promise<string | null> };
}

/** One reviewed document side's read, already bound to the file that answers it. */
export type WorkspaceDocumentRead = () => Promise<string | null>;

/** Where an allowed write lands, or why the reviewed file cannot be written. */
export type ExtensionWorkspaceWriteTarget =
  | {
      writable: true;
      /** The reviewed path, root-relative, as the review and the prompt name it. */
      path: string;
      /** The absolute path the host writes to. */
      absolutePath: string;
    }
  | {
      writable: false;
      /** Human-readable `detail` for the `"unavailable"` result. */
      detail: string;
    };

/** A normalized write request, once its fields are known to be well-formed. */
export interface WorkspaceWriteRequestFields {
  fileId: string;
  text: string;
}

/**
 * Name what this session is reviewing when it is not the working tree.
 *
 * Writes exist to edit the files under review, and only a working-tree review
 * has any: every other input describes content that already happened (a
 * revision, a stash, a staged snapshot) or content with no working-tree
 * identity at all (a patch, two arbitrary files).
 */
function nonWorkingTreeReview(input: CliInput): string | null {
  switch (input.kind) {
    case "vcs":
      if (input.range || input.rangeEndpoints) {
        return "a revision range";
      }

      return input.staged ? "staged changes" : null;
    case "show":
      return "a single revision";
    case "stash-show":
      return "a stash entry";
    case "patch":
      return "patch input";
    case "diff":
    case "difftool":
      return "a file comparison";
  }
}

/**
 * Whether `candidate` is the root itself or a path beneath it, lexically.
 *
 * The one containment rule behind workspace writes, so the lexical policy and
 * the filesystem guard that re-asks it of real, link-resolved paths cannot
 * disagree about what "inside the review root" means.
 */
export function isWithinRoot(root: string, candidate: string) {
  const relativePath = relative(root, candidate);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

/**
 * Reject a malformed write request the way `dialogs` rejects a malformed
 * question: a bug in the extension is not an answer from the user, so it throws
 * rather than resolving one of the refusal reasons.
 */
export function normalizeWorkspaceWriteRequest(request: unknown): WorkspaceWriteRequestFields {
  const fields = request as Partial<WorkspaceWriteRequestFields> | null | undefined;

  if (typeof fields?.fileId !== "string" || fields.fileId.length === 0) {
    throw new Error("workspace.writeDocument requires a non-empty fileId.");
  }

  if (typeof fields.text !== "string") {
    throw new Error("workspace.writeDocument requires text to be a string.");
  }

  return { fileId: fields.fileId, text: fields.text };
}

/**
 * Resolve one reviewed file id into the working-tree path a write may replace.
 *
 * Every refusal carries the sentence the extension receives as `detail`, so the
 * reason a write is unavailable is decided once, here, instead of being
 * reconstructed at each call site.
 *
 * The path comes out of VCS patch text rather than from the extension, which
 * can only ever name a file id — but patch text is not a trust boundary Hunk
 * controls, so the resolved path is still confined to the review root
 * (lexically here, and against the filesystem in `./workspaceWriteGuard`).
 *
 * A session that cannot reload is refused along with the review kinds that have
 * no working-tree document: a write whose result the review can never show is a
 * write the user is looking away from, and the contract promises the opposite.
 */
export function resolveExtensionWorkspaceWriteTarget({
  fileId,
  files,
  input,
  root,
}: {
  fileId: string;
  /** The full current changeset, unfiltered: a hidden file is still a reviewed file. */
  files: readonly WorkspaceFileSource[];
  input: CliInput;
  /** The repo root this review was loaded from, or its working directory. */
  root: string;
}): ExtensionWorkspaceWriteTarget {
  const reviewing = nonWorkingTreeReview(input);
  if (reviewing) {
    return {
      writable: false,
      detail: `Workspace writes are working-tree only; this session is reviewing ${reviewing}.`,
    };
  }

  // Every successful write reloads the session, so a session that cannot reload
  // cannot write. The reachable case here is `--agent-context -`: the sidecar
  // came from stdin and cannot be read a second time. (`canReloadInput` also
  // refuses patch input from stdin, which the working-tree check already
  // refused.)
  if (!canReloadInput(input)) {
    return {
      writable: false,
      detail:
        "Workspace writes need a session that can reload; this one cannot, because part of its input came from stdin (--agent-context -).",
    };
  }

  const file = files.find((candidate) => candidate.id === fileId);
  if (!file) {
    return { writable: false, detail: `No reviewed file has the id "${fileId}".` };
  }

  const path = normalizeDiffPath(file.path) ?? file.path;

  if (readMetadataChangeType(file.metadata) === "deleted") {
    return { writable: false, detail: `${path} was deleted in this review; it has no new side.` };
  }

  if (file.isBinary) {
    return { writable: false, detail: `${path} is binary; workspace writes are text-only.` };
  }

  if (file.isTooLarge) {
    return { writable: false, detail: `${path} was skipped as too large to load.` };
  }

  const absolutePath = resolve(root, path);
  // An empty relative path means the file resolved to the root itself, which is
  // a directory rather than anything writable.
  if (relative(root, absolutePath).length === 0 || !isWithinRoot(root, absolutePath)) {
    return { writable: false, detail: `${path} resolves outside the reviewed repository.` };
  }

  return { writable: true, path, absolutePath };
}

/**
 * Resolve one reviewed file id and side into the read that would answer it.
 *
 * Reads are not gated the way writes are: every review kind shows the user
 * source documents, so reading one back is never more than the review already
 * discloses. What is left is a lookup, and `null` is its ordinary answer — no
 * reviewed file carries the id, or the file it names has no reachable source.
 *
 * Returning the bound read rather than its text keeps the policy free of the
 * filesystem: the caller decides what a rejected read means (it resolves
 * `null`), and the caching the fetcher already does is not duplicated here.
 *
 * A `side` that is neither `"old"` nor `"new"` throws, the way a malformed
 * write request does: it is a bug in the extension, not a fact about the review.
 */
export function resolveExtensionWorkspaceRead({
  fileId,
  files,
  side,
}: {
  fileId: string;
  /** The full current changeset, unfiltered: a hidden file is still a reviewed file. */
  files: readonly WorkspaceFileSource[];
  side: unknown;
}): WorkspaceDocumentRead | null {
  if (side !== "old" && side !== "new") {
    throw new Error('workspace.readDocument requires side to be "old" or "new".');
  }

  const fetcher = files.find((candidate) => candidate.id === fileId)?.sourceFetcher;
  return fetcher ? () => fetcher.getFullText(side) : null;
}
