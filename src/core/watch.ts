import fs from "node:fs";
import { join } from "node:path";
import {
  buildGitDiffArgs,
  buildGitShowArgs,
  buildGitStashShowArgs,
  listGitUntrackedFiles,
  resolveGitRepoRoot,
  runGitText,
} from "./git";
import type { CliInput } from "./types";

/** Return whether the current input can be rebuilt from files or Git state without rereading stdin. */
export function canReloadInput(input: CliInput) {
  if (input.options.agentContext === "-") {
    return false;
  }

  return input.kind !== "patch" || Boolean(input.file && input.file !== "-");
}

/** Format one file stat into a stable signature fragment, or mark the path missing. */
function statSignature(path: string) {
  if (!fs.existsSync(path)) {
    return `${path}:missing`;
  }

  const stat = fs.statSync(path);
  return `${path}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}

/** Build the cheaper watch signature for working-tree git diff inputs without rendering full untracked patches. */
function gitWorkingTreeWatchSignature(input: Extract<CliInput, { kind: "git" }>) {
  const trackedPatch = runGitText({ input, args: buildGitDiffArgs(input) });
  const repoRoot = resolveGitRepoRoot(input);
  const untrackedSignatures = listGitUntrackedFiles(input, { repoRoot }).map(
    (filePath) => `untracked:${statSignature(join(repoRoot, filePath))}`,
  );

  return [trackedPatch, ...untrackedSignatures].join("\n---\n");
}

/** Build one exact patch signature for Git-backed review inputs. */
function gitPatchSignature(input: Extract<CliInput, { kind: "git" | "show" | "stash-show" }>) {
  switch (input.kind) {
    case "git":
      return gitWorkingTreeWatchSignature(input);
    case "show":
      return runGitText({ input, args: buildGitShowArgs(input) });
    case "stash-show":
      return runGitText({ input, args: buildGitStashShowArgs(input) });
  }
}

/** Compute a change-detection signature for one watchable input. */
export function computeWatchSignature(input: CliInput) {
  const parts: string[] = [input.kind];

  switch (input.kind) {
    case "git":
    case "show":
    case "stash-show":
      parts.push(gitPatchSignature(input));
      break;
    case "diff":
    case "difftool":
      parts.push(statSignature(input.left), statSignature(input.right));
      break;
    case "patch":
      if (!input.file || input.file === "-") {
        throw new Error("Watch mode requires a patch file path instead of stdin.");
      }
      parts.push(statSignature(input.file));
      break;
  }

  if (input.options.agentContext && input.options.agentContext !== "-") {
    parts.push(`agent:${statSignature(input.options.agentContext)}`);
  }

  return parts.join("\n---\n");
}
