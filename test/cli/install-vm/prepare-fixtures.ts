import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  assertNoMandatoryBunDependency,
  buildOptionalDependencyMap,
  buildPlatformPackageManifest,
  getPlatformPackageSpecForHost,
  releaseNpmDir,
} from "../../../scripts/prebuilt-package-helpers";
import { stagePrebuiltArtifact } from "../../../scripts/build-prebuilt-artifact";
import { npmCommand } from "../../../scripts/script-helpers";

export const FIXTURE_VERSION_A = "900.0.0";
export const FIXTURE_VERSION_B = "900.0.1";
export const CURL_BAD_CHECKSUM_VERSION = "900.0.2";
export const CURL_TRUNCATED_VERSION = "900.0.3";
export const CURL_UNAVAILABLE_VERSION = "900.0.4";

export interface FixturePackage {
  name: string;
  version: string;
  tarball: string;
  sha256: string;
}

export interface InstallVmFixtureManifest {
  schemaVersion: 1;
  sourceIdentity: string;
  currentVersion: string;
  versionA: string;
  versionB: string;
  packages: FixturePackage[];
}

/** Build reduced meta/platform manifests for deterministic package-manager topology tests. */
export function buildSyntheticPackageManifests(version: string) {
  const platformSpec = getPlatformPackageSpecForHost("linux", "x64");
  const platform = buildPlatformPackageManifest(
    {
      version,
      description: "Hunk install VM fixture",
      license: "MIT",
    },
    platformSpec,
  );
  const meta = {
    name: "hunkdiff",
    version,
    description: "Hunk install VM fixture",
    type: "module",
    bin: { hunk: "./bin/hunk.cjs", hunkdiff: "./bin/hunk.cjs" },
    files: ["bin", "dist/npm", "skills"],
    optionalDependencies: buildOptionalDependencyMap(version, [platformSpec]),
    engines: { node: ">=18" },
    license: "MIT",
  };
  return { meta, platform };
}

