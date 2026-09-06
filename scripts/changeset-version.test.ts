import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { versionPackages } from "./changeset-version";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Create one workspace layout with the repository changelog as its only changelog. */
function createTestWorkspace() {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "hunk-changeset-version-"));
  const packageRoot = path.join(repoRoot, "packages", "hunk");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(repoRoot, "CHANGELOG.md"), "# Changelog\n\n## 1.0.0\n");
  roots.push(repoRoot);
  return { repoRoot, packageRoot };
}

describe("canonical changelog versioning", () => {
  test("uses real Changesets output for the package manifest and canonical root changelog", () => {
    const paths = createTestWorkspace();
    mkdirSync(path.join(paths.repoRoot, ".changeset"), { recursive: true });
    writeFileSync(
      path.join(paths.repoRoot, "package.json"),
      `${JSON.stringify({ private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(paths.packageRoot, "package.json"),
      `${JSON.stringify({ name: "hunkdiff", version: "1.0.0" }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(paths.repoRoot, ".changeset", "config.json"),
      `${JSON.stringify({ changelog: "@changesets/cli/changelog", commit: false, access: "restricted", baseBranch: "main", updateInternalDependencies: "patch", ignore: [] }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(paths.repoRoot, ".changeset", "real-version.md"),
      '---\n"hunkdiff": patch\n---\n\nVerify the real version output.\n',
    );

    versionPackages(paths);

    expect(
      JSON.parse(readFileSync(path.join(paths.packageRoot, "package.json"), "utf8")).version,
    ).toBe("1.0.1");
    expect(readFileSync(path.join(paths.repoRoot, "CHANGELOG.md"), "utf8")).toContain("## 1.0.1");
    expect(existsSync(path.join(paths.packageRoot, "CHANGELOG.md"))).toBe(false);
    expect(existsSync(path.join(paths.repoRoot, ".changeset", "real-version.md"))).toBe(false);
  }, 30_000);

  test("stages root history for Changesets and returns its output to the root", () => {
    const paths = createTestWorkspace();

    versionPackages(paths, () => {
      const staged = path.join(paths.packageRoot, "CHANGELOG.md");
      expect(readFileSync(staged, "utf8")).toContain("## 1.0.0");
      writeFileSync(staged, "# Changelog\n\n## 1.1.0\n\n- Added packages.\n\n## 1.0.0\n");
      return 0;
    });

    expect(readFileSync(path.join(paths.repoRoot, "CHANGELOG.md"), "utf8")).toContain("## 1.1.0");
    expect(existsSync(path.join(paths.packageRoot, "CHANGELOG.md"))).toBe(false);
  });

  test("removes the staged package changelog when Changesets fails", () => {
    const paths = createTestWorkspace();

    expect(() => versionPackages(paths, () => 2)).toThrow("failed with exit 2");
    expect(readFileSync(path.join(paths.repoRoot, "CHANGELOG.md"), "utf8")).not.toContain(
      "## 1.1.0",
    );
    expect(existsSync(path.join(paths.packageRoot, "CHANGELOG.md"))).toBe(false);
  });

  test("keeps the generated changelog when it cannot be returned to the root", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      // Both make the read-only repository root writable anyway, so the write-back would
      // succeed and the test could not observe the failure it exists to cover.
      return;
    }

    const paths = createTestWorkspace();
    const staged = path.join(paths.packageRoot, "CHANGELOG.md");
    const canonical = path.join(paths.repoRoot, "CHANGELOG.md");

    try {
      // Deny the write-back specifically, after Changesets has already consumed the
      // `.changeset/*.md` entries, so the staged file is the only copy of the new notes.
      // The target file itself must be read-only: `copyFileSync` overwrites through the
      // existing inode, which a read-only parent directory does not prevent.
      expect(() =>
        versionPackages(paths, () => {
          writeFileSync(staged, "# Changelog\n\n## 1.1.0\n\n- Generated once.\n");
          chmodSync(canonical, 0o400);
          return 0;
        }),
      ).toThrow("The generated history is preserved at");
    } finally {
      chmodSync(canonical, 0o600);
    }

    // The release notes survive the failure and are still the generated ones.
    expect(readFileSync(staged, "utf8")).toContain("## 1.1.0");
  });
});
