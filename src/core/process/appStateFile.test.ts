import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppStateRecord, updateAppStateRecord, writeAppStateRecord } from "./appStateFile";

const tempDirs: string[] = [];

/** Create one isolated directory to hold a state file for a single test. */
function createTempStatePath() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-state-"));
  tempDirs.push(dir);
  return { dir, path: join(dir, "state.json") };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("hunk state file", () => {
  test("round-trips a record through a directory that does not exist yet", () => {
    const { dir } = createTempStatePath();
    const nested = join(dir, "nested", "state.json");

    writeAppStateRecord(nested, { extensionTrust: { "/repo": "trusted" } });

    expect(readAppStateRecord(nested)).toEqual({ extensionTrust: { "/repo": "trusted" } });
  });

  test("reads a missing or empty file as an empty record", () => {
    const { path } = createTempStatePath();

    expect(readAppStateRecord(path)).toEqual({});

    writeFileSync(path, "   \n");
    expect(readAppStateRecord(path)).toEqual({});
  });

  test("merges a patch without disturbing unrelated keys", () => {
    const { path } = createTempStatePath();
    writeAppStateRecord(path, {
      updateNotice: { lastCheck: 1 },
      extensionTrust: { "/a": "denied" },
    });

    const next = updateAppStateRecord(path, { extensionTrust: { "/b": "trusted" } });

    expect(next).toEqual({ updateNotice: { lastCheck: 1 }, extensionTrust: { "/b": "trusted" } });
    expect(readAppStateRecord(path)).toEqual(next);
  });

  test("preserves a corrupt file instead of overwriting it silently", () => {
    const { path } = createTempStatePath();
    writeFileSync(path, '{"extensionTrust": {"/repo": "trus');

    updateAppStateRecord(path, { extensionTrust: { "/repo": "denied" } });

    // The damaged bytes stay recoverable next to the state file...
    expect(readFileSync(`${path}.corrupt`, "utf8")).toBe('{"extensionTrust": {"/repo": "trus');
    // ...and the session can still record new decisions.
    expect(readAppStateRecord(path)).toEqual({ extensionTrust: { "/repo": "denied" } });
  });

  test("treats a non-object JSON document as corrupt", () => {
    const { path } = createTempStatePath();
    writeFileSync(path, "[1, 2, 3]");

    expect(readAppStateRecord(path)).toEqual({});

    updateAppStateRecord(path, { updateNotice: { lastCheck: 2 } });

    expect(existsSync(`${path}.corrupt`)).toBe(true);
    expect(readAppStateRecord(path)).toEqual({ updateNotice: { lastCheck: 2 } });
  });

  test("stages writes in a sibling temp file and leaves none behind", () => {
    const { dir, path } = createTempStatePath();

    writeAppStateRecord(path, { updateNotice: { lastCheck: 1 } });
    writeAppStateRecord(path, { updateNotice: { lastCheck: 2 } });

    // A leftover temp file means the rename step did not run, which is also the
    // shape a torn write would leave behind.
    expect(readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(dir)).toEqual(["state.json"]);
    expect(readAppStateRecord(path)).toEqual({ updateNotice: { lastCheck: 2 } });
  });

  test("keeps the state file owner-only on POSIX", () => {
    if (process.platform === "win32") {
      // Windows has no POSIX mode bits to assert on.
      return;
    }

    const { path } = createTempStatePath();
    writeAppStateRecord(path, { extensionTrust: {} });

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
