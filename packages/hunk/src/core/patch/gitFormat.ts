/**
 * Helpers for sanitizing Git-format patch syntax.
 *
 * These helpers are not tied to Git repositories: Jujutsu and other VCS backends can emit
 * the same `diff --git` patch format, so the app loader and public OpenTUI API share them.
 */

/**
 * Canonicalize Git-format patch headers into the `a/` and `b/` side prefixes Pierre expects.
 *
 * This covers patch text produced outside Hunk's controlled VCS commands, where user config or
 * another tool may emit noprefix, mnemonic-prefix, or quoted `diff --git` paths. Rewrites are
 * intentionally limited to each file header block and stop after the `+++ ` file header so hunk
 * body lines that merely look like file headers are preserved verbatim.
 */
type GitHeaderRewriteMode = "add" | "prepend-prefix" | "strip";

export interface SanitizedGitPatchFilePaths {
  path: string;
  previousPath?: string;
}

export interface SanitizedGitPatch {
  text: string;
  filePaths: Array<SanitizedGitPatchFilePaths | undefined>;
}

/** Return the pathname token from a unified diff file header. */
function unifiedFilePath(line: string, marker: "--- " | "+++ ") {
  const value = line.slice(marker.length).trimEnd();
  if (value.startsWith('"')) {
    const quoted = value.match(/^"(?:\\.|[^"\\])*"/)?.[0];
    if (quoted) {
      return quoted;
    }
  }

  return value.split("\t", 1)[0] ?? "";
}

/** Move a unified-diff pathname onto the requested Git side prefix. */
function gitSidePath(path: string, side: "a" | "b") {
  if (path === "/dev/null") {
    return path;
  }

  const quoted = path.match(/^"((?:\\.|[^"\\])*)"(.*)$/);
  const pathText = quoted?.[1] ?? path;
  const suffix = quoted?.[2] ?? "";
  const unprefixed = pathText.replace(/^[ab]\//, "");
  const prefixed = `${side}/${unprefixed}`;
  return quoted ? `"${prefixed}"${suffix}` : prefixed;
}

/** Rewrite one combined-diff file header into a conventional two-sided Git header. */
function rewriteCombinedFileHeader(
  line: string,
  fallbackPath: string,
  oldPath: string | undefined,
  newPath: string | undefined,
) {
  const fallback = line.slice(line.indexOf(" ") + 1).trimEnd();
  const left = (oldPath ?? fallbackPath) || fallback;
  const right = (newPath ?? fallbackPath) || fallback;
  const leftPath = left === "/dev/null" ? right : left;
  const rightPath = right === "/dev/null" ? left : right;

  return `diff --git ${gitSidePath(leftPath, "a")} ${gitSidePath(rightPath, "b")}`;
}

/** Convert a combined hunk header to the first-parent unified hunk it contains. */
function rewriteCombinedHunkHeader(line: string) {
  const match = line.match(/^(@@@+)\s+(.+?)\s+(@@@+)(.*)$/);
  if (!match || match[1] !== match[3]) {
    return null;
  }

  const openingMarker = match[1]!;
  const parentCount = openingMarker.length - 1;
  const ranges = match[2]!.trim().split(/\s+/);
  if (
    parentCount < 2 ||
    ranges.length !== parentCount + 1 ||
    ranges.slice(0, parentCount).some((range) => !range.startsWith("-")) ||
    !ranges[parentCount]?.startsWith("+")
  ) {
    return null;
  }

  return {
    line: `@@ ${ranges[0]} ${ranges[parentCount]} @@${match[4]}`,
    parentCount,
  };
}

