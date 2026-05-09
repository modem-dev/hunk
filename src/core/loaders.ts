import {
  getFiletypeFromFileName,
  parseDiffFromFile,
  parsePatchFiles,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import fs from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { findAgentFileContext, loadAgentContext } from "./agent";
import { createSkippedBinaryMetadata, isProbablyBinaryFile, patchLooksBinary } from "./binary";
import { normalizeDiffMetadataPaths, normalizeDiffPath } from "./diffPaths";
import { HunkUserError } from "./errors";
import {
  buildGitDiffArgs,
  buildGitDiffNumstatArgs,
  buildGitShowArgs,
  buildGitStashShowArgs,
  listGitUntrackedFiles,
  resolveGitRepoRoot,
  runGitText,
  runGitUntrackedFileDiffText,
} from "./git";
import {
  buildJjDiffArgs,
  buildJjShowArgs,
  createJjStagedError,
  resolveJjRepoRoot,
  runJjText,
} from "./jj";
import type {
  AppBootstrap,
  AgentContext,
  Changeset,
  CliInput,
  DiffFile,
  DiffToolCommandInput,
  FileCommandInput,
  VcsCommandInput,
  PatchCommandInput,
  ShowCommandInput,
  StashShowCommandInput,
} from "./types";

interface LoadAppBootstrapOptions {
  cwd?: string;
}

const LARGE_DIFF_FILE_MAX_BYTES = 1_000_000;
const LARGE_DIFF_FILE_MAX_LINES = 20_000;
const LARGE_DIFF_FILE_SNIFF_BYTES = 256 * 1024;

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

/**
 * Strip `git log -p` / `git show -p` commit metadata so the surviving text
 * is a plain patch stream that `@pierre/diffs` can parse without spamming
 * `parseLineType: Invalid firstChar` warnings on every commit boundary.
 *
 * Each commit in `git log -p` looks like:
 *
 * ```
 * commit <sha>[ (refs)]
 * Author: ...
 * Date:   ...
 *
 *     <commit message>
 *
 * diff --git a/foo b/foo
 * ...
 * ```
 *
 * Lines from `commit ` through the first patch header (`diff --git `,
 * `--- `, or `+++ `) are dropped. Hunk-body lines always start with
 * `+`, `-`, ` ` or `\`, so a real context line that begins with the word
 * "commit" is unaffected (its leading space prevents the regex match).
 *
 * Returns the input unchanged when no `commit <sha>` boundary is present,
 * keeping the regular patch path zero-cost.
 */
export function stripGitLogMetadata(text: string) {
  // Hex range up to 64 covers both SHA-1 (40) and SHA-256 (64) repos.
  const COMMIT_BOUNDARY = /^commit [0-9a-f]{4,64}(?: |$)/m;
  if (!COMMIT_BOUNDARY.test(text)) {
    return text;
  }

  const lines = text.split("\n");
  const out: string[] = [];
  let inHeader = false;

  for (const line of lines) {
    if (COMMIT_BOUNDARY.test(line)) {
      inHeader = true;
      continue;
    }
    if (inHeader) {
      // The header section ends at the first patch line. `diff --git `
      // is the canonical Git start; `--- `/`+++ ` cover unified-diff
      // input where someone synthesised log output without it.
      if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
        inHeader = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }

  return out.join("\n");
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
  isTooLarge?: boolean;
  stats?: DiffFile["stats"];
  statsTruncated?: boolean;
}

/** Build the normalized per-file model used by the UI regardless of input mode. */
function buildDiffFile(
  metadata: FileDiffMetadata,
  patch: string,
  index: number,
  sourcePrefix: string,
  agentContext: AgentContext | null,
  {
    isUntracked,
    previousPath,
    isBinary,
    isTooLarge,
    stats,
    statsTruncated,
  }: BuildDiffFileOptions = {},
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
    stats: stats ?? countDiffStats(normalizedMetadata),
    metadata: normalizedMetadata,
    agent: findAgentFileContext(agentContext, path, resolvedPreviousPath),
    isUntracked,
    isBinary: isBinary ?? patchLooksBinary(patch),
    isTooLarge,
    statsTruncated,
  };
}

/**
 * Re-add Git's `a/` and `b/` path prefixes to patch headers when stdin came from a
 * `git diff` that was emitted with `diff.noprefix=true` (or otherwise stripped prefixes).
 *
 * `@pierre/diffs` requires `a/` and `b/` on `diff --git`, `---`, and `+++` lines and throws
 * a `TypeError` on the first noprefix header, which leaves the review with zero files. The
 * git-backed paths force `diff.noprefix=false` when they invoke git internally; this helper
 * covers the patch path (`hunk patch`, `hunk pager`) where the input was produced by an
 * outer `git` process we do not control.
 *
 * The rewrite is scoped to header lines only: once the `+++ ` line has been emitted for a
 * block we clear the flag so a deleted line whose content starts with `-- ` (e.g. a removed
 * SQL/Lua/Haskell comment, which becomes `--- foo` on disk) is not mistaken for a file
 * header inside the hunk body.
 */
type GitHeaderRewriteMode = "add" | "strip";

function normalizeGitPatchPrefixes(patchText: string) {
  if (!patchText.includes("diff --git ")) {
    return patchText;
  }

  const lines = patchText.split("\n");
  const normalizedLines: string[] = [];
  let blockLines: string[] = [];

  const flushBlock = () => {
    if (blockLines.length === 0) {
      return;
    }

    for (const line of rewriteGitPatchBlock(blockLines)) {
      normalizedLines.push(line);
    }
    blockLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushBlock();
      blockLines.push(line);
      continue;
    }

    if (blockLines.length > 0) {
      blockLines.push(line);
    } else {
      normalizedLines.push(line);
    }
  }

  flushBlock();
  return normalizedLines.join("\n");
}