/** Hash one fixture file for checksum manifests and evidence. */
function sha256(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** Read one NUL-delimited Git path listing without shell interpretation. */
function readCheckoutGitList(repoRoot: string, args: string[]) {
  const listed = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listed.exitCode !== 0) {
    throw new Error(
      `Unable to enumerate the install VM checkout: ${new TextDecoder().decode(listed.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(listed.stdout).split("\0").filter(Boolean);
}

/** Add one unambiguous length-delimited field to a checkout identity. */
function updateIdentityField(hash: ReturnType<typeof createHash>, value: string | Uint8Array) {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  hash.update(`${bytes.byteLength}:`);
  hash.update(bytes);
}

/** Hash every tracked or non-ignored untracked file in the current checkout. */
export function computeInstallVmFixtureSourceIdentity(repoRoot: string) {
  const indexModes = new Map<string, string>();
  for (const entry of readCheckoutGitList(repoRoot, ["ls-files", "--stage", "-z"])) {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error("Git returned malformed install VM checkout metadata.");
    const header = entry.slice(0, separator);
    const relativePath = entry.slice(separator + 1);
    indexModes.set(relativePath, header.split(" ", 1)[0]!);
  }
  const relativePaths = readCheckoutGitList(repoRoot, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]).sort();

  const hash = createHash("sha256");
  for (const relativePath of relativePaths) {
    const filePath = path.join(repoRoot, ...relativePath.split("/"));
    updateIdentityField(hash, relativePath);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(filePath);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      updateIdentityField(hash, "missing");
      updateIdentityField(hash, "");
      continue;
    }

    const indexedMode = indexModes.get(relativePath);
    const mode = stats.isSymbolicLink()
      ? "120000"
      : process.platform === "win32" && indexedMode
        ? indexedMode
        : stats.isFile()
          ? stats.mode & 0o111
            ? "100755"
            : "100644"
          : "unsupported";
    updateIdentityField(hash, mode);
    updateIdentityField(
      hash,
      stats.isSymbolicLink()
        ? readlinkSync(filePath)
        : stats.isFile()
          ? readFileSync(filePath)
          : "",
    );
  }
  return hash.digest("hex");
}

/** Verify reusable fixtures still match this checkout and every declared tarball digest. */
export function verifyInstallVmFixtures(repoRoot: string, outputRoot: string) {
  const manifestPath = path.join(outputRoot, "fixture-manifest.json");
  const manifestBytes = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestBytes) as InstallVmFixtureManifest;
  if (manifest.schemaVersion !== 1) throw new Error("Fixture manifest must use schemaVersion 1.");
  const expectedIdentity = computeInstallVmFixtureSourceIdentity(repoRoot);
  if (manifest.sourceIdentity !== expectedIdentity) {
    throw new Error("Install VM fixtures do not match the current checkout identity.");
  }

  const rootVersion = (
    JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      version?: unknown;
    }
  ).version;
  if (manifest.currentVersion !== rootVersion) {
    throw new Error("Fixture current version does not match the checkout package version.");
  }
  if (manifest.versionA !== FIXTURE_VERSION_A || manifest.versionB !== FIXTURE_VERSION_B) {
    throw new Error("Fixture upgrade versions do not match the harness contract.");
  }
  const expectedIdentities = new Set(
    [manifest.currentVersion, manifest.versionA, manifest.versionB].flatMap((version) => [
      `hunkdiff-linux-x64@${version}`,
      `hunkdiff@${version}`,
    ]),
  );
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== expectedIdentities.size) {
    throw new Error("Fixture manifest must contain exactly six coupled packages.");
  }

  const identities = new Set<string>();
  for (const fixturePackage of manifest.packages) {
    if (
      path.basename(fixturePackage.tarball) !== fixturePackage.tarball ||
      !fixturePackage.tarball.endsWith(".tgz") ||
      !/^[a-f0-9]{64}$/.test(fixturePackage.sha256)
    ) {
      throw new Error(`Unsafe fixture package entry: ${fixturePackage.tarball}`);
    }
    const identity = `${fixturePackage.name}@${fixturePackage.version}`;
    if (identities.has(identity)) throw new Error(`Duplicate fixture package: ${identity}`);
    if (!expectedIdentities.has(identity))
      throw new Error(`Unexpected fixture package: ${identity}`);
    identities.add(identity);
    const tarballPath = path.join(outputRoot, "packages", fixturePackage.tarball);
    if (!existsSync(tarballPath) || sha256(tarballPath) !== fixturePackage.sha256) {
      throw new Error(`Fixture tarball checksum mismatch: ${fixturePackage.tarball}`);
    }
  }
  if (identities.size !== expectedIdentities.size) {
    throw new Error("Fixture package identities do not cover every required version coupling.");
  }

  const httpRoot = path.join(outputRoot, "http");
  if (readFileSync(path.join(httpRoot, "fixture-manifest.json"), "utf8") !== manifestBytes) {
    throw new Error("HTTP fixture manifest differs from the registry fixture manifest.");
  }
  const expectedCurlVersions = {
    badChecksum: CURL_BAD_CHECKSUM_VERSION,
    truncated: CURL_TRUNCATED_VERSION,
    unavailable: CURL_UNAVAILABLE_VERSION,
  };
  const curlVersionBytes = `${JSON.stringify(expectedCurlVersions, null, 2)}\n`;
  if (
    readFileSync(path.join(outputRoot, "curl-versions.json"), "utf8") !== curlVersionBytes ||
    readFileSync(path.join(httpRoot, "curl-versions.json"), "utf8") !== curlVersionBytes
  ) {
    throw new Error("Curl failure fixture versions differ from the harness contract.");
  }
  const latest = JSON.parse(readFileSync(path.join(httpRoot, "latest"), "utf8")) as {
    tag_name?: unknown;
  };
  if (latest.tag_name !== `v${manifest.currentVersion}`) {
    throw new Error("Curl latest-release fixture does not match the current version.");
  }
  const archiveName = "hunkdiff-linux-x64.tar.gz";
  /** Verify one curl fixture's archive and declared checksum. */
  const verifyArchiveChecksum = (version: string, expectedDigest?: string) => {
    const directory = path.join(httpRoot, "download", `v${version}`);
    const archive = path.join(directory, archiveName);
    if (!existsSync(archive)) throw new Error(`Missing curl archive fixture for ${version}.`);
    const checksum = readFileSync(path.join(directory, "SHA256SUMS"), "utf8");
    const digest = expectedDigest ?? sha256(archive);
    if (checksum !== `${digest}  ${archiveName}\n`) {
      throw new Error(`Invalid curl archive/checksum fixture for ${version}.`);
    }
  };
  verifyArchiveChecksum(manifest.currentVersion);
  verifyArchiveChecksum(manifest.versionA);
  verifyArchiveChecksum(manifest.versionB);
  verifyArchiveChecksum(CURL_BAD_CHECKSUM_VERSION, "0".repeat(64));
  verifyArchiveChecksum(CURL_TRUNCATED_VERSION);
  if (!existsSync(path.join(httpRoot, "install.sh"))) {
    throw new Error("Missing rewritten curl installer fixture.");
  }
  if (existsSync(path.join(httpRoot, "download", `v${CURL_UNAVAILABLE_VERSION}`, archiveName))) {
    throw new Error("Unavailable curl fixture unexpectedly contains an archive.");
  }
  return manifest;
}

/** Write stable indented JSON with a trailing newline. */
function writeJson(filePath: string, value: unknown) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Run one fixture-building command with inherited output. */
async function run(command: string[], cwd?: string) {
  const proc = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed with ${exitCode}`);
}

/** Pack one fixture package without running package lifecycle scripts. */
async function packPackage(packageDirectory: string, packageOutput: string) {
  await run(
    [npmCommand, "pack", "--pack-destination", packageOutput, "--ignore-scripts"],
    packageDirectory,
  );
  const manifest = JSON.parse(
    readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
  ) as {
    name: string;
    version: string;
  };
  return `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
}

/** Write an executable fixture binary that reports the requested synthetic version. */
function writeSyntheticBinary(binaryPath: string, version: string) {
  writeFileSync(
    binaryPath,
    `#!/bin/sh\ncase "\${1:-}" in\n  --version|-v|version) printf '%s\\n' '${version}' ;;\n  --help|-h) printf '%s\\n' 'Usage: hunk [options]' ;;\n  *) printf '%s\\n' 'fixture hunk ${version}' ;;\nesac\n`,
  );
  chmodSync(binaryPath, 0o755);
}

