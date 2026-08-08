import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeStableNativeLibPath, resolveNativeCacheRoot } from "./nativeLibMaterialize";

const LIB_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const OTHER_VERSION_BYTES = new Uint8Array([9, 9, 9]);
const HOUR_MS = 60 * 60 * 1000;

let dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirsToClean = [];
});

/** Create a throwaway cache root that is always cleaned up. */
function fakeCacheRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "hunk-native-lib-test-"));
  dirsToClean.push(dir);
  return dir;
}

/** Expected content-addressed file name for the given bytes. */
function expectedName(bytes: Uint8Array, libFileName = "libopentui.so"): string {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const dot = libFileName.lastIndexOf(".");
  return `${libFileName.slice(0, dot)}-${hash}${libFileName.slice(dot)}`;
}

/** Deps pointing at a fake cache root with a fixed embedded payload. */
function testDeps(cacheRoot: string, bytes: Uint8Array = LIB_BYTES, now?: number) {
  return {
    cacheRootImpl: () => cacheRoot,
    readEmbedded: async () => bytes,
    ...(now === undefined ? {} : { now: () => now }),
  };
}

describe("resolveNativeCacheRoot", () => {
  test("prefers XDG_CACHE_HOME on Linux", () => {
    expect(
      resolveNativeCacheRoot(
        { XDG_CACHE_HOME: "/xdg" },
        () => "linux",
        () => "/home/u",
      ),
    ).toBe("/xdg");
  });

  test("falls back to ~/.cache on Linux", () => {
    expect(
      resolveNativeCacheRoot(
        {},
        () => "linux",
        () => "/home/u",
      ),
    ).toBe(join("/home/u", ".cache"));
  });

  test("uses ~/Library/Caches on macOS", () => {
    expect(
      resolveNativeCacheRoot(
        {},
        () => "darwin",
        () => "/Users/u",
      ),
    ).toBe(join("/Users/u", "Library", "Caches"));
  });

  test("prefers LOCALAPPDATA on Windows", () => {
    expect(
      resolveNativeCacheRoot(
        { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        () => "win32",
        () => "C:\\Users\\u",
      ),
    ).toBe("C:\\Users\\u\\AppData\\Local");
  });

  test("falls back to ~/AppData/Local on Windows", () => {
    expect(
      resolveNativeCacheRoot(
        {},
        () => "win32",
        () => "C:\\Users\\u",
      ),
    ).toBe(join("C:\\Users\\u", "AppData", "Local"));
  });
});

describe("materializeStableNativeLibPath", () => {
  test("writes the library to the content-addressed path and returns it", async () => {
    const cacheRoot = fakeCacheRoot();

    const result = await materializeStableNativeLibPath(
      "/$bunfs/root/libopentui.so",
      "libopentui.so",
      testDeps(cacheRoot),
    );

    const expected = join(cacheRoot, "hunk", "native", expectedName(LIB_BYTES));
    expect(result).toBe(expected);
    expect(readFileSync(result)).toEqual(Buffer.from(LIB_BYTES));
    // The exec bit only exists on POSIX filesystems.
    if (process.platform !== "win32") {
      expect(statSync(result).mode & 0o111).not.toBe(0);
    }
  });

  test("reuses the existing file without rewriting it", async () => {
    const cacheRoot = fakeCacheRoot();
    const deps = testDeps(cacheRoot);

    const first = await materializeStableNativeLibPath("/embedded", "libopentui.so", deps);
    const firstMtime = statSync(first).mtimeMs;
    const second = await materializeStableNativeLibPath("/embedded", "libopentui.so", deps);

    expect(second).toBe(first);
    expect(statSync(second).mtimeMs).toBe(firstMtime);
    expect(readdirSync(join(cacheRoot, "hunk", "native"))).toHaveLength(1);
  });

  test("keeps distinct library versions side by side", async () => {
    const cacheRoot = fakeCacheRoot();
    const now = 10 * HOUR_MS;

    const first = await materializeStableNativeLibPath(
      "/embedded",
      "libopentui.so",
      testDeps(cacheRoot, LIB_BYTES, now),
    );
    // Fresh files are never pruned, so a same-run version change leaves both.
    const second = await materializeStableNativeLibPath(
      "/embedded",
      "libopentui.so",
      testDeps(cacheRoot, OTHER_VERSION_BYTES, now),
    );

    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  test("prunes stale superseded versions once they are old", async () => {
    const cacheRoot = fakeCacheRoot();
    const now = 10 * HOUR_MS;

    const old = await materializeStableNativeLibPath(
      "/embedded",
      "libopentui.so",
      testDeps(cacheRoot, LIB_BYTES, now),
    );
    // Age the old version beyond the prune guard, then materialize a new one.
    const oldTime = (now - 2 * HOUR_MS) / 1000;
    utimesSync(old, oldTime, oldTime);

    const current = await materializeStableNativeLibPath(
      "/embedded",
      "libopentui.so",
      testDeps(cacheRoot, OTHER_VERSION_BYTES, now),
    );

    expect(existsSync(old)).toBe(false);
    expect(existsSync(current)).toBe(true);
  });

  test("falls back to the embedded path when the cache root is not writable", async () => {
    const cacheRoot = fakeCacheRoot();
    // A regular file where the cache dir must be created makes mkdir fail.
    const blockingFile = join(cacheRoot, "hunk");
    writeFileSync(blockingFile, "occupied");

    const result = await materializeStableNativeLibPath(
      "/$bunfs/root/libopentui.so",
      "libopentui.so",
      testDeps(cacheRoot),
    );

    expect(result).toBe("/$bunfs/root/libopentui.so");
  });

  test("falls back to the embedded path when the embedded bytes cannot be read", async () => {
    const cacheRoot = fakeCacheRoot();

    const result = await materializeStableNativeLibPath("/missing", "libopentui.so", {
      cacheRootImpl: () => cacheRoot,
      readEmbedded: async () => {
        throw new Error("no such embedded file");
      },
    });

    expect(result).toBe("/missing");
  });

  test("preserves the library file extension in the cache name", async () => {
    const cacheRoot = fakeCacheRoot();

    const result = await materializeStableNativeLibPath(
      "/embedded",
      "opentui.dll",
      testDeps(cacheRoot),
    );

    expect(result.endsWith(".dll")).toBe(true);
    expect(result).toContain("opentui-");
  });

  test("leaves unrelated files in the cache dir alone", async () => {
    const cacheRoot = fakeCacheRoot();
    const nativeDir = join(cacheRoot, "hunk", "native");
    mkdirSync(nativeDir, { recursive: true });
    const unrelated = join(nativeDir, "README.txt");
    writeFileSync(unrelated, "not a library");
    const otherLib = join(nativeDir, "unrelated-deadbeef.so");
    writeFileSync(otherLib, "x");
    const longAgo = (Date.now() - 2 * HOUR_MS) / 1000;
    utimesSync(otherLib, longAgo, longAgo);

    await materializeStableNativeLibPath("/embedded", "libopentui.so", testDeps(cacheRoot));

    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(otherLib)).toBe(true);
  });
});
