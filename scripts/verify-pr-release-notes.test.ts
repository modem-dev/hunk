import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { removeTestDirectory } from "../test/helpers/filesystem";
import {
  isGeneratedPrereleasePreparation,
  isGeneratedReleasePath,
  validateGeneratedPrerelease,
  verifyPrReleaseNotes,
} from "./verify-pr-release-notes";

const tempRoots: string[] = [];
const generatedPaths = [
  ".changeset/pre.json",
  ".changeset/old-fix.md",
  "CHANGELOG.md",
  "packages/hunk/package.json",
  "benchmarks/release/bench-0.18.0-beta.0.json",
];

function validInput() {
  return {
    packageJson: { name: "hunkdiff", version: "0.18.0-beta.0" },
    pre: {
      mode: "pre",
      tag: "beta",
      initialVersions: { hunkdiff: "0.17.7" },
      changesets: ["new-feature", "old-fix"],
    },
    changelog: "# Changelog\n\n## 0.18.0-beta.0\n\n- Added a feature.\n\n## 0.17.7\n",
    changesetIdsOnDisk: new Set(["new-feature", "old-fix"]),
  };
}

function runGit(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function writeJson(filePath: string, value: unknown) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createTestRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "hunk-pr-release-notes-"));
  tempRoots.push(root);
  mkdirSync(path.join(root, ".changeset"));
  mkdirSync(path.join(root, "packages", "hunk"), { recursive: true });
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.email", "test@example.com"]);
  runGit(root, ["config", "user.name", "Hunk Test"]);

  writeJson(path.join(root, "package.json"), {
    name: "@hunk/workspace",
    private: true,
    scripts: { "changeset:status": "bun run ./record-status.ts" },
  });
  writeJson(path.join(root, "packages", "hunk", "package.json"), {
    name: "hunkdiff",
    version: "0.17.7",
  });
  writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n");
  writeFileSync(path.join(root, ".changeset", "new-feature.md"), "---\n---\n");
  writeFileSync(
    path.join(root, "record-status.ts"),
    'await Bun.write("status-call.json", JSON.stringify(process.argv.slice(2)));\n',
  );
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "--quiet", "-m", "base"]);
  return { root, base: runGit(root, ["rev-parse", "HEAD"]) };
}

function writeGeneratedPrerelease(root: string, initialVersion = "0.17.7") {
  const packageJson = JSON.parse(
    readFileSync(path.join(root, "packages", "hunk", "package.json"), "utf8"),
  );
  packageJson.version = "0.18.0-beta.0";
  writeJson(path.join(root, "packages", "hunk", "package.json"), packageJson);
  writeJson(path.join(root, ".changeset", "pre.json"), {
    mode: "pre",
    tag: "beta",
    initialVersions: { hunkdiff: initialVersion },
    changesets: ["new-feature"],
  });
  writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.18.0-beta.0\n\n## 0.17.7\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "--quiet", "-m", "prepare prerelease"]);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => removeTestDirectory(root)));
});

describe("isGeneratedReleasePath", () => {
  test("accepts only generated prerelease metadata", () => {
    for (const filePath of generatedPaths) {
      expect(isGeneratedReleasePath(filePath)).toBe(true);
    }

    expect(isGeneratedReleasePath("packages/hunk/src/main.tsx")).toBe(false);
    expect(isGeneratedReleasePath("benchmarks/run.ts")).toBe(false);
    expect(isGeneratedReleasePath("bun.lock")).toBe(false);
  });
});

describe("isGeneratedPrereleasePreparation", () => {
  test("selects a metadata-only diff that changes prerelease state", () => {
    expect(isGeneratedPrereleasePreparation(generatedPaths)).toBe(true);
  });

  test("keeps ordinary changesets on the standard status path", () => {
    expect(
      isGeneratedPrereleasePreparation(["packages/hunk/src/main.tsx", ".changeset/fix.md"]),
    ).toBe(false);
    expect(isGeneratedPrereleasePreparation(["CHANGELOG.md", "packages/hunk/package.json"])).toBe(
      false,
    );
  });

  test("does not exempt release preparation mixed with source changes", () => {
    expect(
      isGeneratedPrereleasePreparation([...generatedPaths, "packages/hunk/src/main.tsx"]),
    ).toBe(false);
  });
});

