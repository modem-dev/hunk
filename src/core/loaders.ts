import {
  getFiletypeFromFileName,
  parseDiffFromFile,
  parsePatchFiles,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import { resolve as resolvePath } from "node:path";
import { findAgentFileContext, loadAgentContext } from "./agent";
import { createSkippedBinaryMetadata, isProbablyBinaryFile, patchLooksBinary } from "./binary";
import { normalizeDiffMetadataPaths, normalizeDiffPath } from "./diffPaths";
import {
  buildGitDiffArgs,
  buildGitShowArgs,
  buildGitStashShowArgs,
  listGitUntrackedFiles,
  resolveGitRepoRoot,
  runGitText,
  runGitUntrackedFileDiffText,
} from "./git";
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

interface LoadAppBootstrapOptions {
  cwd?: string;
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
        .map(normalizeDiffPath)
        .filter((value): value is string => Boolean(value))
        .map(stripPrefixes)
        .some(
          (path) =>
            chunk.includes(`a/${path}`) || chunk.includes(`b/${path}`) || chunk.includes(path),
        ),
    ) ?? ""
  );
}

interface BuildDiffFileOptions {
  isUntracked?: boolean;
  previousPath?: string;
  isBinary?: boolean;
}

/** Build the normalized per-file model used by the UI regardless of input mode. */
function buildDiffFile(
  metadata: FileDiffMetadata,
  patch: string,
  index: number,
  sourcePrefix: string,
  agentContext: AgentContext | null,
  { isUntracked, previousPath, isBinary }: BuildDiffFileOptions = {},
): DiffFile {
  const normalizedMetadata = normalizeDiffMetadataPaths(metadata);
  const path = normalizedMetadata.name;
  const resolvedPreviousPath = normalizeDiffPath(previousPath) ?? normalizedMetadata.prevName;

  return {
    id: `${sourcePrefix}:${index}:${path}`,
    path,
    previousPath: resolvedPreviousPath,
    patch,
    language: getFiletypeFromFileName(path) ?? undefined,
    stats: countDiffStats(normalizedMetadata),
    metadata: normalizedMetadata,
    agent: findAgentFileContext(agentContext, path, resolvedPreviousPath),
    isUntracked,
    isBinary: isBinary ?? patchLooksBinary(patch),
  };
}

/** Escape only the filename characters that break unified-diff header parsing. */
function escapeUntrackedPatchPath(path: string) {
  return path
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

/** Rewrite Git's quoted untracked-file headers into parser-friendly paths. */
function normalizeUntrackedPatchHeaders(patchText: string, filePath: string) {
  const safePath = escapeUntrackedPatchPath(filePath);

  return patchText
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        return `diff --git a/${safePath} b/${safePath}`;
      }

      if (line.startsWith("+++ ")) {
        return `+++ b/${safePath}`;
      }

      if (line.startsWith("Binary files /dev/null and ")) {
        return `Binary files /dev/null and b/${safePath} differ`;
      }

      return line;
    })
    .join("\n");
}