/** Rewrite one `diff --git` block, keeping file-header rewrites out of hunk bodies. */
function rewriteGitPatchBlock(blockLines: string[]) {
  const firstLine = blockLines[0];
  if (!firstLine?.startsWith("diff --git ")) {
    return blockLines;
  }

  const result = rewriteGitDiffHeader(firstLine, blockLines);
  let blockRewriteMode = result.rewriteMode;

  const rewrittenLines = [result.line];

  for (const line of blockLines.slice(1)) {
    if (blockRewriteMode && line.startsWith("--- ")) {
      rewrittenLines.push(rewriteUnifiedFileLine(line, "--- ", "a/", blockRewriteMode));
      continue;
    }

    if (blockRewriteMode && line.startsWith("+++ ")) {
      const rewriteMode = blockRewriteMode;
      blockRewriteMode = null;
      rewrittenLines.push(rewriteUnifiedFileLine(line, "+++ ", "b/", rewriteMode));
      continue;
    }

    rewrittenLines.push(line);
  }

  return rewrittenLines;
}

/** Detect prefixed/noprefix `diff --git` lines and rewrite them into Pierre's `a/X b/Y` form. */
function rewriteGitDiffHeader(
  line: string,
  blockLines: string[],
): {
  line: string;
  rewriteMode: GitHeaderRewriteMode | null;
} {
  const rest = line.slice("diff --git ".length).trimEnd();

  const quotedMatch = rest.match(/^"((?:\\.|[^"\\])*)" "((?:\\.|[^"\\])*)"$/);
  if (quotedMatch) {
    const [, oldPath = "", newPath = ""] = quotedMatch;
    const pair = canonicalizeGitPathPair(oldPath, newPath, blockLines);
    // Pierre's git header parser does not currently handle the quoted `"a/..." "b/..."`
    // form, so canonicalize quoted paths to the unquoted form even when prefixes exist.
    return { line: `diff --git ${pair.oldPath} ${pair.newPath}`, rewriteMode: pair.rewriteMode };
  }

  const tokens = rest.split(" ");

  if (tokens.length >= 2 && tokens.length % 2 === 0) {
    const half = tokens.length / 2;
    const firstHalf = tokens.slice(0, half).join(" ");
    const secondHalf = tokens.slice(half).join(" ");
    const knownPair = canonicalizeKnownGitPathPair(firstHalf, secondHalf, blockLines);

    if (knownPair?.changed) {
      return {
        line: `diff --git ${knownPair.oldPath} ${knownPair.newPath}`,
        rewriteMode: knownPair.rewriteMode,
      };
    }

    // Already prefixed: `a/X b/Y` (covers single-token and equally split multi-token paths).
    if (knownPair?.isCanonical) {
      return { line, rewriteMode: null };
    }

    // Non-rename noprefix: identical halves regardless of whether the path contains spaces.
    if (firstHalf === secondHalf && firstHalf.length > 0) {
      return { line: `diff --git a/${firstHalf} b/${secondHalf}`, rewriteMode: "add" };
    }
  }

  // Two-token rename without prefix and without spaces in either path.
  if (tokens.length === 2 && tokens[0] && tokens[1]) {
    return { line: `diff --git a/${tokens[0]} b/${tokens[1]}`, rewriteMode: "add" };
  }

  // Genuinely ambiguous (rename with spaces and no quoting). Leave untouched and let the
  // parser surface the existing failure rather than guess at the path split.
  return { line, rewriteMode: null };
}

const GIT_MNEMONIC_PREFIXES = new Set(["c", "i", "o", "w", "1", "2"]);

/** Return one Git mnemonic side prefix from a path, if present. */
function splitGitMnemonicPrefix(path: string) {
  const [prefix, ...rest] = path.split("/");
  if (!prefix || rest.length === 0 || !GIT_MNEMONIC_PREFIXES.has(prefix)) {
    return null;
  }

  return { prefix, path: rest.join("/") };
}

/** Remove Git's outer quotes from one path-like metadata value. */
function stripGitPathQuotes(path: string) {
  return path.match(/^"((?:\\.|[^"\\])*)"$/)?.[1] ?? path;
}

