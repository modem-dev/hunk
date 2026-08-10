import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { BUNDLED_SKILL_NAMES } from "../src/core/paths";
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
  mkdirSync(path.join(repoRoot, "src", "browser"), { recursive: true });
  cpSync(
    path.resolve(import.meta.dir, "../src/browser/assets"),
    path.join(repoRoot, "src/browser/assets"),
    { recursive: true },
  );
  cpSync(
    path.resolve(import.meta.dir, "../src/browser/generated"),
    path.join(repoRoot, "src/browser/generated"),
    { recursive: true },
  );
  writeFileSync(path.join(repoRoot, "dist", binaryName), "#!/bin/sh\necho hunk\n", {
    mode: 0o600,
  });

  for (const skillName of BUNDLED_SKILL_NAMES) {
    mkdirSync(path.join(repoRoot, "skills", skillName), { recursive: true });
    writeFileSync(path.join(repoRoot, "skills", skillName, "SKILL.md"), `# ${skillName}\n`);
  }

  // A maintainer-only skill the artifact must leave behind.
  mkdirSync(path.join(repoRoot, "skills", "launch-video"), { recursive: true });
  writeFileSync(path.join(repoRoot, "skills", "launch-video", "SKILL.md"), "# Launch video\n");

  return { repoRoot, spec, binaryName };
}

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("stagePrebuiltArtifact", () => {
  test("rejects missing embedded browser assets with an actionable error", () => {
    const { repoRoot } = createTestRepo();
    rmSync(path.join(repoRoot, "src", "browser", "generated"), { recursive: true, force: true });

    expect(() => stagePrebuiltArtifact({ repoRoot })).toThrow("Missing generated browser assets");
  });

  test("rejects missing skills directory with an actionable error", () => {
    const { repoRoot } = createTestRepo();
    rmSync(path.join(repoRoot, "skills"), { recursive: true, force: true });

    expect(() => stagePrebuiltArtifact({ repoRoot })).toThrow("Missing skills directory");
  });

  test("rejects a missing bundled skill with an actionable error", () => {
    const { repoRoot } = createTestRepo();
    rmSync(path.join(repoRoot, "skills", "hunk-review", "SKILL.md"), { force: true });

    expect(() => stagePrebuiltArtifact({ repoRoot })).toThrow(
      "Missing bundled Hunk hunk-review skill",
    );
  });

  test("rejects a missing bundled skill added after the first one", () => {
    const { repoRoot } = createTestRepo();
    rmSync(path.join(repoRoot, "skills", "hunk-extensions", "SKILL.md"), { force: true });

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
    expect(existsSync(path.join(outputDir, "skills", "launch-video"))).toBe(false);

    if (process.platform !== "win32") {
      expect(statSync(path.join(outputDir, binaryName)).mode & 0o111).not.toBe(0);
    }
  });
});
