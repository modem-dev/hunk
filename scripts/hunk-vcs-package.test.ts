import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PACKAGE_ROOT = join(REPO_ROOT, "packages", "hunk-vcs");
const EXPECTED_EXPORTS = ["./async-process", "./diff-target", "./large-file", "./path", "./source"];
const tempDirs: string[] = [];

/** Create one temporary package consumer tracked for cleanup. */
function createTempConsumer() {
  const directory = mkdtempSync(join(tmpdir(), "hunk-vcs-package-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("@hunk/vcs package boundary", () => {
  test("exports only explicit implementation leaves", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      name: string;
      private: boolean;
      files: string[];
      exports: Record<string, unknown>;
      dependencies?: Record<string, string>;
    };

    expect(manifest.name).toBe("@hunk/vcs");
    expect(manifest.private).toBe(true);
    expect(manifest.files).toEqual(["src"]);
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(Object.keys(manifest.exports).sort()).toEqual(EXPECTED_EXPORTS);
    expect(manifest.exports["."]).toBeUndefined();
  });

  test("registers the private workspace without leaking it into hunkdiff", () => {
    const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const hunkManifest = readFileSync(join(REPO_ROOT, "packages", "hunk", "package.json"), "utf8");
    const bunLock = readFileSync(join(REPO_ROOT, "bun.lock"), "utf8");
    const nixLock = readFileSync(join(REPO_ROOT, "nix", "bun.lock.nix"), "utf8");

    expect(rootManifest.devDependencies["@hunk/vcs"]).toBe("workspace:*");
    expect(hunkManifest).not.toContain("@hunk/vcs");
    expect(hunkManifest).not.toContain("workspace:");
    expect(bunLock).toContain('"packages/hunk-vcs": {');
    expect(bunLock).toContain('"@hunk/vcs@workspace:packages/hunk-vcs"');
    expect(nixLock).toContain('"@hunk/vcs" = copyPathToStore ../packages/hunk-vcs;');
  });

  test("resolves its structural diff helper from an isolated package copy", () => {
    const consumerRoot = createTempConsumer();
    const installedPackage = join(consumerRoot, "node_modules", "@hunk", "vcs");
    cpSync(PACKAGE_ROOT, installedPackage, { recursive: true });
    writeFileSync(
      join(consumerRoot, "consumer.ts"),
      [
        'import { describeDiffRange } from "@hunk/vcs/diff-target";',
        'const input = { range: "main" };',
        "const description: string | undefined = describeDiffRange(input);",
        "void description;",
      ].join("\n"),
    );
    writeFileSync(
      join(consumerRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          lib: ["ESNext", "DOM"],
          types: [],
        },
        files: ["consumer.ts"],
      }),
    );

    const result = Bun.spawnSync(
      [
        process.execPath,
        join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        join(consumerRoot, "tsconfig.json"),
      ],
      { cwd: consumerRoot, stdout: "pipe", stderr: "pipe" },
    );
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