/** Return rename metadata, which Git writes without mnemonic side prefixes. */
function findRenameMetadata(blockLines: string[]) {
  const oldPath = blockLines.find((line) => line.startsWith("rename from "));
  const newPath = blockLines.find((line) => line.startsWith("rename to "));

  if (!oldPath || !newPath) {
    return null;
  }

  return {
    oldPath: stripGitPathQuotes(oldPath.slice("rename from ".length)),
    newPath: stripGitPathQuotes(newPath.slice("rename to ".length)),
  };
}

/** Return a path with the expected Git side prefix while avoiding double-prefixing. */
function withGitPrefix(path: string, prefix: "a/" | "b/") {
  return path.startsWith(prefix) ? path : `${prefix}${path}`;
}

/** Decide whether a mnemonic-looking path pair is real mnemonic output or a noprefix rename. */
function shouldStripMnemonicPair(oldPath: string, newPath: string, blockLines: string[]) {
  const oldMnemonic = splitGitMnemonicPrefix(oldPath);
  const newMnemonic = splitGitMnemonicPrefix(newPath);

  if (!oldMnemonic || !newMnemonic || oldMnemonic.prefix === newMnemonic.prefix) {
    return null;
  }

  const rename = findRenameMetadata(blockLines);
  if (!rename) {
    return true;
  }

  if (rename.oldPath === oldPath && rename.newPath === newPath) {
    return false;
  }

  if (rename.oldPath === oldMnemonic.path && rename.newPath === newMnemonic.path) {
    return true;
  }

  return true;
}

/** Convert already-prefixed or mnemonic-prefixed path pairs into Pierre's canonical shape. */
function canonicalizeKnownGitPathPair(oldPath: string, newPath: string, blockLines: string[]) {
  const oldMnemonic = splitGitMnemonicPrefix(oldPath);
  const newMnemonic = splitGitMnemonicPrefix(newPath);
  const isCanonical = oldPath.startsWith("a/") && newPath.startsWith("b/");

  if (isCanonical) {
    return { oldPath, newPath, rewriteMode: "add" as const, changed: false, isCanonical: true };
  }

  if (oldMnemonic && newMnemonic && shouldStripMnemonicPair(oldPath, newPath, blockLines)) {
    return {
      oldPath: `a/${oldMnemonic.path}`,
      newPath: `b/${newMnemonic.path}`,
      rewriteMode: "strip" as const,
      changed: true,
      isCanonical: false,
    };
  }

  return null;
}

/** Convert one quoted `diff --git` path pair into Pierre's canonical side-prefix shape. */
function canonicalizeGitPathPair(oldPath: string, newPath: string, blockLines: string[]) {
  return (
    canonicalizeKnownGitPathPair(oldPath, newPath, blockLines) ?? {
      oldPath: withGitPrefix(oldPath, "a/"),
      newPath: withGitPrefix(newPath, "b/"),
      rewriteMode: "add" as const,
      changed: true,
      isCanonical: false,
    }
  );
}

/** Insert the canonical `a/` or `b/` prefix on a unified-diff header that is missing it. */
function rewriteUnifiedFileLine(
  line: string,
  marker: "--- " | "+++ ",
  prefix: "a/" | "b/",
  mode: GitHeaderRewriteMode,
) {
  const path = line.slice(marker.length);
  const quotedPath = path.match(/^"((?:\\.|[^"\\])*)"(.*)$/);
  const pathName = quotedPath?.[1] ?? path;
  const suffix = quotedPath?.[2] ?? "";

  if (pathName === "/dev/null" || pathName.startsWith("/dev/null\t")) {
    return line;
  }

  const normalizedPath =
    mode === "strip" ? (splitGitMnemonicPrefix(pathName)?.path ?? pathName) : pathName;

  return `${marker}${withGitPrefix(normalizedPath, prefix)}${suffix}`;
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

/** Build placeholder metadata for a file whose full diff would be too expensive. */
function createSkippedLargeMetadata(
  filePath: string,
  type: FileDiffMetadata["type"],
): FileDiffMetadata {
  return {
    name: filePath,
    type,
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    additionLines: [],
    deletionLines: [],
    cacheKey: `${filePath}:large-diff-skipped`,
  };
}

