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
});
