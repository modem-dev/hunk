/**
 * Builds the changeset model from patch text, without touching the outside world.
 *
 * Every input mode converges here: a VCS spawn, a two-file comparison, and a patch read from
 * disk or stdin all end up as text, and this module is the one that turns text into
 * `DiffFile`s. Keeping it apart from `loaders.ts` keeps the parse pure — the
 * loaders own the I/O, this owns the model.
 *
 * Moved-line capture has to run before sanitizing: Git marks moved lines only through SGR
 * color, which `sanitizePatch` strips on its way to parser-safe text.
 */
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { buildDiffFile, type BuildDiffFileOptions } from "./diffFile";
import { splitPatchIntoFileChunks, findPatchChunk } from "../patch/chunks";
import { sanitizePatch, stripTerminalControl } from "../patch/sanitize";
import type { SanitizedGitPatch } from "../patch/gitFormat";
import type {
  Changeset,
  DiffFile,
  DiffLineMoveKind,
  DiffLineMoveKinds,
  SidecarContext,
} from "./model";

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

/** Parse raw patch text into the shared changeset model used by the app. */
export function changesetFromPatch(
  patchText: string,
  title: string,
  sourceLabel: string,
  sidecar: SidecarContext | null,
  perFileOptions?: Pick<BuildDiffFileOptions, "sourceFetcherBuilder">,
): Changeset {
  const lineMoveKinds = collectLineMoveKinds(patchText);
  const sanitizedPatch = sanitizePatch(patchText);
  const sanitizedPatchText = sanitizedPatch.text;

  let parsedPatches: ReturnType<typeof parsePatchFiles>;
  try {
    parsedPatches = parsePatchFiles(sanitizedPatchText, "patch", true);
  } catch {
    // One unparseable file must not discard the whole review: fall back to
    // per-file parsing so every salvageable file still renders.
    return changesetFromPatchChunks(
      sanitizedPatch,
      lineMoveKinds,
      title,
      sourceLabel,
      sidecar,
      perFileOptions,
    );
  }

  const metadataFiles = parsedPatches.flatMap((entry) => entry.files);
  const chunks = splitPatchIntoFileChunks(sanitizedPatchText);

  return {
    id: `changeset:${Date.now()}`,
    sourceLabel,
    title,
    summary:
      parsedPatches
        .map((entry) => entry.patchMetadata)
        .filter(Boolean)
        .join("\n\n") || undefined,
    agentSummary: sidecar?.summary,
    files: metadataFiles.map((metadata, index) => {
      const decodedPaths = sanitizedPatch.filePaths[index];
      const normalizedMetadata = decodedPaths
        ? { ...metadata, name: decodedPaths.path, prevName: decodedPaths.previousPath }
        : metadata;

      return buildDiffFile(
        normalizedMetadata,
        findPatchChunk(metadata, chunks, index),
        index,
        sourceLabel,
        sidecar,
        {
          ...perFileOptions,
          pathsAreExact: Boolean(decodedPaths),
          lineMoveKinds: hasLineMoveKinds(lineMoveKinds[index]) ? lineMoveKinds[index] : undefined,
        },
      );
    }),
  };
}

/**
 * Best-effort display name for a chunk the parser rejected.
 *
 * Headers reaching this fallback are already sanitized toward the `a/X b/Y`
 * shape, so the b-side names the file. This is display-only (the placeholder
 * carries no hunks), so an even token split is acceptable where Git itself
 * would call the rename genuinely ambiguous.
 */
function displayNameForUnparseableChunk(chunk: string, index: number): string {
  const firstLine = chunk.split("\n", 1)[0] ?? "";
  const rest = firstLine.startsWith("diff --git ") ? firstLine.slice("diff --git ".length) : "";
  if (rest) {
    const tokens = rest.split(" ");
    const secondHalf = tokens.slice(Math.ceil(tokens.length / 2)).join(" ");
    const name = secondHalf.replace(/^"?b\//, "").replace(/"$/, "");
    if (name) {
      return name;
    }
  }
  return `unparseable-file-${index + 1}`;
}

/** Build a placeholder for one file chunk that failed to parse, keeping its review slot. */
function buildSkippedUnparseableFile(
  name: string,
  index: number,
  sourceLabel: string,
  sidecar: SidecarContext | null,
  perFileOptions?: Pick<BuildDiffFileOptions, "sourceFetcherBuilder">,
  lineMoveKinds?: DiffLineMoveKinds,
): DiffFile {
  const metadata: FileDiffMetadata = {
    name,
    type: "change",
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    additionLines: [],
    deletionLines: [],
    cacheKey: `${name}:unparseable-skipped`,
  };
  return buildDiffFile(
    metadata,
    `Skipped file with unparseable diff content: ${name}\n`,
    index,
    sourceLabel,
    sidecar,
    {
      ...perFileOptions,
      pathsAreExact: true,
      lineMoveKinds,
    },
  );
}

/** Re-parse per file chunk after a whole-patch parse failure, preserving good files. */
function changesetFromPatchChunks(
  sanitizedPatch: SanitizedGitPatch,
  lineMoveKinds: DiffLineMoveKinds[],
  title: string,
  sourceLabel: string,
  sidecar: SidecarContext | null,
  perFileOptions?: Pick<BuildDiffFileOptions, "sourceFetcherBuilder">,
): Changeset {
  const chunks = splitPatchIntoFileChunks(sanitizedPatch.text);
  const files: DiffFile[] = [];
  const summaries: string[] = [];
  let index = 0;

  const pushParsedFile = (metadata: FileDiffMetadata) => {
    const decodedPaths = sanitizedPatch.filePaths[index];
    const normalizedMetadata = decodedPaths
      ? { ...metadata, name: decodedPaths.path, prevName: decodedPaths.previousPath }
      : metadata;
    files.push(
      buildDiffFile(
        normalizedMetadata,
        findPatchChunk(metadata, chunks, index),
        index,
        sourceLabel,
        sidecar,
        {
          ...perFileOptions,
          pathsAreExact: Boolean(decodedPaths),
          lineMoveKinds: hasLineMoveKinds(lineMoveKinds[index]) ? lineMoveKinds[index] : undefined,
        },
      ),
    );
    index += 1;
  };

  for (const chunk of chunks) {
    let parsed: ReturnType<typeof parsePatchFiles> | undefined;
    try {
      parsed = parsePatchFiles(chunk, "patch", true);
    } catch {
      parsed = undefined;
    }
    const chunkFiles =
      parsed?.flatMap((entry) => {
        if (entry.patchMetadata) {
          summaries.push(entry.patchMetadata);
        }
        return entry.files;
      }) ?? [];
    if (chunkFiles.length === 0) {
      // The chunk could not be parsed at all: keep a visible placeholder in
      // its slot so the review stays complete instead of silently dropping it.
      // Prefer the sanitizer's exact decoded path, then a best-effort read of
      // the (already sanitized) header, then a positional fallback name.
      const name =
        sanitizedPatch.filePaths[index]?.path ??
        displayNameForUnparseableChunk(chunk, index);
      files.push(
        buildSkippedUnparseableFile(
          name,
          index,
          sourceLabel,
          sidecar,
          perFileOptions,
          hasLineMoveKinds(lineMoveKinds[index]) ? lineMoveKinds[index] : undefined,
        ),
      );
      index += 1;
      continue;
    }
    for (const metadata of chunkFiles) {
      pushParsedFile(metadata);
    }
  }

  return {
    id: `changeset:${Date.now()}`,
    sourceLabel,
    title,
    summary: summaries.join("\n\n") || undefined,
    agentSummary: sidecar?.summary,
    files,
  };
}
