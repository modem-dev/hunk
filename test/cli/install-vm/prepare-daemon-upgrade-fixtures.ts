import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { delimiter } from "node:path";
import { createHash } from "node:crypto";
import { resolveHunkProtocolPath } from "./repo-layout";

export const DAEMON_UPGRADE_VERSION_A = "899.0.0";
export const DAEMON_UPGRADE_VERSION_B = "899.0.1";

const DAEMON_REVISION_PATTERN = /export const HUNK_SESSION_DAEMON_VERSION = ([1-9][0-9]*);/g;

/** Read the one numeric Hunk daemon revision declaration used by authenticated app negotiation. */
export function readDaemonRevision(source: string) {
  const matches = [...source.matchAll(DAEMON_REVISION_PATTERN)];
  if (matches.length !== 1) {
    throw new Error("Daemon upgrade fixtures require exactly one HUNK_SESSION_DAEMON_VERSION.");
  }
  const revision = Number(matches[0]![1]);
  if (!Number.isSafeInteger(revision) || revision < 2) {
    throw new Error("Daemon upgrade fixtures require a daemon revision of at least 2.");
  }
  return revision;
}

/** Replace exactly one daemon revision declaration in an isolated fixture checkout. */
export function replaceDaemonRevision(source: string, revision: number) {
  readDaemonRevision(source);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Daemon fixture revision must be a positive safe integer.");
  }
  return source.replace(
    DAEMON_REVISION_PATTERN,
    `export const HUNK_SESSION_DAEMON_VERSION = ${revision};`,
  );
}

/** Enumerate tracked and non-ignored checkout files without consulting committed-only bytes. */
function checkoutFiles(repoRoot: string) {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  if (listed.exitCode !== 0) {
    throw new Error(
      `Unable to enumerate daemon fixture checkout: ${new TextDecoder().decode(listed.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(listed.stdout).split("\0").filter(Boolean);
}

/** Frame one build-input value so paths and contents cannot concatenate ambiguously. */
function updateFramed(hash: ReturnType<typeof createHash>, value: string | Uint8Array) {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

/** Attest ignored dependency bytes/symlink targets plus the exact Bun runtime used to build. */
export function computeDaemonUpgradeBuildInputIdentity(
  repoRoot: string,
  options: {
    dependenciesRoot?: string;
    bunExecutable?: string;
    bunVersion?: string;
  } = {},
) {
  const realRepoRoot = realpathSync(repoRoot);
  const dependenciesRoot = options.dependenciesRoot ?? path.join(repoRoot, "node_modules");
  const bunExecutable = options.bunExecutable ?? process.execPath;
  const bunVersion = options.bunVersion ?? Bun.version;
  if (!existsSync(dependenciesRoot) || !existsSync(bunExecutable)) {
    throw new Error("Daemon upgrade build-input attestation requires dependencies and Bun.");
  }
  const hash = createHash("sha256");
  updateFramed(hash, "hunk-daemon-upgrade-build-input-v1");
  updateFramed(hash, bunVersion);
  updateFramed(hash, readFileSync(bunExecutable));
  const walk = (directory: string, relativeDirectory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.posix.join(relativeDirectory, name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        updateFramed(hash, `d:${relative}`);
        walk(absolute, relative);
      } else if (stat.isSymbolicLink()) {
        const resolvedTarget = realpathSync(absolute);
        const targetRelative = path.relative(realRepoRoot, resolvedTarget);
        if (
          targetRelative === ".." ||
          targetRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(targetRelative)
        ) {
          throw new Error(`Daemon build input symlink escapes the checkout: ${relative}`);
        }
        updateFramed(hash, `l:${relative}`);
        updateFramed(hash, readlinkSync(absolute));
      } else if (stat.isFile()) {
        updateFramed(hash, `f:${relative}`);
        updateFramed(hash, readFileSync(absolute));
      } else {
        throw new Error(`Unsupported daemon build input: ${relative}`);
      }
    }
  };
  walk(dependenciesRoot, "node_modules");
  return hash.digest("hex");
}

/** Build an environment whose `bun` command resolves to the exact attested executable. */
export function createDaemonUpgradeCompilerEnvironment(
  destination: string,
  options: { env?: NodeJS.ProcessEnv; bunExecutable?: string } = {},
) {
  const compilerBin = path.join(destination, ".hunk-fixture-compiler-bin");
  const bunExecutable = realpathSync(options.bunExecutable ?? process.execPath);
  rmSync(compilerBin, { recursive: true, force: true });
  mkdirSync(compilerBin, { recursive: true });
  const bunLink = path.join(compilerBin, "bun");
  symlinkSync(bunExecutable, bunLink);
  const env = {
    ...(options.env ?? process.env),
    PATH: `${compilerBin}${delimiter}${options.env?.PATH ?? process.env.PATH ?? ""}`,
  };
  const resolved = Bun.spawnSync(["sh", "-c", "command -v bun"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const resolvedPath = new TextDecoder().decode(resolved.stdout).trim();
  if (
    resolved.exitCode !== 0 ||
    resolvedPath !== bunLink ||
    realpathSync(resolvedPath) !== bunExecutable
  ) {
    rmSync(compilerBin, { recursive: true, force: true });
    throw new Error("Daemon fixture compiler did not resolve to the attested Bun executable.");
  }
  return {
    env,
    resolvedBun: resolvedPath,
    cleanup: () => rmSync(compilerBin, { recursive: true, force: true }),
  };
}

/** Snapshot installed dependencies into one Linux fixture build without sharing mutable paths. */
export function snapshotDaemonUpgradeDependencies(repoRoot: string, destination: string) {
  if (process.platform !== "linux") {
    throw new Error("Daemon upgrade fixture dependency snapshots require Linux cp(1).");
  }
  const dependencies = path.join(repoRoot, "node_modules");
  if (!existsSync(dependencies)) {
    throw new Error("Daemon upgrade fixture builds require the checkout node_modules directory.");
  }
  mkdirSync(destination, { recursive: true });
  const copied = Bun.spawnSync(
    ["cp", "-a", "--reflink=auto", `${dependencies}${path.sep}.`, destination],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (copied.exitCode !== 0) {
    throw new Error(
      `Unable to snapshot daemon fixture dependencies with cp --reflink=auto: ${new TextDecoder().decode(copied.stderr).trim()}`,
    );
  }
}

/** Return whether a resolved path stays at or below its expected root directory. */
function pathIsContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve one Git checkout path without accepting lexical traversal. */
function containedCheckoutPath(root: string, relativePath: string) {
  if (
    path.isAbsolute(relativePath) ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Daemon fixture checkout path escapes the checkout: ${relativePath}`);
  }
  const absolute = path.resolve(root, ...relativePath.split("/"));
  if (!pathIsContained(path.resolve(root), absolute)) {
    throw new Error(`Daemon fixture checkout path escapes the checkout: ${relativePath}`);
  }
  return absolute;
}

