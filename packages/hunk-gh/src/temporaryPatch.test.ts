import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TemporaryPatchStore } from "./temporaryPatch";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates one test-owned temporary root. */
function createTestRoot() {
  const root = mkdtempSync(join(tmpdir(), "hunk-gh-patches-test-"));
  roots.push(root);
  return root;
}

describe("TemporaryPatchStore", () => {
  test("writes, sanitizes, and removes a retained patch", async () => {
    const store = new TemporaryPatchStore(createTestRoot());
    const patch = new TextEncoder().encode("diff --git a/a b/a\n");
    const path = await store.write("../unsafe.diff", patch);
    expect(path.endsWith("..-unsafe.diff")).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("diff --git");
    if (process.platform !== "win32") {
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    await store.remove(path);
    expect(existsSync(path)).toBe(false);
  });

  test("cleans up every retained patch", async () => {
    const store = new TemporaryPatchStore(createTestRoot());
    const first = await store.write("first.diff", new TextEncoder().encode("first"));
    const second = await store.write("second.diff", new TextEncoder().encode("second"));
    store.cleanup();
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    store.cleanup();
  });
});
