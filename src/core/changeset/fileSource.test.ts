import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSourceFetcher, SourceTextTooLargeError } from "./fileSource";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

describe("createFileSourceFetcher", () => {
  test("reads fs paths for old and new sides", async () => {
    const dir = createTempDir("hunk-source-fs-");
    const left = join(dir, "before.txt");
    const right = join(dir, "after.txt");
    writeFileSync(left, "old contents\n");
    writeFileSync(right, "new contents\n");

    const fetcher = createFileSourceFetcher({
      old: { kind: "fs", absolutePath: left },
      new: { kind: "fs", absolutePath: right },
    });

    expect(await fetcher.getFullText("old")).toBe("old contents\n");
    expect(await fetcher.getFullText("new")).toBe("new contents\n");
  });

  test("returns null for `none` specs", async () => {
    const fetcher = createFileSourceFetcher({
      old: { kind: "none" },
      new: { kind: "none" },
    });

    expect(await fetcher.getFullText("old")).toBeNull();
    expect(await fetcher.getFullText("new")).toBeNull();
  });

  test("returns null when an fs path cannot be read", async () => {
    const dir = createTempDir("hunk-source-fs-missing-");
    const fetcher = createFileSourceFetcher({
      old: { kind: "fs", absolutePath: join(dir, "missing.txt") },
      new: { kind: "none" },
    });

    expect(await fetcher.getFullText("old")).toBeNull();
  });

  test("rejects fs source reads that exceed the configured byte cap", async () => {
    const dir = createTempDir("hunk-source-fs-large-");
    const target = join(dir, "large.txt");
    writeFileSync(target, "0123456789\n");

    const fetcher = createFileSourceFetcher(
      {
        old: { kind: "fs", absolutePath: target },
        new: { kind: "none" },
      },
      { maxSourceBytes: 5 },
    );

    await expect(fetcher.getFullText("old")).rejects.toBeInstanceOf(SourceTextTooLargeError);
  });

  test("caches resolved text per side", async () => {
    const dir = createTempDir("hunk-source-cache-");
    const target = join(dir, "value.txt");
    writeFileSync(target, "first\n");

    const fetcher = createFileSourceFetcher({
      old: { kind: "none" },
      new: { kind: "fs", absolutePath: target },
    });

    const initial = await fetcher.getFullText("new");
    writeFileSync(target, "rewritten\n");
    const cached = await fetcher.getFullText("new");

    expect(initial).toBe("first\n");
    expect(cached).toBe("first\n");
  });
});
