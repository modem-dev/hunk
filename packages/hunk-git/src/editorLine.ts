/** Validate source coordinates and map staged addresses without changing Git state. */
import {
  HunkExtensionUserError,
  type ExtensionVcsDiffInput,
  type ExtensionWorkingTreeFile,
} from "hunkdiff/extension";
import { buildGitDiffArgs, runGitBytes } from "./commands";
import { verifyGitWorkingTreeFile } from "./workingTree";

/** Resolve insertions, replacements, and deletions to the nearest surviving working-tree line. */
export async function resolveGitWorkingTreeLine(
  input: ExtensionVcsDiffInput,
  file: ExtensionWorkingTreeFile,
  line: number,
  context: { cwd: string; gitExecutable?: string },
): Promise<number> {
  const { root } = verifyGitWorkingTreeFile(input, file, context);
  if (!Number.isInteger(line) || line < 1)
    throw new HunkExtensionUserError("An editor location requires a positive source line.");
  const base = {
    input,
    cwd: root,
    gitExecutable: context.gitExecutable,
    preventOptionalLocks: true,
  };
  const args = buildGitDiffArgs({
    ...input,
    pathspecs: [file.path, ...(file.previousPath ? [file.previousPath] : [])].map(
      (path) => `:(literal)${path}`,
    ),
  });
  const rawArgs = [...args];
  rawArgs.splice(rawArgs.indexOf("--"), 0, "--no-textconv");
  if (!runGitBytes({ ...base, args }).equals(runGitBytes({ ...base, args: rawArgs })))
    throw new HunkExtensionUserError("Cannot map text-converted lines to the working-tree source.");
  if (!input.staged) {
    verifyGitWorkingTreeFile(input, file, context);
    return line;
  }
  const patch = runGitBytes({
    ...base,
    args: [
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=0",
      "--inter-hunk-context=0",
      "--",
      file.path,
    ],
  }).toString("latin1");
  let offset = 0;
  let mapped: number | undefined;
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] ?? 1);
    const newStart = Number(match[3]);
    const newCount = Number(match[4] ?? 1);
    if (oldCount === 0) {
      // A zero-count old span inserts after its numbered line, not before it.
      if (line <= oldStart) break;
    } else {
      if (line < oldStart) break;
      if (line < oldStart + oldCount) {
        mapped = newCount === 0 ? newStart + 1 : newStart + Math.min(line - oldStart, newCount - 1);
        break;
      }
    }
    offset += newCount - oldCount;
  }
  verifyGitWorkingTreeFile(input, file, context);
  return Math.max(1, mapped ?? line + offset);
}
