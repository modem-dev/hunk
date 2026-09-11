import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePathForOS, resolveCanonicalPath } from "./path";

describe("normalizePathForOS", () => {
  test("normalizes Unix-style Windows paths for native subprocess cwd", () => {
    expect(normalizePathForOS("/cygdrive/c/work/repo", "win32")).toBe("C:\\work\\repo");
    expect(normalizePathForOS("/c/work/repo", "win32")).toBe("C:\\work\\repo");
    expect(normalizePathForOS("/mnt/c/work/repo", "win32")).toBe("C:\\work\\repo");
    expect(normalizePathForOS("/c:/work/repo", "win32")).toBe("C:\\work\\repo");
    expect(normalizePathForOS("/home/project", "win32")).toBe("/home/project");
    expect(normalizePathForOS("/cygdrive/c/work/repo", "linux")).toBe("/cygdrive/c/work/repo");
    // Already-native Windows paths should pass through unchanged.
    expect(normalizePathForOS("C:\\work\\repo", "win32")).toBe("C:\\work\\repo");
    expect(normalizePathForOS("C:/work/repo", "win32")).toBe("C:/work/repo");
  });

  test("leaves paths unchanged on Unix-like platforms", () => {
    const paths = [
      "/cygdrive/c/work/repo",
      "/c/work/repo",
      "/mnt/c/work/repo",
      "/c:/work/repo",
      "/home/project",
      "/Users/project",
      "relative/path",
      "C:\\work\\repo",
      "C:/work/repo",
    ];

    for (const path of paths) {
      expect(normalizePathForOS(path, "linux")).toBe(path);
      expect(normalizePathForOS(path, "darwin")).toBe(path);
    }
  });
});

describe("resolveCanonicalPath", () => {
  test("retains canonical identity through aliases and missing descendant paths", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-vcs-canonical-test-"));
    try {
      const target = join(root, "target");
      const alias = join(root, "alias");
      mkdirSync(target);
      symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
      const canonical = resolveCanonicalPath(target);
      expect(resolveCanonicalPath(alias)).toBe(canonical);
      expect(resolveCanonicalPath(join(alias, "missing", "leaf"))).toBe(
        join(canonical, "missing", "leaf"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
