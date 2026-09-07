/** Applies a selected canonical Git hunk to the index while leaving the worktree untouched. */
import {
  HunkExtensionUserError,
  type ExtensionDiffHunk,
  type ExtensionVcsDiffInput,
  type ExtensionWorkingTreeFile,
} from "hunkdiff/extension";
import { buildGitDiffArgs, runGitBytes, runGitMutation, runGitText } from "./commands";
import { mutateGitFileStaging, verifyGitWorkingTreeFile } from "./workingTree";

/** Compare numbered spans independently of Git's optional count-one and function-context syntax. */
function hunkCoordinates(header: string) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  return match ? [match[1], match[2] ?? "1", match[3], match[4] ?? "1"].join(":") : null;
}

/** Extract one raw hunk without normalizing CRLF, control bytes, or trailing source whitespace. */
function selectCanonicalHunk(patch: string, hunk: ExtensionDiffHunk, renamed: boolean) {
  const starts = [...patch.matchAll(/^@@ /gm)].map((match) => match.index);
  const start = starts[hunk.index];
  if (!Number.isInteger(hunk.index) || hunk.index < 0 || start === undefined) {
    throw new HunkExtensionUserError(
      "The selected hunk is no longer available. Refresh and try again.",
    );
  }
  const body = patch.slice(start, starts[hunk.index + 1] ?? patch.length);
  const coordinates = hunkCoordinates(body);
  if (!coordinates || coordinates !== hunkCoordinates(hunk.header)) {
    throw new HunkExtensionUserError(
      "The selected hunk changed since the review loaded. Refresh and try again.",
    );
  }
  const headers = patch.slice(0, start).split("\n");
  let oldPath = headers.find((line) => line.startsWith("--- "))?.slice(4);
  const newPath = headers.find((line) => line.startsWith("+++ "))?.slice(4);
  if (!oldPath || !newPath)
    throw new HunkExtensionUserError("This change has no applicable text hunk.");
  // Textual unstage of a rename edits its current index path; it must not undo the filename change.
  if (renamed) oldPath = newPath.replace(/^("?)b\//, "$1a/");
  const diffHeader = renamed
    ? `diff --git ${oldPath.replace(/\t.*$/, "")} ${newPath.replace(/\t.*$/, "")}`
    : headers[0]!;
  const modes = headers.filter((line) => /^(new file mode|deleted file mode) /.test(line));
  return [diffHeader, ...modes, `--- ${oldPath}`, `+++ ${newPath}`, body].join("\n");
}

/** Revalidate status, recover the provider's raw patch, and apply only the requested hunk. */
export async function mutateGitHunkStaging(
  input: ExtensionVcsDiffInput,
  expected: ExtensionWorkingTreeFile,
  hunk: ExtensionDiffHunk,
  context: { cwd: string; gitExecutable?: string },
  stage: boolean,
) {
  const { root, file } = verifyGitWorkingTreeFile(input, expected, context);
  if (input.staged === stage || (stage ? !file.unstaged : !file.staged)) {
    throw new HunkExtensionUserError(
      "The selected hunk is not on the side required by this action.",
    );
  }
  // An untracked text file has one whole-file hunk. Git add also preserves its executable mode.
  if (file.untracked && stage && hunk.index === 0) {
    await mutateGitFileStaging(input, file, context, true);
    return;
  }
  const paths = [file.path, ...(file.previousPath ? [file.previousPath] : [])];
  const args = buildGitDiffArgs({ ...input, pathspecs: paths.map((path) => `:(literal)${path}`) });
  const base = {
    input,
    cwd: root,
    gitExecutable: context.gitExecutable,
    preventOptionalLocks: true,
  };
  // Latin-1 is a byte-preserving view for parsing ASCII patch framing, not a source encoding.
  const patch = runGitBytes({ ...base, args }).toString("latin1");
  const rawArgs = [...args];
  rawArgs.splice(rawArgs.indexOf("--"), 0, "--no-textconv");
  const rawPatch = runGitBytes({ ...base, args: rawArgs }).toString("latin1");
  const namesArgs = [...args];
  namesArgs.splice(namesArgs.indexOf("--"), 0, "--name-only", "-z");
  const names = runGitText({ ...base, args: namesArgs }).split("\0");
  const chunks = patch.split(/(?<=\n)(?=diff --git )/);
  const chunk = chunks[names.indexOf(file.path)];
  if (!chunk) throw new HunkExtensionUserError("The selected file has no applicable text patch.");
  const displayedPatch = selectCanonicalHunk(
    chunk,
    hunk,
    input.staged && Boolean(file.previousPath),
  );
  const rawChunk = rawPatch.split(/(?<=\n)(?=diff --git )/)[names.indexOf(file.path)];
  if (!rawChunk || rawChunk !== chunk) {
    throw new HunkExtensionUserError(
      "Text-converted hunks cannot be staged here. Use the whole-file action instead.",
    );
  }
  // External edits during patch reads must not turn a reviewed action into an unseen one.
  verifyGitWorkingTreeFile(input, expected, context);
  await runGitMutation({
    ...base,
    args: [
      "apply",
      "--cached",
      "--unidiff-zero",
      "--whitespace=nowarn",
      ...(stage ? [] : ["--reverse"]),
      "-",
    ],
    stdin: Buffer.from(displayedPatch, "latin1"),
  });
}
