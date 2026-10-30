import { isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionVcsDirectoryTreeWatchTarget } from "hunkdiff/extension";

/** Return whether a recursive directory target safely covers another directory. */
function directoryContains(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Build metadata targets, collapsing linked-worktree state under its common Git directory. */
export function buildGitMetadataTargets(
  gitDir: string,
  commonDir: string,
): ExtensionVcsDirectoryTreeWatchTarget[] {
  const directories = directoryContains(commonDir, gitDir) ? [commonDir] : [gitDir, commonDir];
  return directories.map((directory) => ({
    kind: "directory-tree",
    directory,
    ignoredRoots: [join(directory, "objects")],
    sources: ["vcs-metadata"],
  }));
}