/** Parse one synthetic untracked-file patch and reattach the real path after header normalization. */
function parseUntrackedPatchFile(patchText: string, filePath: string) {
  let parsedPatches: ReturnType<typeof parsePatchFiles>;

  try {
    parsedPatches = parsePatchFiles(patchText, "patch", true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse untracked file patch for ${JSON.stringify(filePath)}: ${message}`,
    );
  }

  const metadataFiles = parsedPatches.flatMap((entry) => entry.files);
  if (metadataFiles.length !== 1) {
    throw new Error(
      `Expected one parsed file for untracked patch ${JSON.stringify(filePath)}, got ${metadataFiles.length}.`,
    );
  }

  const metadata = metadataFiles[0]!;
  return {
    ...metadata,
    name: filePath,
    prevName: undefined,
  } satisfies FileDiffMetadata;
}

/** Build one reviewable diff file for an untracked working-tree file. */
function buildUntrackedDiffFile(
  input: GitCommandInput,
  filePath: string,
  index: number,
  repoRoot: string,
  sourcePrefix: string,
  agentContext: AgentContext | null,
) {
  const patch = normalizeUntrackedPatchHeaders(
    runGitUntrackedFileDiffText(input, filePath, { repoRoot }),
    filePath,
  );

  return buildDiffFile(
    parseUntrackedPatchFile(patch, filePath),
    patch,
    index,
    sourcePrefix,
    agentContext,
    {
      isUntracked: true,
    },
  );
}

/** Reorder files to follow agent-context narrative order when a sidecar provides one. */
export function orderDiffFiles(files: DiffFile[], agentContext: AgentContext | null) {
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

/** Return the change type to show when direct file comparison skips binary contents. */
function resolveBinaryComparisonType(
  leftPath: string,
  rightPath: string,
): FileDiffMetadata["type"] {
  if (leftPath === "/dev/null") {
    return "new";
  }

  if (rightPath === "/dev/null") {
    return "deleted";
  }

  return "change";
}

/** Build a placeholder changeset for direct file comparisons that include binary content. */
function buildBinaryFileDiffChangeset(
  input: FileCommandInput | DiffToolCommandInput,
  displayPath: string,
  title: string,
  leftPath: string,
  rightPath: string,
  agentContext: AgentContext | null,
) {
  return {
    id: `pair:${displayPath}`,
    sourceLabel: input.kind === "difftool" ? "git difftool" : "file compare",
    title,
    agentSummary: agentContext?.summary,
    files: [
      buildDiffFile(
        createSkippedBinaryMetadata(displayPath, resolveBinaryComparisonType(leftPath, rightPath)),
        `Binary file skipped: ${basename(input.left)} ↔ ${basename(input.right)}\n`,
        0,
        displayPath,
        agentContext,
        {
          previousPath: basename(input.left),
          isBinary: true,
        },
      ),
    ],
  } satisfies Changeset;
}

/** Build a changeset by diffing two concrete files on disk. */
async function loadFileDiffChangeset(
  input: FileCommandInput | DiffToolCommandInput,
  agentContext: AgentContext | null,
  cwd = process.cwd(),
) {
  const leftPath = resolvePath(cwd, input.left);
  const rightPath = resolvePath(cwd, input.right);
  const displayPath =
    input.kind === "difftool" ? (input.path ?? basename(input.right)) : basename(input.right);
  const title =
    input.kind === "difftool"
      ? `git difftool: ${displayPath}`
      : input.left === input.right
        ? displayPath
        : `${basename(input.left)} ↔ ${basename(input.right)}`;

  if (isProbablyBinaryFile(leftPath) || isProbablyBinaryFile(rightPath)) {
    return buildBinaryFileDiffChangeset(
      input,
      displayPath,
      title,
      leftPath,
      rightPath,
      agentContext,
    );
  }

  const leftText = await Bun.file(leftPath).text();
  const rightText = await Bun.file(rightPath).text();
  const oldFile: FileContents = {
    name: displayPath,
    contents: leftText,
    cacheKey: `${leftPath}:left`,
  };
  const newFile: FileContents = {
    name: displayPath,
    contents: rightText,
    cacheKey: `${rightPath}:right`,
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
    files: [
      buildDiffFile(metadata, patch, 0, displayPath, agentContext, {
        previousPath: basename(input.left),
      }),
    ],
  } satisfies Changeset;
}

/** Build a changeset from the current repository working tree or a git range. */
async function loadGitChangeset(
  input: GitCommandInput,
  agentContext: AgentContext | null,
  cwd = process.cwd(),
) {
  const repoRoot = resolveGitRepoRoot(input, { cwd });
  const repoName = basename(repoRoot);
  const title = input.staged
    ? `${repoName} staged changes`
    : input.range
      ? `${repoName} ${input.range}`
      : `${repoName} working tree`;
  const trackedChangeset = normalizePatchChangeset(
    runGitText({ input, args: buildGitDiffArgs(input), cwd }),
    title,
    repoRoot,
    agentContext,
  );
  const trackedFiles = trackedChangeset.files;
  const untrackedFiles = listGitUntrackedFiles(input, { cwd, repoRoot });

  if (untrackedFiles.length === 0) {
    return trackedChangeset;
  }

  return {
    ...trackedChangeset,
    files: [
      ...trackedFiles,
      ...untrackedFiles.map((filePath, index) =>
        buildUntrackedDiffFile(
          input,
          filePath,
          trackedFiles.length + index,
          repoRoot,
          repoRoot,
          agentContext,
        ),
      ),
    ],
  } satisfies Changeset;
}

/** Build a changeset from `git show`, suppressing commit-message chrome so only the patch feeds the UI. */
async function loadShowChangeset(
  input: ShowCommandInput,
  agentContext: AgentContext | null,
  cwd = process.cwd(),
) {
  const repoRoot = resolveGitRepoRoot(input, { cwd });
  const repoName = basename(repoRoot);

  return normalizePatchChangeset(
    runGitText({ input, args: buildGitShowArgs(input), cwd }),
    input.ref ? `${repoName} show ${input.ref}` : `${repoName} show HEAD`,
    repoRoot,
    agentContext,
  );
}

/** Build a changeset from `git stash show -p`, which naturally maps to one reviewable patch. */
async function loadStashShowChangeset(
  input: StashShowCommandInput,
  agentContext: AgentContext | null,
  cwd = process.cwd(),
) {
  const repoRoot = resolveGitRepoRoot(input, { cwd });
  const repoName = basename(repoRoot);

  return normalizePatchChangeset(
    runGitText({ input, args: buildGitStashShowArgs(input), cwd }),
    input.ref ? `${repoName} stash ${input.ref}` : `${repoName} stash`,
    repoRoot,
    agentContext,
  );
}

/** Build a changeset from patch text supplied by file or stdin. */
async function loadPatchChangeset(
  input: PatchCommandInput,
  agentContext: AgentContext | null,
  cwd = process.cwd(),
) {
  const patchText =
    input.text ??
    (!input.file || input.file === "-"
      ? await new Response(Bun.stdin.stream()).text()
      : await Bun.file(resolvePath(cwd, input.file)).text());

  const label = input.file && input.file !== "-" ? input.file : "stdin patch";
  return normalizePatchChangeset(
    patchText,
    `Patch review: ${basename(label)}`,
    label,
    agentContext,
  );
}

/** Resolve CLI input into the fully loaded app bootstrap state. */
export async function loadAppBootstrap(
  input: CliInput,
  { cwd = process.cwd() }: LoadAppBootstrapOptions = {},
): Promise<AppBootstrap> {
  const agentContext = await loadAgentContext(input.options.agentContext, { cwd });

  let changeset: Changeset;

  switch (input.kind) {
    case "git":
      changeset = await loadGitChangeset(input, agentContext, cwd);
      break;
    case "show":
      changeset = await loadShowChangeset(input, agentContext, cwd);
      break;
    case "stash-show":
      changeset = await loadStashShowChangeset(input, agentContext, cwd);
      break;
    case "diff":
      changeset = await loadFileDiffChangeset(input, agentContext, cwd);
      break;
    case "patch":
      changeset = await loadPatchChangeset(input, agentContext, cwd);
      break;
    case "difftool":
      changeset = await loadFileDiffChangeset(input, agentContext, cwd);
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