/** Copy bundled skills into a synthetic install fixture. */
function copyFixtureSkills(repoRoot: string, destination: string) {
  for (const skill of ["hunk-review", "hunk-extensions"]) {
    cpSync(path.join(repoRoot, "skills", skill), path.join(destination, "skills", skill), {
      recursive: true,
    });
  }
}

/** Stage coupled meta and platform packages for one synthetic upgrade version. */
async function stageSyntheticPackage(
  repoRoot: string,
  stageRoot: string,
  version: string,
  packageOutput: string,
) {
  const { meta, platform } = buildSyntheticPackageManifests(version);
  const platformDir = path.join(stageRoot, `${platform.name}-${version}`);
  mkdirSync(path.join(platformDir, "bin"), { recursive: true });
  writeJson(path.join(platformDir, "package.json"), platform);
  writeSyntheticBinary(path.join(platformDir, "bin", "hunk"), version);

  const metaDir = path.join(stageRoot, `hunkdiff-${version}`);
  mkdirSync(path.join(metaDir, "bin"), { recursive: true });
  mkdirSync(path.join(metaDir, "dist", "npm"), { recursive: true });
  copyFileSync(path.join(repoRoot, "bin", "hunk.cjs"), path.join(metaDir, "bin", "hunk.cjs"));
  chmodSync(path.join(metaDir, "bin", "hunk.cjs"), 0o755);
  copyFixtureSkills(repoRoot, metaDir);
  writeFileSync(
    path.join(metaDir, "dist", "npm", "main.js"),
    `const args = process.argv.slice(2);\nif (args.includes('--version') || args[0] === 'version') console.log('fallback-${version}');\nelse console.log('fallback fixture ${version}');\n`,
  );
  writeJson(path.join(metaDir, "package.json"), meta);

  const platformTarball = await packPackage(platformDir, packageOutput);
  const metaTarball = await packPackage(metaDir, packageOutput);
  return [
    {
      name: platform.name,
      version,
      tarball: platformTarball,
      sha256: sha256(path.join(packageOutput, platformTarball)),
    },
    {
      name: meta.name,
      version,
      tarball: metaTarball,
      sha256: sha256(path.join(packageOutput, metaTarball)),
    },
  ];
}

