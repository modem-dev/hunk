import { describe, expect, test } from "bun:test";
import { createGitHubPrExtension } from "@hunk/gh";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const PACKAGE_ROOT = join(REPO_ROOT, "packages", "hunk-gh");

describe("@hunk/gh package boundary", () => {
  test("exports only the GitHub extension entry", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      name: string;
      private: boolean;
      files: string[];
      exports: Record<string, unknown>;
      dependencies: Record<string, string>;
    };

    expect(manifest.name).toBe("@hunk/gh");
    expect(manifest.private).toBe(true);
    expect(manifest.files).toEqual(["src"]);
    expect(manifest.exports).toEqual({
      ".": {
        types: "./src/index.ts",
        import: "./src/index.ts",
      },
    });
    expect(manifest.dependencies).toEqual({ hunkdiff: "workspace:*" });
  });

  test("registers the private workspace without leaking it into hunkdiff", () => {
    const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const hunkManifest = readFileSync(join(REPO_ROOT, "packages", "hunk", "package.json"), "utf8");
    const bunLock = readFileSync(join(REPO_ROOT, "bun.lock"), "utf8");
    const nixLock = readFileSync(join(REPO_ROOT, "nix", "bun.lock.nix"), "utf8");

    expect(rootManifest.devDependencies["@hunk/gh"]).toBe("workspace:*");
    expect(hunkManifest).not.toContain("@hunk/gh");
    expect(hunkManifest).not.toContain("workspace:");
    expect(bunLock).toContain('"packages/hunk-gh": {');
    expect(bunLock).toContain('"@hunk/gh@workspace:packages/hunk-gh"');
    expect(nixLock).toContain('"@hunk/gh" = copyPathToStore ../packages/hunk-gh;');
  });

  test("loads its extension entrypoint through the workspace", () => {
    expect(typeof createGitHubPrExtension).toBe("function");
  });
});
