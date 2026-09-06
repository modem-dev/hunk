import { describe, expect, test } from "bun:test";
import gitExtension, { GitVcsAdapter } from "@hunk/git";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PACKAGE_ROOT = join(REPO_ROOT, "packages", "hunk-git");

describe("@hunk/git package boundary", () => {
  test("exports only the explicit Git provider entry", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      name: string;
      private: boolean;
      files: string[];
      exports: Record<string, unknown>;
      dependencies: Record<string, string>;
    };

    expect(manifest.name).toBe("@hunk/git");
    expect(manifest.private).toBe(true);
    expect(manifest.files).toEqual(["src"]);
    expect(manifest.exports).toEqual({
      ".": {
        types: "./src/index.ts",
        import: "./src/index.ts",
      },
    });
    expect(manifest.dependencies).toEqual({
      "@hunk/vcs": "workspace:*",
      hunkdiff: "workspace:*",
    });
  });

  test("registers the private workspace without leaking it into hunkdiff", () => {
    const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const hunkManifest = readFileSync(join(REPO_ROOT, "packages", "hunk", "package.json"), "utf8");
    const bunLock = readFileSync(join(REPO_ROOT, "bun.lock"), "utf8");
    const nixLock = readFileSync(join(REPO_ROOT, "nix", "bun.lock.nix"), "utf8");

    expect(rootManifest.devDependencies["@hunk/git"]).toBe("workspace:*");
    expect(hunkManifest).not.toContain("@hunk/git");
    expect(hunkManifest).not.toContain("workspace:");
    expect(bunLock).toContain('"packages/hunk-git": {');
    expect(bunLock).toContain('"@hunk/git@workspace:packages/hunk-git"');
    expect(nixLock).toContain('"@hunk/git" = copyPathToStore ../packages/hunk-git;');
  });

  test("loads its provider entrypoint through the workspace", () => {
    expect(typeof gitExtension).toBe("function");
    expect(GitVcsAdapter.id).toBe("git");
  });
});