/** Reject existing destination parents that could redirect a checkout copy. */
function assertNoDestinationParentSymlinks(root: string, relativePath: string) {
  let current = path.resolve(root);
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Daemon fixture checkout destination contains a symlink: ${relativePath}`);
    }
  }
}

/** Copy tracked checkout bytes without allowing source or destination symlinks to escape. */
export function copyDaemonUpgradeCheckoutFiles(repoRoot: string, destination: string) {
  const realRepoRoot = realpathSync(repoRoot);
  mkdirSync(destination, { recursive: true });
  const realDestination = realpathSync(destination);
  for (const relativePath of checkoutFiles(repoRoot)) {
    const source = containedCheckoutPath(realRepoRoot, relativePath);
    const resolvedSource = realpathSync(source);
    if (!pathIsContained(realRepoRoot, resolvedSource)) {
      throw new Error(`Daemon fixture checkout entry escapes the checkout: ${relativePath}`);
    }
    const target = containedCheckoutPath(realDestination, relativePath);
    assertNoDestinationParentSymlinks(realDestination, relativePath);
    const stat = lstatSync(source);
    mkdirSync(path.dirname(target), { recursive: true });
    if (stat.isSymbolicLink()) {
      const linkTarget = readlinkSync(source);
      if (path.isAbsolute(linkTarget)) {
        throw new Error(`Daemon fixture checkout symlink must be relative: ${relativePath}`);
      }
      const relocatedTarget = path.resolve(path.dirname(target), linkTarget);
      if (!pathIsContained(realDestination, relocatedTarget)) {
        throw new Error(
          `Daemon fixture checkout symlink escapes the isolated checkout: ${relativePath}`,
        );
      }
      symlinkSync(linkTarget, target);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Unsupported daemon fixture checkout entry: ${relativePath}`);
    }
    copyFileSync(source, target);
    chmodSync(target, stat.mode & 0o777);
  }
}

