import { describe, expect, test } from "bun:test";
import { normalizePathForOS } from "./osPath";

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
