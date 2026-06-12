import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewedMarkerStore } from "./reviewedMarkerStore";

const tempDirs: string[] = [];

function createTempRepoRoot() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-reviewed-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const HASH_A = "00000000000000aa";
const HASH_B = "00000000000000bb";

describe("createReviewedMarkerStore", () => {
  test("add persists a marker file and load returns it", () => {
    const repoRoot = createTempRepoRoot();
    const store = createReviewedMarkerStore(repoRoot);

    store.add(HASH_A);

    expect(existsSync(join(repoRoot, ".hunk", "cache", "reviewed", HASH_A))).toBe(true);
    expect([...store.load()]).toEqual([HASH_A]);
  });

  test("writes a self-ignoring .gitignore once, without clobbering it", () => {
    const repoRoot = createTempRepoRoot();
    const store = createReviewedMarkerStore(repoRoot);
    const gitignorePath = join(repoRoot, ".hunk", "cache", ".gitignore");

    store.add(HASH_A);
    expect(readFileSync(gitignorePath, "utf8")).toBe("*\n");

    writeFileSync(gitignorePath, "custom\n");
    store.add(HASH_B);
    expect(readFileSync(gitignorePath, "utf8")).toBe("custom\n");
  });

  test("remove deletes the marker and is idempotent", () => {
    const repoRoot = createTempRepoRoot();
    const store = createReviewedMarkerStore(repoRoot);

    store.add(HASH_A);
    store.remove(HASH_A);
    store.remove(HASH_A);

    expect(store.load().size).toBe(0);
  });

  test("add is idempotent and refreshes the marker", () => {
    const repoRoot = createTempRepoRoot();
    const store = createReviewedMarkerStore(repoRoot);

    store.add(HASH_A);
    store.add(HASH_A);

    expect([...store.load()]).toEqual([HASH_A]);
  });

  test("load returns an empty set when the marker dir does not exist", () => {
    expect(createReviewedMarkerStore(createTempRepoRoot()).load().size).toBe(0);
  });

  test("load garbage-collects markers older than the TTL", () => {
    const repoRoot = createTempRepoRoot();
    const store = createReviewedMarkerStore(repoRoot, { ttlDays: 30 });

    store.add(HASH_A);
    store.add(HASH_B);

    // Age HASH_A past the TTL via mtime; HASH_B stays fresh.
    const staleSeconds = (Date.now() - 31 * 86_400_000) / 1000;
    utimesSync(join(repoRoot, ".hunk", "cache", "reviewed", HASH_A), staleSeconds, staleSeconds);

    expect([...store.load()]).toEqual([HASH_B]);
    expect(existsSync(join(repoRoot, ".hunk", "cache", "reviewed", HASH_A))).toBe(false);
  });

  test("load ignores entries that are not reviewed-hash markers", () => {
    const repoRoot = createTempRepoRoot();
    const store = createReviewedMarkerStore(repoRoot);

    store.add(HASH_A);
    writeFileSync(join(repoRoot, ".hunk", "cache", "reviewed", "not-a-hash.txt"), "");

    expect([...store.load()]).toEqual([HASH_A]);
  });
});