/** Convert Git combined conflict patches into first-parent unified patches Pierre can render. */
export function normalizeCombinedGitPatch(patchText: string) {
  const lines = patchText.split("\n");
  const normalizedLines: string[] = [];
  let combinedHeaderIndex: number | undefined;
  let combinedFallbackPath = "";
  let combinedOldPath: string | undefined;
  let combinedNewPath: string | undefined;
  let combinedParentCount: number | undefined;

  const resetCombinedState = () => {
    combinedHeaderIndex = undefined;
    combinedFallbackPath = "";
    combinedOldPath = undefined;
    combinedNewPath = undefined;
    combinedParentCount = undefined;
  };

  for (const line of lines) {
    const combinedHeader = line.match(/^diff --(cc|combined) (.*)$/);
    if (combinedHeader) {
      resetCombinedState();
      combinedHeaderIndex = normalizedLines.length;
      combinedFallbackPath = combinedHeader[2] ?? "";
      // Rewrite immediately so binary combined entries, which have no unified file headers,
      // still reach the normal Git patch parser.
      normalizedLines.push(
        rewriteCombinedFileHeader(line, combinedFallbackPath, undefined, undefined),
      );
      continue;
    }

    if (line.startsWith("diff --git ")) {
      resetCombinedState();
      normalizedLines.push(line);
      continue;
    }

    if (combinedHeaderIndex === undefined) {
      normalizedLines.push(line);
      continue;
    }

    if (combinedParentCount === undefined && line.startsWith("--- ")) {
      // `--combined-all-paths` emits one old-file header per parent. The first parent is the
      // projection used below; discard the remaining parent headers before parsing.
      if (combinedOldPath === undefined) {
        combinedOldPath = unifiedFilePath(line, "--- ");
        normalizedLines.push(line);
      }
      continue;
    }

    if (combinedParentCount === undefined && line.startsWith("+++ ")) {
      combinedNewPath = unifiedFilePath(line, "+++ ");
      normalizedLines[combinedHeaderIndex] = rewriteCombinedFileHeader(
        normalizedLines[combinedHeaderIndex]!,
        combinedFallbackPath,
        combinedOldPath,
        combinedNewPath,
      );
      normalizedLines.push(line);
      continue;
    }

    const combinedHunk = rewriteCombinedHunkHeader(line);
    if (combinedHunk) {
      combinedParentCount = combinedHunk.parentCount;
      normalizedLines.push(combinedHunk.line);
      continue;
    }

    if (combinedParentCount !== undefined && line.length >= combinedParentCount) {
      const prefix = line.slice(0, combinedParentCount);
      const firstParentMarker = prefix[0];
      if (firstParentMarker && /^[ +-]+$/.test(prefix)) {
        // A parent-only deletion has no representation in the first-parent/result diff. In a
        // combined row, that shape is a context marker for the first parent plus `-` elsewhere.
        if (firstParentMarker === " " && prefix.slice(1).includes("-")) {
          continue;
        }
        normalizedLines.push(`${firstParentMarker}${line.slice(combinedParentCount)}`);
        continue;
      }
    }

    normalizedLines.push(line);
  }

  return normalizedLines.join("\n");
}

const gitQuotedUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const gitQuotedUtf8Encoder = new TextEncoder();
const gitUnsafeDecodedHeaderCharacter = /[\x00-\x1f\x7f-\x9f]/;
const gitSimpleEscapeBytes: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  "\\": 0x5c,
  '"': 0x22,
};

/** Decode Git's octal-escaped UTF-8 pathname bytes without exposing escaped controls to parsing. */
function decodeGitQuotedUtf8Path(path: string) {
  let decodedPath = "";
  let index = 0;

  while (index < path.length) {
    const escape = path.slice(index).match(/^\\([0-7]{3})/);
    if (!escape) {
      // Advance over a complete non-octal escape so a protected literal backslash cannot make the
      // following digits look like an octal byte escape on the next iteration.
      if (path[index] === "\\" && index + 1 < path.length) {
        decodedPath += path.slice(index, index + 2);
        index += 2;
      } else {
        decodedPath += path[index];
        index += 1;
      }
      continue;
    }

    const escapedBytes: number[] = [];
    const escapedText: string[] = [];
    while (index < path.length) {
      const byteEscape = path.slice(index).match(/^\\([0-7]{3})/);
      if (!byteEscape) {
        break;
      }
      escapedText.push(byteEscape[0]);
      escapedBytes.push(Number.parseInt(byteEscape[1]!, 8));
      index += byteEscape[0].length;
    }

    // Git uses these runs for UTF-8 bytes when core.quotePath is enabled. Leave ASCII control
    // escapes and invalid byte sequences untouched so normalizing a patch can never add physical
    // tabs/newlines or replacement characters to a pathname header.
    if (escapedBytes.every((byte) => byte >= 0x80 && byte <= 0xff)) {
      try {
        const decodedBytes = gitQuotedUtf8Decoder.decode(Uint8Array.from(escapedBytes));
        if (!gitUnsafeDecodedHeaderCharacter.test(decodedBytes)) {
          decodedPath += decodedBytes;
          continue;
        }
      } catch {
        // Preserve the original spelling when a repository path is not valid UTF-8.
      }
    }

    decodedPath += escapedText.join("");
  }

  return decodedPath;
}

