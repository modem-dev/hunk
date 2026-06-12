import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-repo persistence for reviewed-hunk hashes.
 *
 * Each reviewed hunk is one empty marker file `.hunk/cache/reviewed/<hash>`:
 * existence means "reviewed", mtime means "reviewed at". Marker files make
 * every toggle an independent atomic create/delete, so concurrent Hunk
 * sessions on the same repo never race a shared read-modify-write document.
 *
 * Every operation degrades to a no-op (or an empty set) on filesystem errors:
 * losing review marks must never crash or block the TUI.
 */
export interface ReviewedMarkerStore {
  /** Read all marker hashes, garbage-collecting markers older than the TTL. */
  load(): Set<string>;
  /** Persist one reviewed hash. */
  add(hash: string): void;
  /** Remove one reviewed hash. */
  remove(hash: string): void;
}

/** Default marker time-to-live; matches the `reviewed_ttl_days` config default. */
export const DEFAULT_REVIEWED_TTL_DAYS = 30;

const MS_PER_DAY = 86_400_000;

// Hashes are produced by reviewedHunks.ts as 16-char hex; ignore anything else
// (e.g. .gitignore, editor droppings) when loading.
const MARKER_NAME_PATTERN = /^[0-9a-f]{16}$/;

/** Create a marker store rooted at `<repoRoot>/.hunk/cache/reviewed/`. */
export function createReviewedMarkerStore(
  repoRoot: string,
  {
    ttlDays = DEFAULT_REVIEWED_TTL_DAYS,
    now = Date.now,
  }: { ttlDays?: number; now?: () => number } = {},
): ReviewedMarkerStore {
  const cacheDir = join(repoRoot, ".hunk", "cache");
  const markerDir = join(cacheDir, "reviewed");

  /** Make the marker dir and keep the whole cache self-ignored in git. */
  function ensureMarkerDir() {
    mkdirSync(markerDir, { recursive: true });
    const gitignorePath = join(cacheDir, ".gitignore");
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, "*\n", { encoding: "utf8", mode: 0o600 });
    }
  }

  return {
    load() {
      const hashes = new Set<string>();
      let entries: string[];
      try {
        entries = readdirSync(markerDir);
      } catch {
        return hashes;
      }

      const expiryMs = ttlDays * MS_PER_DAY;
      for (const entry of entries) {
        if (!MARKER_NAME_PATTERN.test(entry)) {
          continue;
        }

        const markerPath = join(markerDir, entry);
        try {
          if (now() - statSync(markerPath).mtimeMs > expiryMs) {
            rmSync(markerPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }

        hashes.add(entry);
      }

      return hashes;
    },

    add(hash) {
      try {
        ensureMarkerDir();
        writeFileSync(join(markerDir, hash), "", { encoding: "utf8", mode: 0o600 });
      } catch {
        // Persistence is best-effort; the in-memory reviewed set still applies.
      }
    },

    remove(hash) {
      try {
        rmSync(join(markerDir, hash), { force: true });
      } catch {
        // Best-effort; see add().
      }
    },
  };
}
