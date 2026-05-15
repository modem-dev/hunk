/**
 * Helpers for normalizing Git-format patch syntax.
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
type GitHeaderRewriteMode = "add" | "strip";

export function normalizeGitPatchPrefixes(patchText: string) {
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
