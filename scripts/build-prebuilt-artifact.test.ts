import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { BUNDLED_SKILL_NAMES } from "../packages/hunk/src/core/run/paths";
import { stagePrebuiltArtifact } from "./build-prebuilt-artifact";
import { binaryFilenameForSpec, getHostPlatformPackageSpec } from "./prebuilt-package-helpers";

let tempRoot: string | undefined;

/** Create a disposable repository shape for release artifact staging tests. */
function createTestRepo() {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "hunk-prebuilt-artifact-"));
  const repoRoot = path.join(tempRoot, "repo");
  const spec = getHostPlatformPackageSpec();
  const binaryName = binaryFilenameForSpec(spec);

  mkdirSync(path.join(repoRoot, "dist"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", binaryName), "#!/bin/sh\necho hunk\n", {
    mode: 0o600,
  });

  for (const skillName of BUNDLED_SKILL_NAMES) {
    const directory = path.join(repoRoot, "packages", "hunk", "skills", skillName);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "SKILL.md"), `# ${skillName}\n`);
  }

  // Maintainer-only skills the artifact must leave behind.
  for (const skillName of ["hunk-launch-video", "hunk-release"]) {
    const directory = path.join(repoRoot, "skills", skillName);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "SKILL.md"), `# ${skillName}\n`);
  }

  return { repoRoot, spec, binaryName };
}

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("stagePrebuiltArtifact", () => {
  test("rejects missing skills directory with an actionable error", () => {
    const { repoRoot } = createTestRepo();
    rmSync(path.join(repoRoot, "packages", "hunk", "skills"), { recursive: true, force: true });

    expect(() => stagePrebuiltArtifact({ repoRoot })).toThrow("Missing skills directory");
  });

  test("rejects a missing bundled skill with an actionable error", () => {
    const { repoRoot } = createTestRepo();
    rmSync(path.join(repoRoot, "packages", "hunk", "skills", "hunk-review", "SKILL.md"), {
      force: true,
    });

    expect(() => stagePrebuiltArtifact({ repoRoot })).toThrow(
      "Missing bundled Hunk hunk-review skill",
    );
  });

  test("rejects a missing bundled skill added after the first one", () => {
    const { repoRoot } = createTestRepo();
    rmSync(path.join(repoRoot, "packages", "hunk", "skills", "hunk-extensions", "SKILL.md"), {
      force: true,
    });

    expect(() => stagePrebuiltArtifact({ repoRoot })).toThrow(
      "Missing bundled Hunk hunk-extensions skill",
    );
  });

  test("includes every bundled skill next to standalone release binaries", () => {
    const { repoRoot, spec, binaryName } = createTestRepo();
    const outputRoot = path.join(tempRoot!, "artifacts");

    const outputDir = stagePrebuiltArtifact({ repoRoot, outputRoot });

    expect(outputDir).toBe(path.join(outputRoot, spec.packageName));
    expect(existsSync(path.join(outputDir, binaryName))).toBe(true);
    expect(existsSync(path.join(outputDir, "metadata.json"))).toBe(true);
    for (const skillName of BUNDLED_SKILL_NAMES) {
      expect(existsSync(path.join(outputDir, "skills", skillName, "SKILL.md"))).toBe(true);
    }

    // Maintainer-only skills reference scripts no artifact ships, so they stay out.
    for (const skillName of ["hunk-launch-video", "hunk-release"]) {
      expect(existsSync(path.join(outputDir, "skills", skillName))).toBe(false);
    }

    if (process.platform !== "win32") {
      expect(statSync(path.join(outputDir, binaryName)).mode & 0o111).not.toBe(0);
    }
  });
});
