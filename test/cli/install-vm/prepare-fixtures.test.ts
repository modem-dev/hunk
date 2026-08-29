import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildSyntheticPackageManifests,
  computeInstallVmFixtureSourceIdentity,
  CURL_BAD_CHECKSUM_VERSION,
  CURL_TRUNCATED_VERSION,
  CURL_UNAVAILABLE_VERSION,
  FIXTURE_VERSION_A,
  FIXTURE_VERSION_B,
  verifyInstallVmFixtures,
  type InstallVmFixtureManifest,
} from "./prepare-fixtures";

/** Initialize the minimal Git checkout required by source-identity discovery. */
function initializeTestGitRepo(repo: string) {
  const result = Bun.spawnSync(["git", "init", "--quiet"], { cwd: repo, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Unable to initialize test Git repository.");
}

/** Hash one small test fixture. */
function sha256(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** Write a complete lightweight fixture topology for verification tests. */
function writeTestFixtures(repo: string, fixtures: string) {
  const packageRoot = path.join(fixtures, "packages");
  const httpRoot = path.join(fixtures, "http");
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(httpRoot, { recursive: true });
  const versions = ["1.0.0", FIXTURE_VERSION_A, FIXTURE_VERSION_B];
  const packages = versions.flatMap((version) =>
    ["hunkdiff-linux-x64", "hunkdiff"].map((name) => {
      const tarball = `${name}-${version}.tgz`;
      const tarballPath = path.join(packageRoot, tarball);
      writeFileSync(tarballPath, `${name}@${version}\n`);
      return { name, version, tarball, sha256: sha256(tarballPath) };
    }),
  );
  const manifest: InstallVmFixtureManifest = {
    schemaVersion: 1,
    sourceIdentity: computeInstallVmFixtureSourceIdentity(repo),
    currentVersion: "1.0.0",
    versionA: FIXTURE_VERSION_A,
    versionB: FIXTURE_VERSION_B,
    packages,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(path.join(fixtures, "fixture-manifest.json"), manifestBytes);
  writeFileSync(path.join(httpRoot, "fixture-manifest.json"), manifestBytes);
  const curlVersions = `${JSON.stringify(
    {
      badChecksum: CURL_BAD_CHECKSUM_VERSION,
      truncated: CURL_TRUNCATED_VERSION,
      unavailable: CURL_UNAVAILABLE_VERSION,
    },
    null,
    2,
  )}\n`;
  writeFileSync(path.join(fixtures, "curl-versions.json"), curlVersions);
  writeFileSync(path.join(httpRoot, "curl-versions.json"), curlVersions);
  writeFileSync(path.join(httpRoot, "latest"), '{"tag_name":"v1.0.0"}\n');
  writeFileSync(path.join(httpRoot, "install.sh"), "#!/bin/sh\n");

  const archiveName = "hunkdiff-linux-x64.tar.gz";
  for (const [version, digestOverride] of [
    ["1.0.0", undefined],
    [FIXTURE_VERSION_A, undefined],
    [FIXTURE_VERSION_B, undefined],
    [CURL_BAD_CHECKSUM_VERSION, "0".repeat(64)],
    [CURL_TRUNCATED_VERSION, undefined],
  ] as const) {
    const directory = path.join(httpRoot, "download", `v${version}`);
    mkdirSync(directory, { recursive: true });
    const archive = path.join(directory, archiveName);
    writeFileSync(archive, `archive ${version}\n`);
    writeFileSync(
      path.join(directory, "SHA256SUMS"),
      `${digestOverride ?? sha256(archive)}  ${archiveName}\n`,
    );
  }
  return manifest;
}

describe("install VM package fixtures", () => {
  test("builds two distinct Linux x64 package topologies without mandatory Bun", () => {
    const fixtureA = buildSyntheticPackageManifests(FIXTURE_VERSION_A);
    const fixtureB = buildSyntheticPackageManifests(FIXTURE_VERSION_B);

    expect(fixtureA.meta.version).not.toBe(fixtureB.meta.version);
    expect("dependencies" in fixtureA.meta).toBe(false);
    expect(fixtureA.meta.optionalDependencies).toEqual({
      "hunkdiff-linux-x64": FIXTURE_VERSION_A,
    });
    expect(fixtureB.meta.optionalDependencies).toEqual({
      "hunkdiff-linux-x64": FIXTURE_VERSION_B,
    });
    expect(fixtureA.platform).toMatchObject({
      name: "hunkdiff-linux-x64",
      version: FIXTURE_VERSION_A,
      os: ["linux"],
      cpu: ["x64"],
      bin: { hunk: "bin/hunk" },
    });
  });

  test("checkout identity includes every non-ignored file with platform-neutral paths", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "hunk-install-vm-identity-"));
    try {
      initializeTestGitRepo(repo);
      writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
      writeFileSync(path.join(repo, "package.json"), '{"version":"1.0.0"}\n');
      const initial = computeInstallVmFixtureSourceIdentity(repo);
      mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
      writeFileSync(path.join(repo, ".github", "workflows", "install-vm.yml"), "workflow\n");
      const withWorkflow = computeInstallVmFixtureSourceIdentity(repo);
      writeFileSync(path.join(repo, "ignored.txt"), "ignored\n");
      const withIgnoredFile = computeInstallVmFixtureSourceIdentity(repo);
      expect(withWorkflow).not.toBe(initial);
      expect(withIgnoredFile).toBe(withWorkflow);

      const tool = path.join(repo, "tool.sh");
      writeFileSync(tool, "#!/bin/sh\n");
      chmodSync(tool, 0o644);
      const regularTool = computeInstallVmFixtureSourceIdentity(repo);
      chmodSync(tool, 0o755);
      const executableTool = computeInstallVmFixtureSourceIdentity(repo);
      if (process.platform !== "win32") expect(executableTool).not.toBe(regularTool);

      const link = path.join(repo, "fixture-link");
      symlinkSync("first-target", link, "file");
      const firstLink = computeInstallVmFixtureSourceIdentity(repo);
      rmSync(link);
      symlinkSync("second-target", link, "file");
      expect(computeInstallVmFixtureSourceIdentity(repo)).not.toBe(firstLink);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("checkout identity frames paths and contents without concatenation collisions", () => {
    const first = mkdtempSync(path.join(tmpdir(), "hunk-install-vm-collision-a-"));
    const second = mkdtempSync(path.join(tmpdir(), "hunk-install-vm-collision-b-"));
    try {
      initializeTestGitRepo(first);
      initializeTestGitRepo(second);
      writeFileSync(path.join(first, "a"), "bc");
      writeFileSync(path.join(second, "ab"), "c");
      expect(computeInstallVmFixtureSourceIdentity(first)).not.toBe(
        computeInstallVmFixtureSourceIdentity(second),
      );
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("verifies checkout identity, exact package set, duplicate manifests, and tarball digests", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "hunk-install-vm-source-"));
    const fixtures = mkdtempSync(path.join(tmpdir(), "hunk-install-vm-fixtures-"));
    try {
      initializeTestGitRepo(repo);
      mkdirSync(path.join(repo, "test", "cli", "install-vm"), { recursive: true });
      writeFileSync(path.join(repo, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
      writeFileSync(path.join(repo, "test", "cli", "install-vm", "source.txt"), "source\n");
      const manifest = writeTestFixtures(repo, fixtures);
      expect(verifyInstallVmFixtures(repo, fixtures).sourceIdentity).toBe(manifest.sourceIdentity);

      const curlUpgradeArchive = path.join(
        fixtures,
        "http",
        "download",
        `v${FIXTURE_VERSION_B}`,
        "hunkdiff-linux-x64.tar.gz",
      );
      writeFileSync(curlUpgradeArchive, "tampered\n");
      expect(() => verifyInstallVmFixtures(repo, fixtures)).toThrow(
        "Invalid curl archive/checksum fixture",
      );
      writeFileSync(curlUpgradeArchive, `archive ${FIXTURE_VERSION_B}\n`);

      const httpManifest = path.join(fixtures, "http", "fixture-manifest.json");
      writeFileSync(httpManifest, `${JSON.stringify({ ...manifest, currentVersion: "2.0.0" })}\n`);
      expect(() => verifyInstallVmFixtures(repo, fixtures)).toThrow(
        "HTTP fixture manifest differs",
      );

      const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
      writeFileSync(httpManifest, manifestBytes);
      const drifted = { ...manifest, packages: manifest.packages.slice(0, -1) };
      writeFileSync(path.join(fixtures, "fixture-manifest.json"), `${JSON.stringify(drifted)}\n`);
      writeFileSync(httpManifest, `${JSON.stringify(drifted)}\n`);
      expect(() => verifyInstallVmFixtures(repo, fixtures)).toThrow("exactly six");

      writeFileSync(path.join(fixtures, "fixture-manifest.json"), manifestBytes);
      writeFileSync(httpManifest, manifestBytes);
      const tarball = path.join(fixtures, "packages", manifest.packages[0]!.tarball);
      writeFileSync(tarball, "tampered\n");
      expect(() => verifyInstallVmFixtures(repo, fixtures)).toThrow("checksum mismatch");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(fixtures, { recursive: true, force: true });
    }
  });
});