/** Stage one synthetic standalone archive and matching checksum manifest. */
async function stageSyntheticCurlArchive(
  repoRoot: string,
  stageRoot: string,
  downloads: string,
  version: string,
) {
  const archiveRoot = path.join(stageRoot, `curl-${version}`);
  const artifactDir = path.join(archiveRoot, "hunkdiff-linux-x64");
  mkdirSync(artifactDir, { recursive: true });
  writeSyntheticBinary(path.join(artifactDir, "hunk"), version);
  copyFixtureSkills(repoRoot, artifactDir);
  writeFileSync(path.join(artifactDir, "skills", ".fixture-version"), `${version}\n`);
  writeJson(path.join(artifactDir, "metadata.json"), {
    packageName: "hunkdiff-linux-x64",
    os: "linux",
    cpu: "x64",
    binaryName: "hunk",
    fixtureVersion: version,
  });

  const downloadDir = path.join(downloads, `v${version}`);
  const archiveName = "hunkdiff-linux-x64.tar.gz";
  mkdirSync(downloadDir, { recursive: true });
  const archive = path.join(downloadDir, archiveName);
  await run(["tar", "-czf", archive, "-C", archiveRoot, path.basename(artifactDir)]);
  writeFileSync(path.join(downloadDir, "SHA256SUMS"), `${sha256(archive)}  ${archiveName}\n`);
}

