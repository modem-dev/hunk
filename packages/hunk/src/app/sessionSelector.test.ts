import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledVcsCatalog } from "./vcsCatalog";
import { resolveSessionSelectorBoundary } from "./sessionSelector";

const tempDirs: string[] = [];

/** Create one portable temporary directory tracked for cleanup. */
function createTempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunk-session-selector-")));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveSessionSelectorBoundary", () => {
  test("attaches the outer checkout root for an ordinary subdirectory", () => {
    const repo = createTempDir();
    const nested = join(repo, "src", "deep");
    mkdirSync(join(repo, ".git"));
    mkdirSync(nested, { recursive: true });

    expect(resolveSessionSelectorBoundary({ repoRoot: nested }, getBundledVcsCatalog())).toEqual({
      repoRoot: nested,
      repoBoundary: repo,
    });
  });

  test("attaches a recognized nested checkout instead of its outer checkout", () => {
    const outer = createTempDir();
    const inner = join(outer, "vendor", "nested");
    const source = join(inner, "src");
    mkdirSync(join(outer, ".git"));
    mkdirSync(join(inner, ".git"), { recursive: true });
    mkdirSync(source);

    expect(resolveSessionSelectorBoundary({ repoRoot: source }, getBundledVcsCatalog())).toEqual({
      repoRoot: source,
      repoBoundary: inner,
    });
  });

  test("leaves selectors without a known project boundary unchanged", () => {
    const directory = createTempDir();
    const selector = { repoRoot: directory };

    expect(resolveSessionSelectorBoundary(selector, getBundledVcsCatalog())).toBe(selector);
  });
});