interface GitNumstatFile {
  path: string;
  additions: number;
  deletions: number;
}

/** Parse `git diff --numstat -z` output for normal path entries. */
function parseGitNumstat(text: string): GitNumstatFile[] {
  return text
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const [additionsText, deletionsText, path] = entry.split("\t");
      if (!additionsText || !deletionsText || !path) {
        return [];
      }

      const additions = Number.parseInt(additionsText, 10);
      const deletions = Number.parseInt(deletionsText, 10);
      if (!Number.isFinite(additions) || !Number.isFinite(deletions)) {
        return [];
      }

      return [{ path, additions, deletions }];
    });
}

/** Return whether tracked diff stats are too large to render by default. */
function shouldSkipLargeTrackedDiff(file: GitNumstatFile, repoRoot: string) {
  if (file.additions + file.deletions > LARGE_DIFF_FILE_MAX_LINES) {
    return true;
  }

  try {
    return fs.statSync(join(repoRoot, file.path)).size > LARGE_DIFF_FILE_MAX_BYTES;
  } catch {
    return false;
  }
}

/** Build a tracked placeholder for a file whose diff would be too expensive to render. */
function buildSkippedLargeTrackedDiffFile(
  file: GitNumstatFile,
  index: number,
  sourcePrefix: string,
  agentContext: AgentContext | null,
) {
  return buildDiffFile(
    createSkippedLargeMetadata(file.path, "change"),
    "",
    index,
    sourcePrefix,
    agentContext,
    {
      isTooLarge: true,
      stats: {
        additions: file.additions,
        deletions: file.deletions,
      },
    },
  );
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
) {
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
  const normalizedPatchText = normalizeGitPatchPrefixes(
    stripGitLogMetadata(stripTerminalControl(patchText.replaceAll("\r\n", "\n"))),
  );

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
  input: VcsCommandInput,
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
  const largeTrackedFiles = parseGitNumstat(
    runGitText({ input, args: buildGitDiffNumstatArgs(input), cwd }),
  ).filter((file) => shouldSkipLargeTrackedDiff(file, repoRoot));
  const trackedChangeset = normalizePatchChangeset(
    runGitText({
      input,
      args: buildGitDiffArgs(
        input,
        largeTrackedFiles.map((file) => file.path),
      ),
      cwd,
    }),
    title,
    repoRoot,
    agentContext,
  );
  const trackedFiles = [
    ...trackedChangeset.files,
    ...largeTrackedFiles.map((file, index) =>
      buildSkippedLargeTrackedDiffFile(
        file,
        trackedChangeset.files.length + index,
        repoRoot,
        agentContext,
      ),
    ),
  ];
  const untrackedFiles = listGitUntrackedFiles(input, { cwd, repoRoot });

  if (untrackedFiles.length === 0) {
    return {
      ...trackedChangeset,
      files: trackedFiles,
    } satisfies Changeset;
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

/** Build a changeset from the current Jujutsu working-copy commit or a revset. */
async function loadJjDiffChangeset(
  input: VcsCommandInput,
  agentContext: AgentContext | null,
  cwd = process.cwd(),
) {
  if (input.staged) {
    throw createJjStagedError(input);
  }

  const repoRoot = resolveJjRepoRoot(input, { cwd });
  const repoName = basename(repoRoot);
  const title = input.range ? `${repoName} ${input.range}` : `${repoName} working copy`;

  return normalizePatchChangeset(
    runJjText({ input, args: buildJjDiffArgs(input), cwd }),
    title,
    repoRoot,
    agentContext,
  );
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

/** Build a changeset from one Jujutsu revset using Git-format patch output. */
async function loadJjShowChangeset(
  input: ShowCommandInput,
  agentContext: AgentContext | null,
  cwd = process.cwd(),
) {
  const repoRoot = resolveJjRepoRoot(input, { cwd });
  const repoName = basename(repoRoot);
  const revset = input.ref ?? "@";

  return normalizePatchChangeset(
    runJjText({ input, args: buildJjShowArgs(input), cwd }),
    `${repoName} show ${revset}`,
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
  if (input.options.vcs === "jj") {
    throw new HunkUserError("`hunk stash show` requires Git VCS mode.", [
      'Set `vcs = "git"` in Hunk config, then try again.',
    ]);
  }

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
    case "vcs":
      changeset =
        input.options.vcs === "jj"
          ? await loadJjDiffChangeset(input, agentContext, cwd)
          : await loadGitChangeset(input, agentContext, cwd);
      break;
    case "show":
      changeset =
        input.options.vcs === "jj"
          ? await loadJjShowChangeset(input, agentContext, cwd)
          : await loadShowChangeset(input, agentContext, cwd);
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