/** Decode one syntactically quoted Git pathname, returning null for malformed or invalid UTF-8. */
function decodeGitQuotedPath(path: string) {
  const bytes: number[] = [];
  let index = 0;

  while (index < path.length) {
    if (path[index] !== "\\") {
      const codePoint = path.codePointAt(index);
      if (codePoint === undefined) {
        break;
      }
      const scalar = String.fromCodePoint(codePoint);
      bytes.push(...gitQuotedUtf8Encoder.encode(scalar));
      index += scalar.length;
      continue;
    }

    const octalEscape = path.slice(index).match(/^\\([0-7]{1,3})/);
    if (octalEscape) {
      const byte = Number.parseInt(octalEscape[1]!, 8);
      if (byte > 0xff) {
        return null;
      }
      bytes.push(byte);
      index += octalEscape[0].length;
      continue;
    }

    const escaped = path[index + 1];
    const byte = escaped ? gitSimpleEscapeBytes[escaped] : undefined;
    if (byte === undefined) {
      return null;
    }
    bytes.push(byte);
    index += 2;
  }

  try {
    return gitQuotedUtf8Decoder.decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

/** Normalize Git patch syntax and retain exact decoded paths separately from parser-safe text. */
export function sanitizeGitPatch(patchText: string): SanitizedGitPatch {
  const normalizedPatch = normalizeCombinedGitPatch(patchText);
  if (!normalizedPatch.includes("diff --git ")) {
    return { text: normalizedPatch, filePaths: [] };
  }

  const lines = normalizedPatch.split("\n");
  const normalizedLines: string[] = [];
  const filePaths: Array<SanitizedGitPatchFilePaths | undefined> = [];
  let blockLines: string[] = [];

  const flushBlock = () => {
    if (blockLines.length === 0) {
      return;
    }

    const rewritten = rewriteGitPatchBlock(blockLines);
    normalizedLines.push(...rewritten.lines);
    filePaths.push(rewritten.filePaths);
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
  return { text: normalizedLines.join("\n"), filePaths };
}

/** Preserve the existing text-only sanitizer for callers that do not parse file metadata. */
export function sanitizeGitPatchText(patchText: string) {
  return sanitizeGitPatch(patchText).text;
}

/** Rewrite one `diff --git` block, keeping file-header rewrites out of hunk bodies. */
function rewriteGitPatchBlock(blockLines: string[]) {
  const firstLine = blockLines[0];
  if (!firstLine?.startsWith("diff --git ")) {
    return { lines: blockLines, filePaths: undefined };
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

    rewrittenLines.push(rewriteGitMetadataPathLine(line));
  }

  return {
    lines: rewrittenLines,
    filePaths: resolveDecodedGitFilePaths(result.decodedPair, blockLines),
  };
}

/** Detect prefixed/noprefix `diff --git` lines and rewrite them into Pierre's `a/X b/Y` form. */
function rewriteGitDiffHeader(
  line: string,
  blockLines: string[],
): {
  line: string;
  rewriteMode: GitHeaderRewriteMode | null;
  decodedPair?: { oldPath: string; newPath: string };
} {
  const rest = line.slice("diff --git ".length).trimEnd();

  const quotedMatch = rest.match(/^"((?:\\.|[^"\\])*)" "((?:\\.|[^"\\])*)"$/);
  if (quotedMatch) {
    const quotedOldPath = quotedMatch[1] ?? "";
    const quotedNewPath = quotedMatch[2] ?? "";
    const oldPath = decodeGitQuotedUtf8Path(quotedOldPath);
    const newPath = decodeGitQuotedUtf8Path(quotedNewPath);
    const pair = canonicalizeGitPathPair(oldPath, newPath, blockLines);
    const decodedOldPath = decodeGitQuotedPath(quotedOldPath);
    const decodedNewPath = decodeGitQuotedPath(quotedNewPath);
    const decodedPair =
      decodedOldPath !== null && decodedNewPath !== null
        ? canonicalizeGitPathPair(decodedOldPath, decodedNewPath, blockLines)
        : undefined;
    // Pierre's git header parser does not currently handle the quoted `"a/..." "b/..."`
    // form, so decode quoted UTF-8 paths and canonicalize them even when prefixes exist.
    return {
      line: `diff --git ${pair.oldPath} ${pair.newPath}`,
      rewriteMode: pair.rewriteMode,
      decodedPair,
    };
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
      return {
        line: `diff --git a/${firstHalf} b/${secondHalf}`,
        rewriteMode: "prepend-prefix",
      };
    }
  }

  // Two-token rename without prefix and without spaces in either path.
  if (tokens.length === 2 && tokens[0] && tokens[1]) {
    return {
      line: `diff --git a/${tokens[0]} b/${tokens[1]}`,
      rewriteMode: "prepend-prefix",
    };
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

/** Remove Git's outer quotes and decode valid C-style pathname bytes for comparisons. */
function stripGitPathQuotes(path: string) {
  const quotedPath = path.match(/^"((?:\\.|[^"\\])*)"$/)?.[1];
  return quotedPath === undefined
    ? path
    : (decodeGitQuotedPath(quotedPath) ?? decodeGitQuotedUtf8Path(quotedPath));
}

const gitMetadataPathMarkers = ["rename from ", "rename to ", "copy from ", "copy to "] as const;

/** Decode quoted UTF-8 bytes in Git rename/copy metadata while preserving unrelated syntax. */
function rewriteGitMetadataPathLine(line: string) {
  const marker = gitMetadataPathMarkers.find((candidate) => line.startsWith(candidate));
  if (!marker) {
    return line;
  }

  const value = line.slice(marker.length);
  const quotedPath = value.match(/^"((?:\\.|[^"\\])*)"$/)?.[1];
  if (quotedPath === undefined) {
    return line;
  }

  const decodedPath = decodeGitQuotedUtf8Path(quotedPath);
  return decodedPath === quotedPath ? line : `${marker}${decodedPath}`;
}