/** Prepare local registry and curl fixtures from the explicitly built checkout. */
export async function prepareInstallVmFixtures(repoRoot: string, outputRoot: string) {
  const releaseRoot = releaseNpmDir(repoRoot);
  const currentManifest = JSON.parse(
    readFileSync(path.join(releaseRoot, "hunkdiff", "package.json"), "utf8"),
  ) as { version: string; dependencies?: Record<string, string> };
  assertNoMandatoryBunDependency(currentManifest);
  const currentVersion = currentManifest.version;
  const sourceIdentity = computeInstallVmFixtureSourceIdentity(repoRoot);
  const temporaryRoot = `${outputRoot}.partial-${process.pid}`;
  const backupRoot = `${outputRoot}.backup-${process.pid}`;
  rmSync(temporaryRoot, { recursive: true, force: true });
  rmSync(backupRoot, { recursive: true, force: true });

  try {
    const packageOutput = path.join(temporaryRoot, "packages");
    const stageRoot = path.join(temporaryRoot, "stage");
    mkdirSync(packageOutput, { recursive: true });
    mkdirSync(stageRoot, { recursive: true });

    const currentPlatform = path.join(releaseRoot, "hunkdiff-linux-x64");
    if (!existsSync(currentPlatform)) {
      throw new Error("Install VM fixtures require a Linux x64 prebuilt package.");
    }
    const packages: FixturePackage[] = [];
    for (const packageDirectory of [currentPlatform, path.join(releaseRoot, "hunkdiff")]) {
      const packageManifest = JSON.parse(
        readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
      ) as { name: string; version: string };
      const tarball = await packPackage(packageDirectory, packageOutput);
      packages.push({
        name: packageManifest.name,
        version: packageManifest.version,
        tarball,
        sha256: sha256(path.join(packageOutput, tarball)),
      });
    }
    packages.push(
      ...(await stageSyntheticPackage(repoRoot, stageRoot, FIXTURE_VERSION_A, packageOutput)),
    );
    packages.push(
      ...(await stageSyntheticPackage(repoRoot, stageRoot, FIXTURE_VERSION_B, packageOutput)),
    );

    const httpRoot = path.join(temporaryRoot, "http");
    const downloads = path.join(httpRoot, "download");
    mkdirSync(httpRoot, { recursive: true });
    writeFileSync(
      path.join(httpRoot, "latest"),
      `${JSON.stringify({ tag_name: `v${currentVersion}` })}\n`,
    );
    const artifactRoot = path.join(stageRoot, "artifacts");
    const artifactDir = stagePrebuiltArtifact({ repoRoot, outputRoot: artifactRoot });
    const archiveName = "hunkdiff-linux-x64.tar.gz";
    const goodDownloadDir = path.join(downloads, `v${currentVersion}`);
    mkdirSync(goodDownloadDir, { recursive: true });
    const goodArchive = path.join(goodDownloadDir, archiveName);
    await run(["tar", "-czf", goodArchive, "-C", artifactRoot, path.basename(artifactDir)]);
    writeFileSync(
      path.join(goodDownloadDir, "SHA256SUMS"),
      `${sha256(goodArchive)}  ${archiveName}\n`,
    );
    await stageSyntheticCurlArchive(repoRoot, stageRoot, downloads, FIXTURE_VERSION_A);
    await stageSyntheticCurlArchive(repoRoot, stageRoot, downloads, FIXTURE_VERSION_B);

    const badChecksumDir = path.join(downloads, `v${CURL_BAD_CHECKSUM_VERSION}`);
    mkdirSync(badChecksumDir, { recursive: true });
    copyFileSync(goodArchive, path.join(badChecksumDir, archiveName));
    writeFileSync(path.join(badChecksumDir, "SHA256SUMS"), `${"0".repeat(64)}  ${archiveName}\n`);

    const truncatedDir = path.join(downloads, `v${CURL_TRUNCATED_VERSION}`);
    mkdirSync(truncatedDir, { recursive: true });
    const truncatedArchive = path.join(truncatedDir, archiveName);
    copyFileSync(goodArchive, truncatedArchive);
    truncateSync(truncatedArchive, 512);
    writeFileSync(
      path.join(truncatedDir, "SHA256SUMS"),
      `${sha256(truncatedArchive)}  ${archiveName}\n`,
    );

    const installer = readFileSync(path.join(repoRoot, "install.sh"), "utf8")
      .replace(
        'RELEASES_API="https://api.github.com/repos/${REPO}/releases/latest"',
        'RELEASES_API="http://172.16.0.1:18080/latest"',
      )
      .replace(
        'DOWNLOAD_BASE="https://github.com/${REPO}/releases/download"',
        'DOWNLOAD_BASE="http://172.16.0.1:18080/download"',
      );
    writeFileSync(path.join(httpRoot, "install.sh"), installer);

    const fixtureManifest: InstallVmFixtureManifest = {
      schemaVersion: 1,
      sourceIdentity,
      currentVersion,
      versionA: FIXTURE_VERSION_A,
      versionB: FIXTURE_VERSION_B,
      packages,
    };
    writeJson(path.join(temporaryRoot, "fixture-manifest.json"), fixtureManifest);
    writeJson(path.join(httpRoot, "fixture-manifest.json"), fixtureManifest);
    const curlVersions = {
      badChecksum: CURL_BAD_CHECKSUM_VERSION,
      truncated: CURL_TRUNCATED_VERSION,
      unavailable: CURL_UNAVAILABLE_VERSION,
    };
    writeJson(path.join(temporaryRoot, "curl-versions.json"), curlVersions);
    writeJson(path.join(httpRoot, "curl-versions.json"), curlVersions);
    verifyInstallVmFixtures(repoRoot, temporaryRoot);

    if (existsSync(outputRoot)) renameSync(outputRoot, backupRoot);
    try {
      renameSync(temporaryRoot, outputRoot);
    } catch (error) {
      if (existsSync(backupRoot)) renameSync(backupRoot, outputRoot);
      throw error;
    }
    rmSync(backupRoot, { recursive: true, force: true });
    return fixtureManifest;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const outputRoot = path.resolve(
    process.argv[2] ?? path.join(repoRoot, "tmp/install-vm/fixtures"),
  );
  await prepareInstallVmFixtures(repoRoot, outputRoot);
  console.log(`Prepared install VM fixtures in ${outputRoot}`);
}
