/**
 * The filesystem half of the workspace write policy: the part of "confined to
 * the review root" that only a syscall can answer.
 *
 * `resolveExtensionWorkspaceWriteTarget` confines the target lexically, which
 * is exactly as true as the assumption that a reviewed path names a real file
 * inside the root. Git tracks a symlink to a file as an ordinary reviewable
 * entry, so a reviewed path can *be* a link, or sit under a linked directory,
 * and a plain `writeFile` would follow it out of the repository while the
 * confirm dialog showed nothing but the repo-relative name.
 *
 * This runs after the lexical resolve both before the dialog and again after
 * consent, so Hunk neither asks about an already-invalid target nor follows a
 * target that became unsafe while the user was deciding. No portable single syscall
 * closes the final check/write window across every supported platform; the
 * check keeps the reviewed working tree's own layout honest rather than
 * defending against a racing local attacker.
 */

import { lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { isWithinRoot } from "./extensionWorkspace";

/** Read an error's message without assuming the filesystem throws `Error`s. */
function describeFsError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
}

/**
 * Verify one already-resolved write target against the filesystem.
 *
 * Resolves the `"unavailable"` refusal sentence for a target that must not be
 * written, or `null` when the write may be proposed to the user. Every refusal
 * names the reviewed path the way the review does, so the extension and the
 * user read the same file name a prompt would have shown.
 *
 * A target that no longer exists is refused rather than created: every writable
 * file here is a file the review loaded from the working tree, so a missing one
 * was deleted after the review was built, and recreating it would undo that
 * deletion under the name of an edit.
 */
export async function verifyWorkspaceWriteTarget({
  absolutePath,
  path,
  root,
}: {
  /** The absolute path the host would write to. */
  absolutePath: string;
  /** The reviewed path, root-relative, as the review and the prompt name it. */
  path: string;
  /** The repo root this review was loaded from, or its working directory. */
  root: string;
}): Promise<string | null> {
  let target: Awaited<ReturnType<typeof lstat>>;
  try {
    // `lstat`, never `stat`: the question is what the reviewed path itself is,
    // not what it points at.
    target = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return `${path} is no longer in the working tree; workspace writes replace reviewed files rather than recreate them.`;
    }

    return `${path} could not be checked before writing • ${describeFsError(error)}`;
  }

  if (target.isSymbolicLink()) {
    return `${path} is a symlink; workspace writes refuse to follow links.`;
  }

  if (!target.isFile()) {
    return `${path} is not a regular file.`;
  }

  // The target is not itself a link, so where it really lives is decided
  // entirely by its parent — resolving that catches a linked directory at any
  // depth above it. Both sides are resolved so a review root that is itself
  // reached through a link (a symlinked checkout, `/tmp` on macOS) still
  // compares equal.
  let realTargetParent: string;
  let realRoot: string;
  try {
    [realTargetParent, realRoot] = await Promise.all([
      realpath(dirname(absolutePath)),
      realpath(root),
    ]);
  } catch (error) {
    return `${path} could not be resolved inside the reviewed repository • ${describeFsError(error)}`;
  }

  if (!isWithinRoot(realRoot, realTargetParent)) {
    return `${path} sits outside the reviewed repository once links resolve.`;
  }

  return null;
}