describe("validateGeneratedPrerelease", () => {
  test("accepts coherent generated prerelease state", () => {
    expect(() => validateGeneratedPrerelease(validInput())).not.toThrow();
  });

  test("requires package version and tag agreement", () => {
    const input = validInput();
    input.packageJson.version = "0.18.0-next.0";

    expect(() => validateGeneratedPrerelease(input)).toThrow("does not match prerelease tag beta");
  });

  test("requires a stable initial package version", () => {
    const input = validInput();
    input.pre.initialVersions.hunkdiff = "0.17.7-beta.1";

    expect(() => validateGeneratedPrerelease(input)).toThrow(
      "Missing stable initial version for package hunkdiff",
    );
  });

  test("requires the latest stable changelog version", () => {
    const input = validInput();
    input.pre.initialVersions.hunkdiff = "0.17.6";
    input.changelog += "\n## 0.17.6\n";

    expect(() => validateGeneratedPrerelease(input)).toThrow(
      "Initial version 0.17.6 does not match latest stable release 0.17.7",
    );
  });

  test("requires every consumed changeset to remain on disk", () => {
    const input = validInput();
    input.changesetIdsOnDisk.delete("old-fix");

    expect(() => validateGeneratedPrerelease(input)).toThrow(
      "Missing consumed changeset files: old-fix",
    );
  });

  test("rejects duplicate changeset IDs", () => {
    const input = validInput();
    input.pre.changesets = ["old-fix", "old-fix"];

    expect(() => validateGeneratedPrerelease(input)).toThrow("invalid or duplicate changeset IDs");
  });

  test("requires the exact package version heading", () => {
    const input = validInput();
    input.changelog = "# Changelog\n\n## 0.18.0-beta.1\n\n## 0.17.7\n";

    expect(() => validateGeneratedPrerelease(input)).toThrow(
      "Changelog is missing the 0.18.0-beta.0 release heading",
    );
  });
});

describe("verifyPrReleaseNotes", () => {
  test("routes ordinary diffs through Changesets with the exact base revision", async () => {
    const { root, base } = createTestRepo();
    writeFileSync(path.join(root, "source.ts"), "export const changed = true;\n");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "--quiet", "-m", "ordinary change"]);

    await expect(verifyPrReleaseNotes(base, "HEAD", root)).resolves.toBe("changeset-status");
    expect(JSON.parse(readFileSync(path.join(root, "status-call.json"), "utf8"))).toEqual([
      `--since=${base}`,
    ]);
  });

  test("routes metadata-only prerelease output through generated-state validation", async () => {
    const { root, base } = createTestRepo();
    writeGeneratedPrerelease(root);

    await expect(verifyPrReleaseNotes(base, "HEAD", root)).resolves.toBe("generated-prerelease");
    expect(existsSync(path.join(root, "status-call.json"))).toBe(false);
  });

  // Hosted Windows can spend more than Bun's default deadline on the two fixture commits.
  test("routes a stable promotion that removes prerelease state through Changesets", async () => {
    const { root } = createTestRepo();
    writeGeneratedPrerelease(root);
    const prereleaseBase = runGit(root, ["rev-parse", "HEAD"]);
    const packageJson = JSON.parse(
      readFileSync(path.join(root, "packages", "hunk", "package.json"), "utf8"),
    );
    packageJson.version = "0.18.0";
    writeJson(path.join(root, "packages", "hunk", "package.json"), packageJson);
    writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.18.0\n\n## 0.17.7\n");
    rmSync(path.join(root, ".changeset", "pre.json"));
    rmSync(path.join(root, ".changeset", "new-feature.md"));
    writeFileSync(path.join(root, ".changeset", "stable-release.md"), "---\n---\n");
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "--quiet", "-m", "prepare stable release"]);

    await expect(verifyPrReleaseNotes(prereleaseBase, "HEAD", root)).resolves.toBe(
      "changeset-status",
    );
    expect(JSON.parse(readFileSync(path.join(root, "status-call.json"), "utf8"))).toEqual([
      `--since=${prereleaseBase}`,
    ]);
  }, 10_000);

  test("rejects an initial version older than the carried stable changelog", async () => {
    const { root, base } = createTestRepo();
    writeGeneratedPrerelease(root, "0.17.6");

    await expect(verifyPrReleaseNotes(base, "HEAD", root)).rejects.toThrow(
      "Initial version 0.17.6 does not match latest stable release 0.17.7",
    );
  });
});
