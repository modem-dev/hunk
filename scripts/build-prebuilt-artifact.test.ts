import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
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
  mkdirSync(path.join(repoRoot, "skills", "hunk-review"), { recursive: true });
  writeFileSync(path.join(repoRoot, "dist", binaryName), "#!/bin/sh\necho hunk\n", {
    mode: 0o600,
  });
  writeFileSync(path.join(repoRoot, "skills", "hunk-review", "SKILL.md"), "# Hunk review\n");

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
    rmSync(path.join(repoRoot, "skills"), { recursive: true, force: true });

    expect(() => stagePrebuiltArtifact({ repoRoot })).toThrow("Missing skills directory");
  });

  test("rejects missing bundled Hunk review skill with an actionable error", () => {
    const { repoRoot } = createTestRepo();
    rmSync(path.join(repoRoot, "skills", "hunk-review", "SKILL.md"), { force: true });

    expect(() => stagePrebuiltArtifact({ repoRoot })).toThrow("Missing bundled Hunk review skill");
  });

  test("includes the bundled skill next to standalone release binaries", () => {
    const { repoRoot, spec, binaryName } = createTestRepo();
    const outputRoot = path.join(tempRoot!, "artifacts");

    const outputDir = stagePrebuiltArtifact({ repoRoot, outputRoot });

    expect(outputDir).toBe(path.join(outputRoot, spec.packageName));
    expect(existsSync(path.join(outputDir, binaryName))).toBe(true);
    expect(existsSync(path.join(outputDir, "metadata.json"))).toBe(true);
    expect(existsSync(path.join(outputDir, "skills", "hunk-review", "SKILL.md"))).toBe(true);

    if (process.platform !== "win32") {
      expect(statSync(path.join(outputDir, binaryName)).mode & 0o111).not.toBe(0);
    }
  });
});
