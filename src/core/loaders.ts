import {
  parseDiffFromFile,
  parsePatchFiles,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import fs from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { findAgentFileContext, loadAgentContext } from "./agent";
import { createSkippedBinaryMetadata, isProbablyBinaryFile } from "./binary";
import {
  buildDiffFile,
  createSkippedLargeMetadata,
  type BuildDiffFileOptions,
  type DiffFileSourceContext,
} from "./diffFile";
import { createFileSourceFetcher, type FileSourceSpec } from "./fileSource";
import { normalizeUntrackedPatchHeaders, runGitUntrackedFileDiffText } from "./git";
import { splitPatchIntoFileChunks, findPatchChunk } from "./patch/chunks";
import {
  escapeUntrackedPatchPath,
  normalizePatchText,
  stripTerminalControl,
} from "./patch/normalize";
import {
  createUnsupportedVcsOperationError,
  findVcsRepoRootCandidate,
  getVcsAdapter,
  operationFromInput,
} from "./vcs";
import type {
  AppBootstrap,
  AgentContext,
  Changeset,
  CliInput,
  CustomThemeConfig,
  DiffFile,
  DiffLineMoveKind,
  DiffLineMoveKinds,
  DiffToolCommandInput,
  FileCommandInput,
  VcsCommandInput,
  PatchCommandInput,
  ShowCommandInput,
  StashShowCommandInput,
} from "./types";

interface LoadAppBootstrapOptions {
  cwd?: string;
  customTheme?: CustomThemeConfig;
  gitExecutable?: string;
}

const LARGE_DIFF_FILE_MAX_BYTES = 1_000_000;
const LARGE_DIFF_FILE_MAX_LINES = 20_000;
const LARGE_DIFF_FILE_SNIFF_BYTES = 256 * 1024;

/** Return the final path segment for display-oriented labels. */
function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

interface ResolvedFileSourceSpecs {
  old: FileSourceSpec;
  new: FileSourceSpec;
}

/** Build a binary-aware source-fetcher factory from per-file source specs. */
function createSourceFetcherBuilder(
  resolveSpecs: (file: DiffFileSourceContext) => ResolvedFileSourceSpecs | undefined,
): NonNullable<BuildDiffFileOptions["sourceFetcherBuilder"]> {
  return (file) => {
    if (file.isBinary) {
      return undefined;
    }

    const specs = resolveSpecs(file);
    return specs ? createFileSourceFetcher(specs) : undefined;
  };
}

/** Return SGR parameter strings that Git emitted before one diff line marker. */
function leadingSgrParameters(rawLine: string, expectedSign: "+" | "-") {
  const parameters: string[] = [];
  let index = 0;

  while (index < rawLine.length) {
    if (rawLine[index] === "\x1b") {
      const csi = rawLine.slice(index).match(/^\x1b\[([0-?]*)([ -/]*)([@-~])/);
      if (csi) {
        if (csi[3] === "m") {
          parameters.push(csi[1] ?? "");
        }
        index += csi[0].length;
        continue;
      }
    }

    return rawLine[index] === expectedSign ? parameters : [];
  }

  return [];
}

/** Return whether one SGR parameter list contains the Git color Hunk reserves for moved lines. */
function sgrContainsColor(parameters: string[], colorCode: "35" | "36") {
  return parameters.some((parameter) => parameter.split(";").includes(colorCode));
}

/** Classify one ANSI-colored Git diff line as moved when it carries Hunk's reserved color. */
function movedLineKindFromAnsi(
  rawLine: string,
  side: "addition" | "deletion",
): DiffLineMoveKind | undefined {
  const colorCode = side === "addition" ? "36" : "35";
  const sign = side === "addition" ? "+" : "-";
  return sgrContainsColor(leadingSgrParameters(rawLine, sign), colorCode) ? "moved" : undefined;
}

/** Capture Git's color-moved ANSI classes before the normal patch parser strips colors. */
function collectLineMoveKinds(patchText: string): DiffLineMoveKinds[] {
  const files: DiffLineMoveKinds[] = [];
  let current: DiffLineMoveKinds | null = null;
  let inHunk = false;
  let additionLineIndex = 0;
  let deletionLineIndex = 0;

  const createFileMoveKinds = () => {
    const moveKinds: DiffLineMoveKinds = { additionLines: [], deletionLines: [] };
    files.push(moveKinds);
    inHunk = false;
    additionLineIndex = 0;
    deletionLineIndex = 0;
    return moveKinds;
  };

  for (const rawLine of patchText.replaceAll("\r\n", "\n").split("\n")) {
    const plainLine = stripTerminalControl(rawLine);

    if (plainLine.startsWith("diff --git ")) {
      current = createFileMoveKinds();
      continue;
    }

    if (!current && (plainLine.startsWith("--- ") || plainLine.startsWith("@@ "))) {
      current = createFileMoveKinds();
    }

    const activeMoveKinds = current;
    if (!activeMoveKinds) {
      continue;
    }

    if (plainLine.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (plainLine.startsWith("+") && !plainLine.startsWith("+++")) {
      activeMoveKinds.additionLines[additionLineIndex] = movedLineKindFromAnsi(rawLine, "addition");
      additionLineIndex += 1;
      continue;
    }

    if (plainLine.startsWith("-") && !plainLine.startsWith("---")) {
      activeMoveKinds.deletionLines[deletionLineIndex] = movedLineKindFromAnsi(rawLine, "deletion");
      deletionLineIndex += 1;
      continue;
    }

    if (plainLine.startsWith(" ")) {
      additionLineIndex += 1;
      deletionLineIndex += 1;
    }
  }

  return files;
}

/** Return whether one file has any captured moved-line classifications. */
function hasLineMoveKinds(moveKinds: DiffLineMoveKinds | undefined) {
  return Boolean(moveKinds?.additionLines.some(Boolean) || moveKinds?.deletionLines.some(Boolean));
}

interface CountedLines {
  complete: boolean;
  lines: number;
}

/** Count text lines with a byte cap so huge skipped-file stats do not block startup. */
function countLinesInFile(path: string, maxBytes: number, size: number): CountedLines {
  let fd: number | undefined;

  try {
    fd = fs.openSync(path, "r");
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes));
    let position = 0;
    let lineCount = 0;
    let lastByte: number | undefined;

    while (position < maxBytes) {
      const bytesToRead = Math.min(buffer.length, maxBytes - position);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead === 0) {
        break;
      }

      position += bytesRead;
      for (let index = 0; index < bytesRead; index += 1) {
        lastByte = buffer[index];
        if (lastByte === 0x0a) {
          lineCount += 1;
        }
      }
    }

    return {
      complete: position >= size,
      lines: lastByte !== undefined && lastByte !== 0x0a ? lineCount + 1 : lineCount,
    };
  } catch {
    return { complete: true, lines: 0 };
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

interface LargeUntrackedFileCheck {
  shouldSkip: boolean;
  stats?: DiffFile["stats"];
  statsTruncated?: boolean;
}

/** Return whether an untracked file is too large to synthesize into a full in-memory patch. */
function inspectLargeUntrackedFile(repoRoot: string, filePath: string): LargeUntrackedFileCheck {
  const absolutePath = join(repoRoot, filePath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return { shouldSkip: false };
  }

  const byteLimit =
    stat.size > LARGE_DIFF_FILE_MAX_BYTES ? LARGE_DIFF_FILE_MAX_BYTES : LARGE_DIFF_FILE_SNIFF_BYTES;
  const counted = countLinesInFile(absolutePath, byteLimit, stat.size);
  const shouldSkip =
    stat.size > LARGE_DIFF_FILE_MAX_BYTES || counted.lines > LARGE_DIFF_FILE_MAX_LINES;

  return {
    shouldSkip,
    stats: shouldSkip ? { additions: counted.lines, deletions: 0 } : undefined,
    statsTruncated: shouldSkip ? !counted.complete : undefined,
  };
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
  input: VcsCommandInput,
  filePath: string,
  index: number,
  repoRoot: string,
  sourcePrefix: string,
  agentContext: AgentContext | null,
  gitExecutable = "git",
) {
  const absolutePath = join(repoRoot, filePath);
  const largeFileCheck = inspectLargeUntrackedFile(repoRoot, filePath);
  if (largeFileCheck.shouldSkip) {
    return buildDiffFile(
      createSkippedLargeMetadata(filePath, "new"),
      "",
      index,
      sourcePrefix,
      agentContext,
      {
        isTooLarge: true,
        isUntracked: true,
        stats: largeFileCheck.stats,
        statsTruncated: largeFileCheck.statsTruncated,
      },
    );
  }

  if (input.options.vcs === "sl") {
    if (isProbablyBinaryFile(absolutePath)) {
      return buildDiffFile(
        createSkippedBinaryMetadata(filePath, "new"),
        `Binary file skipped: ${filePath}\n`,
        index,
        sourcePrefix,
        agentContext,
        { isBinary: true, isUntracked: true },
      );
    }

    const patch = createTwoFilesPatch(
      "/dev/null",
      escapeUntrackedPatchPath(filePath),
      "",
      fs.readFileSync(absolutePath, "utf8"),
      "",
      "",
      { context: 3 },
    ).replaceAll("\r\n", "\n");

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

  const patch = normalizeUntrackedPatchHeaders(
    runGitUntrackedFileDiffText(input, filePath, { repoRoot, gitExecutable }),
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
      sourceFetcherBuilder: createSourceFetcherBuilder(() => ({
        old: { kind: "none" },
        new: { kind: "fs", absolutePath: join(repoRoot, filePath) },
      })),
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
  perFileOptions?: Pick<BuildDiffFileOptions, "sourceFetcherBuilder">,
): Changeset {
  const lineMoveKinds = collectLineMoveKinds(patchText);
  const normalizedPatchText = normalizePatchText(patchText);

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
        {
          ...perFileOptions,
          lineMoveKinds: hasLineMoveKinds(lineMoveKinds[index]) ? lineMoveKinds[index] : undefined,
        },
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
        sourceFetcherBuilder: createSourceFetcherBuilder(() => ({
          old: { kind: "fs", absolutePath: leftPath },
          new: { kind: "fs", absolutePath: rightPath },
        })),
      }),
    ],
  } satisfies Changeset;
}