/** Resolve one mutable fixture source file without following any symlink component. */
function daemonUpgradeRewriteFile(destination: string, relativePath: string) {
  const root = realpathSync(destination);
  const target = containedCheckoutPath(root, relativePath);
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Daemon fixture rewrite path may not contain a symlink: ${relativePath}`);
    }
  }
  if (!lstatSync(target).isFile()) {
    throw new Error(`Daemon fixture rewrite path must be a regular file: ${relativePath}`);
  }
  return target;
}

/** Rewrite only the package version and daemon revision in one isolated checkout. */
export function rewriteDaemonUpgradeVariantSources(
  destination: string,
  packageVersion: string,
  daemonRevision: number,
) {
  const packagePath = daemonUpgradeRewriteFile(destination, "packages/hunk/package.json");
  const protocolPath = daemonUpgradeRewriteFile(
    destination,
    "packages/hunk/src/session/protocol.ts",
  );
  const packageManifest = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
  packageManifest.version = packageVersion;
  writeFileSync(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`);

  writeFileSync(
    protocolPath,
    replaceDaemonRevision(readFileSync(protocolPath, "utf8"), daemonRevision),
  );
}

/** Copy the exact checkout snapshot into an isolated build tree while preserving file modes. */
function copyCheckout(repoRoot: string, destination: string) {
  copyDaemonUpgradeCheckoutFiles(repoRoot, destination);
  snapshotDaemonUpgradeDependencies(repoRoot, path.join(destination, "node_modules"));
}

/** Build one fully functional fixture binary with only version/revision bytes changed. */
async function buildVariant(
  repoRoot: string,
  destination: string,
  packageVersion: string,
  daemonRevision: number,
  buildInputIdentity: string,
) {
  copyCheckout(repoRoot, destination);
  const snapshotIdentity = computeDaemonUpgradeBuildInputIdentity(destination);
  if (snapshotIdentity !== buildInputIdentity) {
    throw new Error("Daemon upgrade dependency snapshot changed while it was copied.");
  }
  rewriteDaemonUpgradeVariantSources(destination, packageVersion, daemonRevision);
  const compiler = createDaemonUpgradeCompilerEnvironment(destination);
  try {
    const proc = Bun.spawn([process.execPath, "run", "./scripts/build-bin.ts"], {
      cwd: destination,
      env: compiler.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await proc.exited) !== 0) {
      throw new Error(`Failed to build daemon upgrade fixture ${packageVersion}.`);
    }
  } finally {
    compiler.cleanup();
  }
  const binary = path.join(destination, "dist", "hunk");
  if (!existsSync(binary)) throw new Error(`Missing daemon upgrade binary for ${packageVersion}.`);
  return binary;
}

export interface DaemonUpgradeFixtureBuild {
  daemonUpgradeBuildInputIdentity: string;
  versionA: string;
  versionB: string;
  revisionA: number;
  revisionB: number;
  binaryA: string;
  binaryB: string;
  binarySha256A: string;
  binarySha256B: string;
}

/** Build incompatible authenticated Hunk binaries from isolated copies of the exact checkout. */
export async function prepareDaemonUpgradeBinaries(repoRoot: string, buildRoot: string) {
  rmSync(buildRoot, { recursive: true, force: true });
  mkdirSync(buildRoot, { recursive: true });
  const daemonUpgradeBuildInputIdentity = computeDaemonUpgradeBuildInputIdentity(repoRoot);
  const protocolSource = readFileSync(resolveHunkProtocolPath(repoRoot), "utf8");
  const revisionB = readDaemonRevision(protocolSource);
  const revisionA = revisionB - 1;
  const binaryA = await buildVariant(
    repoRoot,
    path.join(buildRoot, "revision-a"),
    DAEMON_UPGRADE_VERSION_A,
    revisionA,
    daemonUpgradeBuildInputIdentity,
  );
  const binaryB = await buildVariant(
    repoRoot,
    path.join(buildRoot, "revision-b"),
    DAEMON_UPGRADE_VERSION_B,
    revisionB,
    daemonUpgradeBuildInputIdentity,
  );
  return {
    daemonUpgradeBuildInputIdentity,
    versionA: DAEMON_UPGRADE_VERSION_A,
    versionB: DAEMON_UPGRADE_VERSION_B,
    revisionA,
    revisionB,
    binaryA,
    binaryB,
    binarySha256A: createHash("sha256").update(readFileSync(binaryA)).digest("hex"),
    binarySha256B: createHash("sha256").update(readFileSync(binaryB)).digest("hex"),
  } satisfies DaemonUpgradeFixtureBuild;
}
