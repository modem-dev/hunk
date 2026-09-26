import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoots: string[] = [];
const detectorPath = path.resolve(import.meta.dir, "../../.github/scripts/detect-code-changes.sh");

afterEach(() => {
  for (const root of repositoryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Run Git in a temporary repository and fail with its diagnostic output. */
function runGit(repositoryRoot: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repositoryRoot });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString());
  }
  return result.stdout.toString().trim();
}

/** Evaluate the change detector against files added after an initial commit. */
function detectAddedPaths(paths: string[]): Record<string, string> {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), "hunk-detect-code-changes-"));
  const outputPath = path.join(repositoryRoot, "github-output.txt");
  repositoryRoots.push(repositoryRoot);

  runGit(repositoryRoot, ["init", "--quiet"]);
  runGit(repositoryRoot, ["config", "user.email", "tests@hunk.dev"]);
  runGit(repositoryRoot, ["config", "user.name", "Hunk Tests"]);
  writeFileSync(path.join(repositoryRoot, ".seed"), "initial\n");
  runGit(repositoryRoot, ["add", ".seed"]);
  runGit(repositoryRoot, ["commit", "--quiet", "-m", "initial"]);
  const baseSha = runGit(repositoryRoot, ["rev-parse", "HEAD"]);

  for (const changedPath of paths) {
    const absolutePath = path.join(repositoryRoot, changedPath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, `${changedPath}\n`);
  }
  runGit(repositoryRoot, ["add", "."]);
  runGit(repositoryRoot, ["commit", "--quiet", "-m", "changes"]);
  const headSha = runGit(repositoryRoot, ["rev-parse", "HEAD"]);

  const result = Bun.spawnSync(["bash", detectorPath, baseSha, headSha], {
    cwd: repositoryRoot,
    env: { ...process.env, GITHUB_OUTPUT: outputPath },
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString());
  }

  return Object.fromEntries(
    readFileSync(outputPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2)),
  );
}

const nixLockInputs = [
  "bun.lock",
  "bunfig.toml",
  "package.json",
  "packages/hunk/package.json",
  "flake.nix",
  "flake.lock",
  "nix/bun.lock.nix",
];

describe("CI code-change detection", () => {
  for (const lockInput of nixLockInputs) {
    test.skipIf(process.platform === "win32")(`classifies ${lockInput} as a Nix lock input`, () => {
      expect(detectAddedPaths([lockInput])).toEqual({
        code_changed: "true",
        nix_lock_changed: "true",
      });
    });
  }

  test.skipIf(process.platform === "win32")(
    "does not classify unrelated code as a lock input",
    () => {
      expect(detectAddedPaths(["packages/hunk/src/main.tsx"])).toEqual({
        code_changed: "true",
        nix_lock_changed: "false",
      });
    },
  );

  test.skipIf(process.platform === "win32")("keeps docs-only changes out of both gates", () => {
    expect(detectAddedPaths(["docs/configuration.md"])).toEqual({
      code_changed: "false",
      nix_lock_changed: "false",
    });
  });

  test.skipIf(process.platform === "win32")("detects a lock input in a mixed-file change", () => {
    expect(detectAddedPaths(["docs/configuration.md", "packages/hunk/package.json"])).toEqual({
      code_changed: "true",
      nix_lock_changed: "true",
    });
  });
});