/** Build a changeset from an adapter-backed VCS review operation. */
async function loadVcsChangeset(
  input: VcsCommandInput | ShowCommandInput | StashShowCommandInput,
  agentContext: AgentContext | null,
  cwd = process.cwd(),
  gitExecutable = "git",
) {
  const adapter = getVcsAdapter(input.options.vcs ?? "git");
  const operation = operationFromInput(input);
  if (!adapter.capabilities.reviewOperations.has(operation.kind)) {
    throw createUnsupportedVcsOperationError(adapter, operation);
  }

  const result = await adapter.loadReview(operation, { cwd, gitExecutable });
  const parsedChangeset = normalizePatchChangeset(
    result.patchText,
    result.title,
    result.sourceLabel,
    agentContext,
    result.sourceFetcherBuilder ? { sourceFetcherBuilder: result.sourceFetcherBuilder } : undefined,
  );
  const adapterFiles = (result.extraFiles ?? []).map((file, index) => ({
    ...file,
    id: `${file.id}:extra:${index}`,
    agent: findAgentFileContext(agentContext, file.path, file.previousPath),
  }));
  const trackedFiles = [...parsedChangeset.files, ...adapterFiles];

  if (operation.kind !== "working-tree-diff" || !result.untrackedFiles?.length) {
    return {
      ...parsedChangeset,
      files: trackedFiles,
    } satisfies Changeset;
  }

  return {
    ...parsedChangeset,
    files: [
      ...trackedFiles,
      ...result.untrackedFiles.map((filePath, index) =>
        buildUntrackedDiffFile(
          operation.input,
          filePath,
          trackedFiles.length + index,
          result.repoRoot,
          result.sourceLabel,
          agentContext,
          gitExecutable,
        ),
      ),
    ],
  } satisfies Changeset;
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
  { cwd = process.cwd(), customTheme, gitExecutable = "git" }: LoadAppBootstrapOptions = {},
): Promise<AppBootstrap> {
  const agentContext = await loadAgentContext(input.options.agentContext, {
    cwd,
  });

  let changeset: Changeset;

  switch (input.kind) {
    case "vcs":
    case "show":
    case "stash-show":
      changeset = await loadVcsChangeset(input, agentContext, cwd, gitExecutable);
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
    repoRoot: findVcsRepoRootCandidate(cwd),
    initialMode: input.options.mode ?? "auto",
    initialTheme: input.options.theme,
    customTheme,
    initialShowLineNumbers: input.options.lineNumbers ?? true,
    initialWrapLines: input.options.wrapLines ?? false,
    initialShowHunkHeaders: input.options.hunkHeaders ?? true,
    initialShowAgentNotes: input.options.agentNotes ?? false,
    initialCopyDecorations: input.options.copyDecorations ?? false,
  };
}
