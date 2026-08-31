import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
  deriveVerifiedDaemonUpgradeBinaryDigests,
  FIXTURE_VERSION_A,
  FIXTURE_VERSION_B,
  verifyInstallVmFixtures,
  type InstallVmFixtureManifest,
} from "./prepare-fixtures";
import {
  DAEMON_UPGRADE_VERSION_A,
  DAEMON_UPGRADE_VERSION_B,
  computeDaemonUpgradeBuildInputIdentity,
  copyDaemonUpgradeCheckoutFiles,
  createDaemonUpgradeCompilerEnvironment,
  readDaemonRevision,
  replaceDaemonRevision,
  rewriteDaemonUpgradeVariantSources,
  snapshotDaemonUpgradeDependencies,
} from "./prepare-daemon-upgrade-fixtures";

/** Initialize the minimal Git checkout required by source-identity discovery. */
function initializeTestGitRepo(repo: string) {
  const result = Bun.spawnSync(["git", "init", "--quiet"], {
    cwd: repo,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("Unable to initialize test Git repository.");
}

/** Add paths to the index of one temporary Git fixture. */
function addTestGitFiles(repo: string, ...paths: string[]) {
  const result = Bun.spawnSync(["git", "add", "--", ...paths], {
    cwd: repo,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("Unable to index test Git files.");
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
  mkdirSync(path.join(repo, "src", "session"), { recursive: true });
  mkdirSync(path.join(repo, "node_modules"), { recursive: true });
  writeFileSync(path.join(repo, "node_modules", "fixture-dependency"), "dependency\n");
  writeFileSync(
    path.join(repo, "src", "session", "protocol.ts"),
    "export const HUNK_SESSION_DAEMON_VERSION = 11;\n",
  );
  const versions = [
    "1.0.0",
    DAEMON_UPGRADE_VERSION_A,
    DAEMON_UPGRADE_VERSION_B,
    FIXTURE_VERSION_A,
    FIXTURE_VERSION_B,
  ];
  const packages = versions.flatMap((version) =>
    ["hunkdiff-linux-x64", "hunkdiff"].map((name) => {
      const tarball = `${name}-${version}.tgz`;
      const tarballPath = path.join(packageRoot, tarball);
      writeFileSync(tarballPath, `${name}@${version}\n`);
      return { name, version, tarball, sha256: sha256(tarballPath) };
    }),
  );
  const manifest: InstallVmFixtureManifest = {
    schemaVersion: 2,
    sourceIdentity: computeInstallVmFixtureSourceIdentity(repo),
    daemonUpgradeBuildInputIdentity: computeDaemonUpgradeBuildInputIdentity(repo),
    currentVersion: "1.0.0",
    versionA: FIXTURE_VERSION_A,
    versionB: FIXTURE_VERSION_B,
    daemonUpgrade: {
      versionA: DAEMON_UPGRADE_VERSION_A,
      versionB: DAEMON_UPGRADE_VERSION_B,
      revisionA: 10,
      revisionB: 11,
      binarySha256A: "a".repeat(64),
      binarySha256B: "b".repeat(64),
    },
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
  test("derives trusted daemon binary digests from the actual platform tarballs", async () => {
    if (process.platform !== "linux") return;
    const root = mkdtempSync(path.join(tmpdir(), "hunk-daemon-tarball-digests-"));
    try {
      const packages = path.join(root, "packages");
      mkdirSync(packages, { recursive: true });
      const fixtures = [
        [DAEMON_UPGRADE_VERSION_A, "daemon-a\n"],
        [DAEMON_UPGRADE_VERSION_B, "daemon-b\n"],
      ] as const;
      const entries = [];
      const digests: string[] = [];
      for (const [version, contents] of fixtures) {
        const stage = path.join(root, `stage-${version}`, "package", "bin");
        mkdirSync(stage, { recursive: true });
        const binary = path.join(stage, "hunk");
        writeFileSync(binary, contents);
        const tarball = `hunkdiff-linux-x64-${version}.tgz`;
        const packed = Bun.spawnSync(
          [
            "tar",
            "-czf",
            path.join(packages, tarball),
            "-C",
            path.dirname(path.dirname(stage)),
            "package/bin/hunk",
          ],
          { stderr: "pipe" },
        );
        expect(packed.exitCode).toBe(0);
        entries.push({ name: "hunkdiff-linux-x64", version, tarball, sha256: "0".repeat(64) });
        digests.push(sha256(binary));
      }
      const manifest = {
        schemaVersion: 2,
        sourceIdentity: "0".repeat(64),
        daemonUpgradeBuildInputIdentity: "1".repeat(64),
        currentVersion: "1.0.0",
        versionA: FIXTURE_VERSION_A,
        versionB: FIXTURE_VERSION_B,
        daemonUpgrade: {
          versionA: DAEMON_UPGRADE_VERSION_A,
          versionB: DAEMON_UPGRADE_VERSION_B,
          revisionA: 10,
          revisionB: 11,
          binarySha256A: digests[0]!,
          binarySha256B: digests[1]!,
        },
        packages: entries,
      } satisfies InstallVmFixtureManifest;

      await expect(deriveVerifiedDaemonUpgradeBinaryDigests(root, manifest)).resolves.toEqual({
        binarySha256A: digests[0]!,
        binarySha256B: digests[1]!,
      });
      manifest.daemonUpgrade.binarySha256A = "f".repeat(64);
      await expect(deriveVerifiedDaemonUpgradeBinaryDigests(root, manifest)).rejects.toThrow(
        "do not match their manifest",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("attests dependency bytes, symlink targets, and Bun build inputs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hunk-daemon-inputs-"));
    try {
      const dependencies = path.join(root, "node_modules");
      const bun = path.join(root, "bun");
      mkdirSync(dependencies, { recursive: true });
      writeFileSync(path.join(dependencies, "dependency"), "one");
      writeFileSync(path.join(dependencies, "other"), "other");
      symlinkSync("dependency", path.join(dependencies, "link"));
      writeFileSync(bun, "bun-one");
      const options = {
        dependenciesRoot: dependencies,
        bunExecutable: bun,
        bunVersion: "1.2.3",
      };
      const first = computeDaemonUpgradeBuildInputIdentity(root, options);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(path.join(dependencies, "dependency"), "two");
      expect(computeDaemonUpgradeBuildInputIdentity(root, options)).not.toBe(first);
      writeFileSync(path.join(dependencies, "dependency"), "one");
      rmSync(path.join(dependencies, "link"));
      symlinkSync("other", path.join(dependencies, "link"));
      expect(computeDaemonUpgradeBuildInputIdentity(root, options)).not.toBe(first);

      const external = path.join(root, "..", `${path.basename(root)}-external`);
      writeFileSync(external, "outside-one");
      rmSync(path.join(dependencies, "link"));
      symlinkSync(external, path.join(dependencies, "link"));
      expect(() => computeDaemonUpgradeBuildInputIdentity(root, options)).toThrow(
        "escapes the checkout",
      );
      writeFileSync(external, "outside-two");
      expect(() => computeDaemonUpgradeBuildInputIdentity(root, options)).toThrow(
        "escapes the checkout",
      );
      rmSync(external, { force: true });
    } finally {
      rmSync(path.join(root, "..", `${path.basename(root)}-external`), {
        force: true,
      });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects escaping checkout symlinks while preserving contained links", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hunk-daemon-checkout-links-"));
    const repo = path.join(root, "repo");
    const externalPackage = path.join(root, "external-package.json");
    const externalSource = path.join(root, "external-src");
    try {
      mkdirSync(path.join(repo, "src", "session"), { recursive: true });
      initializeTestGitRepo(repo);
      writeFileSync(path.join(repo, "package.json"), '{"version":"1.0.0"}\n');
      writeFileSync(
        path.join(repo, "src", "session", "protocol.ts"),
        "export const HUNK_SESSION_DAEMON_VERSION = 11;\n",
      );
      writeFileSync(path.join(repo, "AGENTS.md"), "instructions\n");
      symlinkSync("AGENTS.md", path.join(repo, "CLAUDE.md"), "file");
      addTestGitFiles(repo, "package.json", "src/session/protocol.ts", "AGENTS.md", "CLAUDE.md");

      writeFileSync(externalPackage, '{"version":"outside"}\n');
      rmSync(path.join(repo, "package.json"));
      symlinkSync(path.relative(repo, externalPackage), path.join(repo, "package.json"), "file");
      expect(() => copyDaemonUpgradeCheckoutFiles(repo, path.join(root, "package-copy"))).toThrow(
        "entry escapes the checkout",
      );
      expect(readFileSync(externalPackage, "utf8")).toBe('{"version":"outside"}\n');

      rmSync(path.join(repo, "package.json"));
      writeFileSync(path.join(repo, "package.json"), '{"version":"1.0.0"}\n');
      mkdirSync(path.join(externalSource, "session"), { recursive: true });
      writeFileSync(
        path.join(externalSource, "session", "protocol.ts"),
        "export const HUNK_SESSION_DAEMON_VERSION = 99;\n",
      );
      rmSync(path.join(repo, "src"), { recursive: true });
      symlinkSync(path.relative(repo, externalSource), path.join(repo, "src"), "dir");
      expect(() => copyDaemonUpgradeCheckoutFiles(repo, path.join(root, "parent-copy"))).toThrow(
        "entry escapes the checkout",
      );

      unlinkSync(path.join(repo, "src"));
      mkdirSync(path.join(repo, "src", "session"), { recursive: true });
      writeFileSync(
        path.join(repo, "src", "session", "protocol.ts"),
        "export const HUNK_SESSION_DAEMON_VERSION = 11;\n",
      );
      const containedCopy = path.join(root, "contained-copy");
      copyDaemonUpgradeCheckoutFiles(repo, containedCopy);
      expect(readlinkSync(path.join(containedCopy, "CLAUDE.md"))).toBe("AGENTS.md");
      expect(readFileSync(path.join(containedCopy, "package.json"), "utf8")).toContain("1.0.0");

      // A source link can leave and re-enter through another symlink, yet escape after relocation.
      symlinkSync(path.join(repo, "AGENTS.md"), path.join(root, "reentry"), "file");
      symlinkSync("../reentry", path.join(repo, "REENTRY.md"), "file");
      addTestGitFiles(repo, "REENTRY.md");
      expect(() => copyDaemonUpgradeCheckoutFiles(repo, path.join(root, "reentry-copy"))).toThrow(
        "symlink escapes the isolated checkout",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses to rewrite fixture source through symlink components", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hunk-daemon-rewrite-links-"));
    const checkout = path.join(root, "checkout");
    const packageTarget = path.join(checkout, "package-target.json");
    const externalSource = path.join(root, "external-src");
    try {
      mkdirSync(path.join(checkout, "src", "session"), { recursive: true });
      writeFileSync(packageTarget, '{"version":"unchanged"}\n');
      symlinkSync("package-target.json", path.join(checkout, "package.json"), "file");
      writeFileSync(
        path.join(checkout, "src", "session", "protocol.ts"),
        "export const HUNK_SESSION_DAEMON_VERSION = 11;\n",
      );
      expect(() => rewriteDaemonUpgradeVariantSources(checkout, "899.0.0", 10)).toThrow(
        "rewrite path may not contain a symlink",
      );
      expect(readFileSync(packageTarget, "utf8")).toBe('{"version":"unchanged"}\n');

      rmSync(path.join(checkout, "package.json"));
      writeFileSync(path.join(checkout, "package.json"), '{"version":"unchanged"}\n');
      mkdirSync(path.join(externalSource, "session"), { recursive: true });
      const externalProtocol = path.join(externalSource, "session", "protocol.ts");
      writeFileSync(externalProtocol, "export const HUNK_SESSION_DAEMON_VERSION = 99;\n");
      rmSync(path.join(checkout, "src"), { recursive: true });
      symlinkSync(path.relative(checkout, externalSource), path.join(checkout, "src"), "dir");
      expect(() => rewriteDaemonUpgradeVariantSources(checkout, "899.0.0", 10)).toThrow(
        "rewrite path may not contain a symlink",
      );
      expect(readFileSync(path.join(checkout, "package.json"), "utf8")).toContain("unchanged");
      expect(readFileSync(externalProtocol, "utf8")).toContain("VERSION = 99");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("forces fixture compiler resolution ahead of a hostile PATH", () => {
    if (process.platform !== "linux") return;
    const root = mkdtempSync(path.join(tmpdir(), "hunk-daemon-compiler-"));
    try {
      const hostileBin = path.join(root, "hostile");
      const attestedBun = path.join(root, "attested-bun");
      mkdirSync(hostileBin);
      writeFileSync(path.join(hostileBin, "bun"), "#!/bin/sh\nexit 99\n", {
        mode: 0o755,
      });
      writeFileSync(attestedBun, "attested compiler bytes\n", { mode: 0o755 });
      const compiler = createDaemonUpgradeCompilerEnvironment(path.join(root, "build"), {
        env: {
          ...process.env,
          PATH: `${hostileBin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        bunExecutable: attestedBun,
      });
      try {
        expect(realpathSync(compiler.resolvedBun)).toBe(realpathSync(attestedBun));
        expect(compiler.resolvedBun.startsWith(path.join(root, "build"))).toBe(true);
      } finally {
        compiler.cleanup();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("snapshots dependencies while preserving workspace links inside the isolated tree", () => {
    if (process.platform !== "linux") return;
    const root = mkdtempSync(path.join(tmpdir(), "hunk-daemon-deps-"));
    const isolated = path.join(root, "isolated");
    try {
      mkdirSync(path.join(root, "repo", "node_modules", "@hunk"), {
        recursive: true,
      });
      mkdirSync(path.join(root, "repo", "packages", "session-broker"), {
        recursive: true,
      });
      writeFileSync(path.join(root, "repo", "node_modules", "dependency.txt"), "snapshot\n");
      symlinkSync(
        "../../packages/session-broker",
        path.join(root, "repo", "node_modules", "@hunk", "session-broker"),
      );
      mkdirSync(path.join(isolated, "packages", "session-broker"), {
        recursive: true,
      });
      writeFileSync(path.join(isolated, "packages", "session-broker", "marker"), "isolated\n");

      snapshotDaemonUpgradeDependencies(
        path.join(root, "repo"),
        path.join(isolated, "node_modules"),
      );

      expect(readFileSync(path.join(isolated, "node_modules", "dependency.txt"), "utf8")).toBe(
        "snapshot\n",
      );
      expect(realpathSync(path.join(isolated, "node_modules", "@hunk", "session-broker"))).toBe(
        realpathSync(path.join(isolated, "packages", "session-broker")),
      );
      writeFileSync(path.join(root, "repo", "node_modules", "dependency.txt"), "mutated\n");
      expect(readFileSync(path.join(isolated, "node_modules", "dependency.txt"), "utf8")).toBe(
        "snapshot\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rewrites exactly one positive daemon revision for isolated full-binary fixtures", () => {
    const source = "export const HUNK_SESSION_DAEMON_VERSION = 11;\n";
    expect(readDaemonRevision(source)).toBe(11);
    expect(replaceDaemonRevision(source, 10)).toContain("VERSION = 10;");
    expect(() => readDaemonRevision(`${source}${source}`)).toThrow("exactly one");
    expect(() => readDaemonRevision("export const unrelated = 1;\n")).toThrow("exactly one");
    expect(() => replaceDaemonRevision(source, 0)).toThrow("positive safe integer");
  });

  test("builds two distinct Linux x64 package topologies from staged engine metadata", () => {
    const stagedEngines = { node: ">=99" };
    const fixtureA = buildSyntheticPackageManifests(FIXTURE_VERSION_A, stagedEngines);
    const fixtureB = buildSyntheticPackageManifests(FIXTURE_VERSION_B, stagedEngines);

    expect(fixtureA.meta.version).not.toBe(fixtureB.meta.version);
    expect("dependencies" in fixtureA.meta).toBe(false);
    expect(fixtureA.meta.engines).toEqual(stagedEngines);
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
      mkdirSync(path.join(repo, "test", "cli", "install-vm"), {
        recursive: true,
      });
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
      expect(() => verifyInstallVmFixtures(repo, fixtures)).toThrow("exactly ten");

      const staleContract = {
        ...manifest,
        daemonUpgrade: { ...manifest.daemonUpgrade, revisionA: 9 },
      };
      writeFileSync(
        path.join(fixtures, "fixture-manifest.json"),
        `${JSON.stringify(staleContract)}\n`,
      );
      writeFileSync(httpManifest, `${JSON.stringify(staleContract)}\n`);
      expect(() => verifyInstallVmFixtures(repo, fixtures)).toThrow("malformed or stale");

      const unboundBinary = {
        ...manifest,
        daemonUpgrade: {
          ...manifest.daemonUpgrade,
          binarySha256A: "b".repeat(64),
        },
      };
      writeFileSync(
        path.join(fixtures, "fixture-manifest.json"),
        `${JSON.stringify(unboundBinary)}\n`,
      );
      writeFileSync(httpManifest, `${JSON.stringify(unboundBinary)}\n`);
      expect(() => verifyInstallVmFixtures(repo, fixtures)).toThrow("malformed or stale");
      const unknownContractKey = {
        ...manifest,
        daemonUpgrade: { ...manifest.daemonUpgrade, extra: true },
      };
      writeFileSync(
        path.join(fixtures, "fixture-manifest.json"),
        `${JSON.stringify(unknownContractKey)}\n`,
      );
      writeFileSync(httpManifest, `${JSON.stringify(unknownContractKey)}\n`);
      expect(() => verifyInstallVmFixtures(repo, fixtures)).toThrow("malformed or stale");

      writeFileSync(path.join(fixtures, "fixture-manifest.json"), manifestBytes);
      writeFileSync(httpManifest, manifestBytes);
      const tarball = path.join(fixtures, "packages", manifest.packages[0]!.tarball);
      writeFileSync(tarball, "tampered\n");
      expect(() => verifyInstallVmFixtures(repo, fixtures)).toThrow("checksum mismatch");
      rmSync(tarball);
      symlinkSync(path.join(repo, "package.json"), tarball);
      expect(() => verifyInstallVmFixtures(repo, fixtures)).toThrow("checksum mismatch");
      rmSync(tarball);
      symlinkSync(path.join("..", manifest.packages[1]!.tarball), tarball);
      expect(() => verifyInstallVmFixtures(repo, fixtures)).toThrow("checksum mismatch");
      rmSync(tarball);
      const packages = path.join(fixtures, "packages");
      const realPackages = path.join(fixtures, "packages-real");
      renameSync(packages, realPackages);
      symlinkSync(realPackages, packages);
      expect(() => verifyInstallVmFixtures(repo, fixtures)).toThrow("checksum mismatch");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(fixtures, { recursive: true, force: true });
    }
  });
});
