import {
  getFiletypeFromFileName,
  parseDiffFromFile,
  parsePatchFiles,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import { findAgentFileContext, loadAgentContext } from "./agent";
import type {
  AppBootstrap,
  AgentContext,
  Changeset,
  CliInput,
  DiffFile,
  DiffToolCommandInput,
  FileCommandInput,
  GitCommandInput,
  PatchCommandInput,
  ShowCommandInput,
  StashShowCommandInput,
} from "./types";

/** Run a command synchronously and return stdout as text. */
function spawnText(cmd: string[], cwd = process.cwd()) {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(proc.stdout).toString("utf8");
  const stderr = Buffer.from(proc.stderr).toString("utf8");

  if (proc.exitCode !== 0) {
    throw new Error(stderr.trim() || `Command failed: ${cmd.join(" ")}`);
  }

  return stdout;
}

/** Return the final path segment for display-oriented labels. */
function basename(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** Remove git-style a/ and b/ prefixes before matching diff paths. */
function stripPrefixes(path: string) {
  return path.replace(/^[ab]\//, "");
}

/** Remove terminal escape sequences so Git-colored pager input still parses as plain patch text. */
function stripTerminalControl(text: string) {
  return text
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

/** Split a multi-file patch into per-file chunks so each diff file keeps its original patch text. */
function splitPatchIntoFileChunks(rawPatch: string) {
  const patch = rawPatch.replaceAll("\r\n", "\n");
  const lines = patch.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  const hasGitHeaders = lines.some((line) => line.startsWith("diff --git "));

  const flush = () => {
    if (current.length > 0) {
      chunks.push(`${current.join("\n").trimEnd()}\n`);
      current = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (hasGitHeaders && line.startsWith("diff --git ")) {
      flush();
      current.push(line);
      continue;
    }

    if (!hasGitHeaders && line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      flush();
      current.push(line);
      current.push(lines[index + 1]!);
      index += 1;
      continue;
    }

    if (current.length > 0) {
      current.push(line);
    }
  }

  flush();
  return chunks;
}

/** Count visible additions and deletions from parsed diff metadata. */
function countDiffStats(metadata: FileDiffMetadata) {
  let additions = 0;
  let deletions = 0;

  for (const hunk of metadata.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "change") {
        additions += content.additions;
        deletions += content.deletions;
      }
    }
  }

  return { additions, deletions };
}

/** Recover the original patch chunk for one parsed file, preferring index order before path matching. */
function findPatchChunk(metadata: FileDiffMetadata, chunks: string[], index: number) {
  const byIndex = chunks[index];
  if (byIndex) {
    return byIndex;
  }

  return (
    chunks.find((chunk) =>
      [metadata.name, metadata.prevName]
        .filter((value): value is string => Boolean(value))
        .map(stripPrefixes)
        .some(
          (path) =>
            chunk.includes(`a/${path}`) || chunk.includes(`b/${path}`) || chunk.includes(path),
        ),
    ) ?? ""
  );
}

/** Build the normalized per-file model used by the UI regardless of input mode. */
function buildDiffFile(
  metadata: FileDiffMetadata,
  patch: string,
  index: number,
  sourcePrefix: string,
  agentContext: AgentContext | null,
  previousPath?: string,
): DiffFile {
  return {
    id: `${sourcePrefix}:${index}:${metadata.name}`,
    path: metadata.name,
    previousPath: previousPath ?? metadata.prevName,
    patch,
    language: getFiletypeFromFileName(metadata.name) ?? undefined,
    stats: countDiffStats(metadata),
    metadata,
    agent: findAgentFileContext(agentContext, metadata.name, metadata.prevName),
  };
}

/** Reorder files to follow agent-context narrative order when a sidecar provides one. */
function orderDiffFiles(files: DiffFile[], agentContext: AgentContext | null) {
  if (!agentContext || agentContext.files.length === 0) {
    return files;
  }

  const ranks = new Map<string, number>();

  agentContext.files.forEach((file, index) => {
    if (!ranks.has(file.path)) {
      ranks.set(file.path, index);
    }
  });

  return files
    .map((file, index) => {
      const rankCandidates = [file.path, file.previousPath]
        .filter((path): path is string => Boolean(path))
        .map((path) => ranks.get(path))
        .filter((rank): rank is number => rank !== undefined);

      return {
        file,
        index,
        rank: rankCandidates.length > 0 ? Math.min(...rankCandidates) : Number.POSITIVE_INFINITY,
      };
    })
    .sort((left, right) => {
      if (left.rank !== right.rank) {
        return left.rank - right.rank;
      }

      return left.index - right.index;
    })
    .map((entry) => entry.file);
}

/** Parse raw patch text into the shared changeset model used by the app. */
function normalizePatchChangeset(
  patchText: string,
  title: string,
  sourceLabel: string,
  agentContext: AgentContext | null,
): Changeset {
  const normalizedPatchText = stripTerminalControl(patchText.replaceAll("\r\n", "\n"));

  let parsedPatches: ReturnType<typeof parsePatchFiles>;
  try {
    parsedPatches = parsePatchFiles(normalizedPatchText, "patch", true);
  } catch {
    return {
      id: `changeset:${Date.now()}`,
      sourceLabel,
      title,
      summary: normalizedPatchText.trim() || undefined,
      agentSummary: agentContext?.summary,
      files: [],
    };
  }

  const metadataFiles = parsedPatches.flatMap((entry) => entry.files);
  const chunks = splitPatchIntoFileChunks(normalizedPatchText);

  return {
    id: `changeset:${Date.now()}`,
    sourceLabel,
    title,
    summary:
      parsedPatches
        .map((entry) => entry.patchMetadata)
        .filter(Boolean)
        .join("\n\n") || undefined,
    agentSummary: agentContext?.summary,
    files: metadataFiles.map((metadata, index) =>
      buildDiffFile(
        metadata,
        findPatchChunk(metadata, chunks, index),
        index,
        sourceLabel,
        agentContext,
      ),
    ),
  };
}

/** Build a changeset by diffing two concrete files on disk. */
async function loadFileDiffChangeset(
  input: FileCommandInput | DiffToolCommandInput,
  agentContext: AgentContext | null,
) {
  const leftText = await Bun.file(input.left).text();
  const rightText = await Bun.file(input.right).text();
  const displayPath =
    input.kind === "difftool" ? (input.path ?? basename(input.right)) : basename(input.right);
  const title =
    input.kind === "difftool"
      ? `git difftool: ${displayPath}`
      : input.left === input.right
        ? displayPath
        : `${basename(input.left)} ↔ ${basename(input.right)}`;

  const oldFile: FileContents = {
    name: displayPath,
    contents: leftText,
    cacheKey: `${input.left}:left`,
  };
  const newFile: FileContents = {
    name: displayPath,
    contents: rightText,
    cacheKey: `${input.right}:right`,
  };

  const metadata = parseDiffFromFile(oldFile, newFile, { context: 3 }, true);
  const patch = createTwoFilesPatch(displayPath, displayPath, leftText, rightText, "", "", {
    context: 3,
  });

  return {
    id: `pair:${displayPath}`,
    sourceLabel: input.kind === "difftool" ? "git difftool" : "file compare",
    title,
    agentSummary: agentContext?.summary,
    files: [buildDiffFile(metadata, patch, 0, displayPath, agentContext, basename(input.left))],
  } satisfies Changeset;
}

/** Append Git pathspec arguments only when the caller requested them. */
function appendPathspecs(args: string[], pathspecs?: string[]) {
  if (!pathspecs || pathspecs.length === 0) {
    return;
  }

  args.push("--", ...pathspecs);
}

/** Build a changeset from the current repository working tree or a git range. */
async function loadGitChangeset(input: GitCommandInput, agentContext: AgentContext | null) {
  const repoRoot = spawnText(["git", "rev-parse", "--show-toplevel"]).trim();
  const repoName = basename(repoRoot);
  const args = ["git", "diff", "--no-ext-diff", "--find-renames", "--no-color"];

  if (input.staged) {
    args.push("--staged");
  }

  if (input.range) {
    args.push(input.range);
  }

  appendPathspecs(args, input.pathspecs);

  const patchText = spawnText(args);
  const title = input.staged
    ? `${repoName} staged changes`
    : input.range
      ? `${repoName} ${input.range}`
      : `${repoName} working tree`;

  return normalizePatchChangeset(patchText, title, repoRoot, agentContext);
}

/** Build a changeset from `git show`, suppressing commit-message chrome so only the patch feeds the UI. */
async function loadShowChangeset(input: ShowCommandInput, agentContext: AgentContext | null) {
  const repoRoot = spawnText(["git", "rev-parse", "--show-toplevel"]).trim();
  const repoName = basename(repoRoot);
  const args = ["git", "show", "--format=", "--no-ext-diff", "--find-renames", "--no-color"];

  if (input.ref) {
    args.push(input.ref);
  }

  appendPathspecs(args, input.pathspecs);

  return normalizePatchChangeset(
    spawnText(args),
    input.ref ? `${repoName} show ${input.ref}` : `${repoName} show HEAD`,
    repoRoot,
    agentContext,
  );
}

/** Build a changeset from `git stash show -p`, which naturally maps to one reviewable patch. */
async function loadStashShowChangeset(
  input: StashShowCommandInput,
  agentContext: AgentContext | null,
) {
  const repoRoot = spawnText(["git", "rev-parse", "--show-toplevel"]).trim();
  const repoName = basename(repoRoot);
  const args = ["git", "stash", "show", "-p", "--find-renames", "--no-color"];

  if (input.ref) {
    args.push(input.ref);
  }

  return normalizePatchChangeset(
    spawnText(args),
    input.ref ? `${repoName} stash ${input.ref}` : `${repoName} stash`,
    repoRoot,
    agentContext,
  );
}

/** Build a changeset from patch text supplied by file or stdin. */
async function loadPatchChangeset(input: PatchCommandInput, agentContext: AgentContext | null) {
  const patchText =
    input.text ??
    (!input.file || input.file === "-"
      ? await new Response(Bun.stdin.stream()).text()
      : await Bun.file(input.file).text());

  const label = input.file && input.file !== "-" ? input.file : "stdin patch";
  return normalizePatchChangeset(
    patchText,
    `Patch review: ${basename(label)}`,
    label,
    agentContext,
  );
}

/** Resolve CLI input into the fully loaded app bootstrap state. */
export async function loadAppBootstrap(input: CliInput): Promise<AppBootstrap> {
  const agentContext = await loadAgentContext(input.options.agentContext);

  let changeset: Changeset;

  switch (input.kind) {
    case "git":
      changeset = await loadGitChangeset(input, agentContext);
      break;
    case "show":
      changeset = await loadShowChangeset(input, agentContext);
      break;
    case "stash-show":
      changeset = await loadStashShowChangeset(input, agentContext);
      break;
    case "diff":
      changeset = await loadFileDiffChangeset(input, agentContext);
      break;
    case "patch":
      changeset = await loadPatchChangeset(input, agentContext);
      break;
    case "difftool":
      changeset = await loadFileDiffChangeset(input, agentContext);
      break;
  }

  changeset = {
    ...changeset,
    files: orderDiffFiles(changeset.files, agentContext),
  };

  return {
    input,
    changeset,
    initialMode: input.options.mode ?? "auto",
    initialTheme: input.options.theme,
    initialShowLineNumbers: input.options.lineNumbers ?? true,
    initialWrapLines: input.options.wrapLines ?? false,
    initialShowHunkHeaders: input.options.hunkHeaders ?? true,
    initialShowAgentNotes: input.options.agentNotes ?? false,
  };
}
