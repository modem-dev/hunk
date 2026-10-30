import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { buildGitMetadataTargets } from "./watchTargets";
import type { ExtensionVcsDirectoryTreeWatchTarget } from "hunkdiff/extension";

/** Build the complete expected metadata target, including the object-store exclusion. */
function createTestMetadataTarget(directory: string): ExtensionVcsDirectoryTreeWatchTarget {
  return {
    kind: "directory-tree",
    directory,
    ignoredRoots: [join(directory, "objects")],
    sources: ["vcs-metadata"],
  };
}

test("metadata targets collapse ordinary and nested linked-worktree directories", () => {
  const common = resolve("fixture", ".git");
  for (const gitDir of [common, join(common, "worktrees", "linked"), join(common, "..legal")])
    expect(buildGitMetadataTargets(gitDir, common)).toEqual([createTestMetadataTarget(common)]);
});

test("metadata targets retain separate directories without textual-prefix containment", () => {
  const common = resolve("fixture", ".git");
  for (const gitDir of [resolve("fixture", ".git-other"), resolve("external", "git-dir")])
    expect(buildGitMetadataTargets(gitDir, common)).toEqual([
      createTestMetadataTarget(gitDir),
      createTestMetadataTarget(common),
    ]);
});
