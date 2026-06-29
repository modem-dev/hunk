import {
  parseDiffFromFile,
  parsePatchFiles,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import { resolve as resolvePath } from "node:path";
import { findAgentFileContext, loadAgentContext } from "./agent";
import { createSkippedBinaryMetadata, isProbablyBinaryFile } from "./binary";
import { buildDiffFile, type BuildDiffFileOptions, type DiffFileSourceContext } from "./diffFile";
import { createFileSourceFetcher, type FileSourceSpec } from "./fileSource";
import { splitPatchIntoFileChunks, findPatchChunk } from "./patch/chunks";
import { normalizePatchText, stripTerminalControl } from "./patch/normalize";
import { getConfiguredVcsAdapter, loadVcsReview, operationFromInput } from "./vcs";
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
  PatchCommandInput,
  VcsShowCommandInput,
  VcsDiffCommandInput,
  VcsStashShowCommandInput,
} from "./types";

interface LoadAppBootstrapOptions {
  cwd?: string;
  customTheme?: CustomThemeConfig;
  gitExecutable?: string;
}

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
  input: VcsDiffCommandInput | VcsShowCommandInput | VcsStashShowCommandInput,
  agentContext: AgentContext | null,
  cwd = process.cwd(),
  gitExecutable = "git",
) {
  const adapter = getConfiguredVcsAdapter(input.options.vcs);
  const operation = operationFromInput(input);
  const result = await loadVcsReview(adapter, operation, { cwd, gitExecutable });
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
  return {
    ...parsedChangeset,
    files: [...parsedChangeset.files, ...adapterFiles],
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
    userNotesSidecarPath: input.options.storeNotes
      ? resolvePath(cwd, input.options.storeNotes)
      : undefined,
    initialMode: input.options.mode ?? "auto",
    initialTheme: input.options.theme,
    customTheme,
    initialShowLineNumbers: input.options.lineNumbers ?? true,
    initialWrapLines: input.options.wrapLines ?? false,
    initialShowHunkHeaders: input.options.hunkHeaders ?? true,
    initialShowMenuBar: input.options.menuBar ?? true,
    initialShowAgentNotes: input.options.agentNotes ?? false,
    initialCopyDecorations: input.options.copyDecorations ?? false,
  };
}
