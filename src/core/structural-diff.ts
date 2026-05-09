import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StructuralChange } from "./types";

// ---------------------------------------------------------------------------
// difftastic JSON types
// ---------------------------------------------------------------------------

interface DifftasticPosition {
  line: number;
  column: number;
}

interface DifftasticChange {
  kind: "added" | "removed" | "unchanged" | string;
  lhs: DifftasticPosition | null;
  rhs: DifftasticPosition | null;
}

interface DifftasticChunk {
  changes: DifftasticChange[];
}

interface DifftasticFileResult {
  path: string;
  language?: string;
  status: "changed" | "unchanged" | "binary" | string;
  // TODO: when difftastic PR #936 (aligned_lines) ships in a release, parse
  // fileResult.aligned_lines: [number | null, number | null][] here to drive
  // split-view row pairing directly instead of deriving alignment from chunks.
  chunks?: DifftasticChunk[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write text to a named temp file and return the path. */
function writeTempFile(dir: string, name: string, content: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

/** Derive a safe basename from a display path for temp-file naming. */
function tempBasename(displayPath: string): string {
  return displayPath.replace(/[/\\]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "") || "file";
}

/**
 * Map difftastic chunk changes into the `StructuralChange[]` model.
 *
 * difftastic reports changes at the token level with line positions. We promote
 * them to whole-line ranges so the gutter marker aligns with what Pierre renders.
 */
function mapChunksToStructuralChanges(chunks: DifftasticChunk[]): StructuralChange[] {
  const oldLines = new Set<number>();
  const newLines = new Set<number>();

  for (const chunk of chunks) {
    for (const change of chunk.changes) {
      if (change.kind === "unchanged") continue;

      if (change.lhs?.line != null) {
        oldLines.add(change.lhs.line);
      }
      if (change.rhs?.line != null) {
        newLines.add(change.rhs.line);
      }
    }
  }

  const changes: StructuralChange[] = [];

  /** Collapse a set of 0-indexed line numbers into contiguous 1-indexed ranges. */
  function collapseLines(lineSet: Set<number>, type: StructuralChange["type"]): void {
    const sorted = [...lineSet].sort((a, b) => a - b);
    if (sorted.length === 0) return;

    let start = sorted[0]!;
    let end = sorted[0]!;

    for (let i = 1; i < sorted.length; i++) {
      const line = sorted[i]!;
      if (line === end + 1) {
        end = line;
      } else {
        // difftastic lines are 0-indexed; convert to 1-indexed for display.
        changes.push({ type, startLine: start + 1, endLine: end + 1 });
        start = line;
        end = line;
      }
    }

    changes.push({ type, startLine: start + 1, endLine: end + 1 });
  }

  collapseLines(oldLines, "deletion");
  collapseLines(newLines, "addition");

  return changes;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `difftastic --output=json` on two in-memory source strings and return
 * structural change line ranges.
 *
 * Returns `undefined` when:
 * - `difft` is not installed / not on PATH (silent — callers skip gutter markers)
 * - difftastic reports the file as binary or unchanged
 * - the JSON output cannot be parsed
 *
 * Temp files are written to the OS temp directory and cleaned up on exit.
 */
export function runDifftasticStructural(
  leftContent: string,
  rightContent: string,
  displayPath: string,
): StructuralChange[] | undefined {
  let tmpDir: string | undefined;

  try {
    // Write both sides to temp files so difftastic can diff them by path.
    tmpDir = mkdtempSync(join(tmpdir(), "hunk-structural-"));
    const base = tempBasename(displayPath);
    const leftPath = writeTempFile(tmpDir, `left_${base}`, leftContent);
    const rightPath = writeTempFile(tmpDir, `right_${base}`, rightContent);

    const result = spawnSync(
      "difft",
      ["--output", "json", "--color", "never", leftPath, rightPath],
      { encoding: "utf8", timeout: 10_000 },
    );

    // ENOENT → difftastic not installed. Fail silently so the UI still works.
    if (result.error) {
      return undefined;
    }

    const stdout = result.stdout?.trim();
    if (!stdout) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return undefined;
    }

    // difftastic emits either an array or a single object at the top level.
    const results: DifftasticFileResult[] = Array.isArray(parsed) ? parsed : [parsed];
    const fileResult = results[0];

    if (!fileResult || fileResult.status !== "changed" || !fileResult.chunks) {
      return undefined;
    }

    return mapChunksToStructuralChanges(fileResult.chunks);
  } catch {
    return undefined;
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }
  }
}
