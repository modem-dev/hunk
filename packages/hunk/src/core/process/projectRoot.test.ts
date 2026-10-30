import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findProjectRootCandidate } from "./projectRoot";
import { createVcsCatalog } from "../vcs";
import type { VcsAdapter } from "../vcs/types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunk-project-root-")));
  tempDirs.push(dir);
  return dir;
}

/** Build a marker adapter for project-root precedence tests. */
function markerAdapter(marker: string): VcsAdapter {
  return {
    id: "custom",
    name: "Custom",
    operations: {},
    detect(cwd) {
      let current = cwd;
      for (;;) {
        if (existsSync(join(current, marker))) {
          return { id: "custom", repoRoot: current };
        }
        const parent = dirname(current);
        if (parent === current) {
          return null;
        }
        current = parent;
      }
    },
  };
}

describe("findProjectRootCandidate", () => {
  test("uses .hunk as a provider-independent bootstrap marker", () => {
    const repo = tempDir();
    const nested = join(repo, "src", "deep");
    mkdirSync(join(repo, ".hunk"));
    mkdirSync(nested, { recursive: true });

    expect(findProjectRootCandidate(nested)).toBe(repo);
  });

  test("ignores a plain file named .hunk", () => {
    const directory = tempDir();
    const nested = join(directory, "src");
    writeFileSync(join(directory, ".hunk"), "not a project directory\n");
    mkdirSync(nested);

    expect(findProjectRootCandidate(nested)).toBeUndefined();
  });

  test("chooses the nearest .hunk or registered VCS root", () => {
    const outer = tempDir();
    const inner = join(outer, "inner");
    const nested = join(inner, "src");
    mkdirSync(join(outer, ".custom"));
    mkdirSync(join(inner, ".hunk"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    const catalog = createVcsCatalog([markerAdapter(".custom")], "custom");

    expect(findProjectRootCandidate(nested, catalog)).toBe(inner);
  });
});