/** Return rename or copy metadata, which Git writes without mnemonic side prefixes. */
function findRenameOrCopyMetadata(blockLines: string[]) {
  for (const kind of ["rename", "copy"] as const) {
    const oldMarker = `${kind} from `;
    const newMarker = `${kind} to `;
    const oldPath = blockLines.find((line) => line.startsWith(oldMarker));
    const newPath = blockLines.find((line) => line.startsWith(newMarker));

    if (oldPath && newPath) {
      return {
        oldPath: stripGitPathQuotes(oldPath.slice(oldMarker.length)),
        newPath: stripGitPathQuotes(newPath.slice(newMarker.length)),
      };
    }
  }

  return null;
}

/** Prefer exact rename/copy metadata, then fall back to the canonical decoded header pair. */
function resolveDecodedGitFilePaths(
  decodedPair: { oldPath: string; newPath: string } | undefined,
  blockLines: string[],
): SanitizedGitPatchFilePaths | undefined {
  if (!decodedPair) {
    return undefined;
  }

  const metadata = findRenameOrCopyMetadata(blockLines);
  const previousPath = metadata?.oldPath ?? decodedPair.oldPath.replace(/^a\//, "");
  const path = metadata?.newPath ?? decodedPair.newPath.replace(/^b\//, "");

  return previousPath === path ? { path } : { path, previousPath };
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

  const metadata = findRenameOrCopyMetadata(blockLines);
  if (!metadata) {
    return true;
  }

  if (metadata.oldPath === oldPath && metadata.newPath === newPath) {
    return false;
  }

  if (metadata.oldPath === oldMnemonic.path && metadata.newPath === newMnemonic.path) {
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
    const metadata = findRenameOrCopyMetadata(blockLines);
    // With --no-prefix, real top-level a/ and b/ directories can imitate canonical side prefixes.
    // Rename/copy metadata names the actual paths and disambiguates that otherwise impossible pair.
    if (metadata?.oldPath === oldPath && metadata.newPath === newPath) {
      return null;
    }
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
      oldPath: `a/${oldPath}`,
      newPath: `b/${newPath}`,
      rewriteMode: "prepend-prefix" as const,
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

  const decodedPathName = quotedPath ? decodeGitQuotedUtf8Path(pathName) : pathName;
  const normalizedPath =
    mode === "strip"
      ? (splitGitMnemonicPrefix(decodedPathName)?.path ?? decodedPathName)
      : decodedPathName;

  const prefixedPath =
    mode === "prepend-prefix"
      ? `${prefix}${normalizedPath}`
      : withGitPrefix(normalizedPath, prefix);
  return `${marker}${prefixedPath}${suffix}`;
}
