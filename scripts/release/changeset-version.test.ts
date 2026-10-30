import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ChangesetVersionCommands, versionPackages } from "./changeset-version";

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

/** Build command stubs that record their calls instead of spawning Changesets or Bun. */
function createTestCommands(overrides: Partial<ChangesetVersionCommands> = {}) {
  const calls: string[] = [];
  const commands: ChangesetVersionCommands = {
    runChangesets: (repoRoot) => {
      calls.push(`changesets:${repoRoot}`);
      return overrides.runChangesets?.(repoRoot) ?? 0;
    },
    refreshLockfile: (repoRoot) => {
      calls.push(`lockfile:${repoRoot}`);
      return overrides.refreshLockfile?.(repoRoot) ?? 0;
    },
  };
  return { calls, commands };
}

/** Read the version Bun recorded for the `packages/hunk` workspace. */
function readTestLockfileHunkVersion(repoRoot: string) {
  const lockfile = Bun.JSONC.parse(readFileSync(path.join(repoRoot, "bun.lock"), "utf8")) as {
    workspaces: Record<string, { name?: string; version?: string }>;
  };

  // Bun can serialize temporary Windows workspaces with paths relative to another drive.
  const hunkWorkspaces = Object.values(lockfile.workspaces).filter(
    (workspace) => workspace.name === "hunkdiff",
  );
  expect(hunkWorkspaces).toHaveLength(1);
  return hunkWorkspaces[0]?.version;
}

describe("canonical changelog versioning", () => {
  test.each([
    "packages/hunk",
    "packages\\hunk",
    "../../../../../runneradmin/AppData/Local/Temp/hunk-changeset-version-test/packages/hunk",
  ])("reads the workspace version from lockfile key %s", (workspaceKey) => {
    const paths = createTestWorkspace();
    writeFileSync(
      path.join(paths.repoRoot, "bun.lock"),
      JSON.stringify({
        workspaces: {
          "": { name: "test-root", version: "9.0.0" },
          "packages/other": { name: "other", version: "2.0.0" },
          [workspaceKey]: { name: "hunkdiff", version: "1.0.0" },
        },
      }),
    );

    expect(readTestLockfileHunkVersion(paths.repoRoot)).toBe("1.0.0");
  });

  test("uses real Changesets and Bun output for the manifest, root changelog, and lockfile", () => {
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
    const install = Bun.spawnSync([process.execPath, "install", "--lockfile-only"], {
      cwd: paths.repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      expect(install.exitCode).toBe(0);
      expect(readTestLockfileHunkVersion(paths.repoRoot)).toBe("1.0.0");

      versionPackages(paths);

      expect(
        JSON.parse(readFileSync(path.join(paths.packageRoot, "package.json"), "utf8")).version,
      ).toBe("1.0.1");
      expect(readTestLockfileHunkVersion(paths.repoRoot)).toBe("1.0.1");
      expect(readFileSync(path.join(paths.repoRoot, "CHANGELOG.md"), "utf8")).toContain("## 1.0.1");
      expect(existsSync(path.join(paths.packageRoot, "CHANGELOG.md"))).toBe(false);
      expect(existsSync(path.join(paths.repoRoot, ".changeset", "real-version.md"))).toBe(false);
    } catch (error) {
      // Preserve generated evidence before afterEach removes the temporary workspace.
      const lockfilePath = path.join(paths.repoRoot, "bun.lock");
      console.error("Real version command diagnostics", {
        bunVersion: Bun.version,
        executable: process.execPath,
        platform: process.platform,
        installExitCode: install.exitCode,
        installStdout: install.stdout.toString(),
        installStderr: install.stderr.toString(),
        lockfile: existsSync(lockfilePath) ? readFileSync(lockfilePath, "utf8") : "missing",
      });
      throw error;
    }
  }, 30_000);

  test("stages root history for Changesets and returns its output to the root", () => {
    const paths = createTestWorkspace();
    const { commands } = createTestCommands({
      runChangesets: () => {
        const staged = path.join(paths.packageRoot, "CHANGELOG.md");
        expect(readFileSync(staged, "utf8")).toContain("## 1.0.0");
        writeFileSync(staged, "# Changelog\n\n## 1.1.0\n\n- Added packages.\n\n## 1.0.0\n");
        return 0;
      },
    });

    versionPackages(paths, commands);

    expect(readFileSync(path.join(paths.repoRoot, "CHANGELOG.md"), "utf8")).toContain("## 1.1.0");
    expect(existsSync(path.join(paths.packageRoot, "CHANGELOG.md"))).toBe(false);
  });

  test("removes the staged package changelog and skips the lockfile when Changesets fails", () => {
    const paths = createTestWorkspace();
    const { calls, commands } = createTestCommands({ runChangesets: () => 2 });

    expect(() => versionPackages(paths, commands)).toThrow("Changesets version failed with exit 2");
    expect(readFileSync(path.join(paths.repoRoot, "CHANGELOG.md"), "utf8")).not.toContain(
      "## 1.1.0",
    );
    expect(existsSync(path.join(paths.packageRoot, "CHANGELOG.md"))).toBe(false);
    expect(calls).toEqual([`changesets:${paths.repoRoot}`]);
  });

  test("refreshes the lockfile from the repository root after Changesets succeeds", () => {
    const paths = createTestWorkspace();
    const { calls, commands } = createTestCommands({
      runChangesets: () => {
        writeFileSync(path.join(paths.packageRoot, "CHANGELOG.md"), "# Changelog\n\n## 1.1.0\n");
        return 0;
      },
    });

    versionPackages(paths, commands);

    expect(calls).toEqual([`changesets:${paths.repoRoot}`, `lockfile:${paths.repoRoot}`]);
  });

  test("keeps the versioned changelog and reports the recovery command when the refresh fails", () => {
    const paths = createTestWorkspace();
    const { commands } = createTestCommands({
      runChangesets: () => {
        writeFileSync(path.join(paths.packageRoot, "CHANGELOG.md"), "# Changelog\n\n## 1.1.0\n");
        return 0;
      },
      refreshLockfile: () => 1,
    });

    expect(() => versionPackages(paths, commands)).toThrow(
      "bun.lock refresh failed with exit 1; run `bun install --lockfile-only`.",
    );
    expect(readFileSync(path.join(paths.repoRoot, "CHANGELOG.md"), "utf8")).toContain("## 1.1.0");
    expect(existsSync(path.join(paths.packageRoot, "CHANGELOG.md"))).toBe(false);
  });
});
