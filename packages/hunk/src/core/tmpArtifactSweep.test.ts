import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleTmpArtifacts } from "./tmpArtifactSweep";

const SAMPLE_ARTIFACT = ".79ef6acde42ffee7-00000000.so";
const STAMP_BASENAME = ".hunk-tmp-sweep-stamp";
const HOUR_MS = 60 * 60 * 1000;

/** Run one test against a throwaway fake temp directory that is always cleaned up. */
async function withFakeTmpdir(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "hunk-tmp-sweep-test-"));

  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Create one file whose mtime is set the given number of milliseconds before `nowMs`. */
function writeFileAgedBy(path: string, nowMs: number, ageMs: number) {
  writeFileSync(path, "x");
  const seconds = (nowMs - ageMs) / 1000;
  utimesSync(path, seconds, seconds);
}

describe("stale tmp artifact sweep", () => {
  test("removes a matching artifact older than the threshold", async () => {
    await withFakeTmpdir(async (dir) => {
      const nowMs = 10 * HOUR_MS;
      const artifact = join(dir, SAMPLE_ARTIFACT);
      writeFileAgedBy(artifact, nowMs, 2 * HOUR_MS);

      await sweepStaleTmpArtifacts({
        tmpdirImpl: () => dir,
        now: () => nowMs,
      });

      expect(existsSync(artifact)).toBe(false);
    });
  });

  test("keeps a matching artifact newer than the threshold", async () => {
    await withFakeTmpdir(async (dir) => {
      const nowMs = 10 * HOUR_MS;
      const artifact = join(dir, SAMPLE_ARTIFACT);
      writeFileAgedBy(artifact, nowMs, 30 * 60 * 1000);

      await sweepStaleTmpArtifacts({
        tmpdirImpl: () => dir,
        now: () => nowMs,
      });

      expect(existsSync(artifact)).toBe(true);
    });
  });

  test("ignores entries that do not match the artifact pattern", async () => {
    await withFakeTmpdir(async (dir) => {
      const nowMs = 10 * HOUR_MS;
      const names = [
        "79ef6acde42ffee7-00000000.so", // not hidden
        ".79ef6acde42ffee7-00000000.txt", // wrong extension
        ".79ef6acde42ffee7-000000.so", // wrong hex length
        ".79ef6acde42ffee.so", // missing suffix segment
      ];
      for (const name of names) {
        writeFileAgedBy(join(dir, name), nowMs, 2 * HOUR_MS);
      }

      await sweepStaleTmpArtifacts({
        tmpdirImpl: () => dir,
        now: () => nowMs,
      });

      for (const name of names) {
        expect(existsSync(join(dir, name))).toBe(true);
      }
    });
  });

  test("does not scan when a recent stamp is present", async () => {
    await withFakeTmpdir(async (dir) => {
      const nowMs = 10 * HOUR_MS;
      const artifact = join(dir, SAMPLE_ARTIFACT);
      writeFileAgedBy(artifact, nowMs, 2 * HOUR_MS);

      // A stamp refreshed 10 minutes ago must suppress the sweep entirely.
      const stampPath = join(dir, ".hunk-tmp-sweep-stamp");
      writeFileAgedBy(stampPath, nowMs, 10 * 60 * 1000);

      await sweepStaleTmpArtifacts({
        tmpdirImpl: () => dir,
        now: () => nowMs,
      });

      expect(existsSync(artifact)).toBe(true);
    });
  });

  test("does nothing when disabled via the opt-out environment variable", async () => {
    await withFakeTmpdir(async (dir) => {
      const nowMs = 10 * HOUR_MS;
      const artifact = join(dir, SAMPLE_ARTIFACT);
      writeFileAgedBy(artifact, nowMs, 2 * HOUR_MS);

      await sweepStaleTmpArtifacts({
        env: { HUNK_DISABLE_TMP_SWEEP: "1" },
        tmpdirImpl: () => dir,
        now: () => nowMs,
      });

      expect(existsSync(artifact)).toBe(true);
    });
  });

  test("never throws when a matching entry cannot be removed", async () => {
    await withFakeTmpdir(async (dir) => {
      const nowMs = 10 * HOUR_MS;
      // A directory that matches the pattern is not a regular file, so unlink is
      // never attempted and the sweep must complete without surfacing an error.
      const artifactDir = join(dir, SAMPLE_ARTIFACT);
      mkdirSync(artifactDir);
      utimesSync(artifactDir, (nowMs - 2 * HOUR_MS) / 1000, (nowMs - 2 * HOUR_MS) / 1000);

      await expect(
        sweepStaleTmpArtifacts({
          tmpdirImpl: () => dir,
          now: () => nowMs,
        }),
      ).resolves.toBeUndefined();

      expect(existsSync(artifactDir)).toBe(true);
    });
  });

  test("never throws when the temp directory does not exist", async () => {
    const missingDir = join(tmpdir(), "hunk-tmp-sweep-missing-0123456789");

    await expect(
      sweepStaleTmpArtifacts({
        tmpdirImpl: () => missingDir,
        now: () => 10 * HOUR_MS,
      }),
    ).resolves.toBeUndefined();
  });

  test("aborts without touching a symlinked stamp on a hostile temp directory", async () => {
    await withFakeTmpdir(async (dir) => {
      const nowMs = 10 * HOUR_MS;
      const artifact = join(dir, SAMPLE_ARTIFACT);
      writeFileAgedBy(artifact, nowMs, 2 * HOUR_MS);

      // Simulate tmp squatting: the stamp path is a symlink to an unrelated file
      // the current user can write. The sweep must refuse to truncate the target.
      const victim = join(dir, "victim.txt");
      writeFileSync(victim, "important");
      symlinkSync(victim, join(dir, STAMP_BASENAME));

      await sweepStaleTmpArtifacts({
        tmpdirImpl: () => dir,
        now: () => nowMs,
      });

      expect(existsSync(artifact)).toBe(true);
      expect(readFileSync(victim, "utf8")).toBe("important");
    });
  });

  test("exclusively creates a regular-file stamp on the first run and sweeps", async () => {
    await withFakeTmpdir(async (dir) => {
      const nowMs = 10 * HOUR_MS;
      const artifact = join(dir, SAMPLE_ARTIFACT);
      writeFileAgedBy(artifact, nowMs, 2 * HOUR_MS);

      const stampPath = join(dir, STAMP_BASENAME);
      expect(existsSync(stampPath)).toBe(false);

      await sweepStaleTmpArtifacts({
        tmpdirImpl: () => dir,
        now: () => nowMs,
      });

      expect(existsSync(artifact)).toBe(false);
      expect(lstatSync(stampPath).isFile()).toBe(true);
    });
  });
});
