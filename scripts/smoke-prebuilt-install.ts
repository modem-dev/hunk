#!/usr/bin/env bun

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  binaryFilenameForSpec,
  getHostPlatformPackageSpec,
  releaseNpmDir,
} from "./prebuilt-package-helpers";
import { envWithPath, npmCommand } from "./script-helpers";

/** Return whether an installed dependency tree contains Bun's npm packages. */
function containsBunPackage(root: string) {
  if (!existsSync(root)) return false;

  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "bun" && path.basename(directory) === "node_modules") return true;
        if (entry.name.startsWith("bun-") && path.basename(directory) === "@oven") return true;
        pending.push(entryPath);
      }
    }
  }

  return false;
}

function run(command: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const proc = Bun.spawnSync(command, {
    cwd: options?.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: options?.env ?? process.env,
  });

  const stdout = Buffer.from(proc.stdout).toString("utf8");
  const stderr = Buffer.from(proc.stderr).toString("utf8");

  if (proc.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with exit ${proc.exitCode}\n${stderr || stdout}`.trim(),
    );
  }

  return { stdout, stderr };
}

/** Resolve a command path for a sanitized PATH that still works cross-platform. */
function commandPath(command: string) {
  const proc = Bun.spawnSync(
    process.platform === "win32" ? ["where", command] : ["bash", "-lc", `command -v ${command}`],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    },
  );
  const resolved = Buffer.from(proc.stdout).toString("utf8").split(/\r?\n/, 1)[0]?.trim();
  if (proc.exitCode !== 0 || !resolved) {
    throw new Error(`Could not resolve ${command} on PATH for the prebuilt install smoke test.`);
  }

  return resolved;
}

/** Resolve a command directory for a sanitized PATH that still works cross-platform. */
function commandDirectory(command: string) {
  return path.dirname(commandPath(command));
}

const repoRoot = path.resolve(import.meta.dir, "..");
const packageVersion = JSON.parse(
  await Bun.file(path.join(repoRoot, "packages", "hunk", "package.json")).text(),
).version as string;
const releaseRoot = releaseNpmDir(repoRoot);
const hostSpec = getHostPlatformPackageSpec();
const tempRoot = path.join(repoRoot, "tmp");
mkdirSync(tempRoot, { recursive: true });
let packageDir: string | undefined;
let installDir: string | undefined;
let smokeMetaDir: string | undefined;

try {
  packageDir = mkdtempSync(path.join(tempRoot, "hunk-prebuilt-pack-"));
  installDir = mkdtempSync(path.join(tempRoot, "hunk-prebuilt-install-"));
  smokeMetaDir = mkdtempSync(path.join(tempRoot, "hunk-prebuilt-meta-"));

  const nodePath = commandPath("node");
  const nodeDir = path.dirname(nodePath);
  // bash is required on Unix where the npm-installed wrapper shells out via `#!/usr/bin/env bash`,
  // but the Windows `hunk.cmd` shim does not need bash on PATH.
  const bashDir = process.platform === "win32" ? undefined : commandDirectory("bash");

  // Artifact transfer normalizes file modes before the publish job. Reproduce
  // that boundary so this test proves npm restores execution from the platform
  // package's `bin` declaration rather than relying on the staged mode.
  const smokePlatformDir = path.join(smokeMetaDir, hostSpec.packageName);
  cpSync(path.join(releaseRoot, hostSpec.packageName), smokePlatformDir, { recursive: true });
  if (process.platform !== "win32") {
    chmodSync(path.join(smokePlatformDir, "bin", binaryFilenameForSpec(hostSpec)), 0o644);
  }

  run([npmCommand, "pack", "--pack-destination", packageDir], {
    cwd: smokePlatformDir,
  });

  const platformTarball = path.join(packageDir, `${hostSpec.packageName}-${packageVersion}.tgz`);

  // Point a temp copy of the staged meta package at the local platform tarball.
  // The real manifest uses semver ranges, but this smoke test runs before publish.
  const smokePackageDir = path.join(smokeMetaDir, "hunkdiff");
  cpSync(path.join(releaseRoot, "hunkdiff"), smokePackageDir, { recursive: true });
  const smokeManifestPath = path.join(smokePackageDir, "package.json");
  const smokeManifest = JSON.parse(readFileSync(smokeManifestPath, "utf8")) as {
    optionalDependencies?: Record<string, string>;
  };
  smokeManifest.optionalDependencies = {
    ...smokeManifest.optionalDependencies,
    [hostSpec.packageName]: `file:${platformTarball}`,
  };
  writeFileSync(smokeManifestPath, `${JSON.stringify(smokeManifest, null, 2)}\n`);

  run([npmCommand, "pack", "--pack-destination", packageDir], {
    cwd: smokePackageDir,
  });
  const metaTarball = path.join(packageDir, `hunkdiff-${packageVersion}.tgz`);

  run([npmCommand, "install", "-g", "--prefix", installDir, metaTarball]);

  const installedBinDir = process.platform === "win32" ? installDir : path.join(installDir, "bin");
  const installedPackageRoot =
    process.platform === "win32"
      ? path.join(installDir, "node_modules", "hunkdiff")
      : path.join(installDir, "lib", "node_modules", "hunkdiff");
  const sanitizedPath = [installedBinDir, nodeDir, bashDir].filter(Boolean).join(path.delimiter);
  const installedHunk = path.join(
    installedBinDir,
    process.platform === "win32" ? "hunk.cmd" : "hunk",
  );
  const installedPlatformBinary = path.join(
    installedPackageRoot,
    "node_modules",
    hostSpec.packageName,
    "bin",
    binaryFilenameForSpec(hostSpec),
  );
  const commandEnv = envWithPath(sanitizedPath);
  const pierreInstallCandidates = [
    path.join(installedPackageRoot, "node_modules", "@pierre", "diffs"),
    path.join(path.dirname(installedPackageRoot), "@pierre", "diffs"),
    path.join(installDir, "node_modules", "@pierre", "diffs"),
  ];

  if (pierreInstallCandidates.some((candidate) => existsSync(candidate))) {
    throw new Error("Expected a CLI-only Hunk install to omit the optional @pierre/diffs peer.");
  }

  if (containsBunPackage(installDir)) {
    throw new Error("Expected a prebuilt Hunk install to omit bun and @oven/bun-* packages.");
  }

  if (process.platform !== "win32") {
    const installedBinaryMode = statSync(installedPlatformBinary).mode & 0o777;
    if ((installedBinaryMode & 0o111) === 0) {
      throw new Error(
        `Expected installed platform binary to keep execute bits, got mode ${installedBinaryMode.toString(8)} at ${installedPlatformBinary}`,
      );
    }
  }

  const help = run([installedHunk, "--help"], {
    env: commandEnv,
  });

  if (help.stdout.includes("Usage: hunk") === false) {
    throw new Error(`Expected help output to include 'Usage: hunk'.\n${help.stdout}`);
  }

  const version = run([installedHunk, "--version"], {
    env: commandEnv,
  });
  if (version.stdout !== `${packageVersion}\n`) {
    throw new Error(
      `Expected installed hunk --version to print ${packageVersion}.\n${version.stdout}`,
    );
  }

  // The bare command keeps naming the review skill; every bundled skill must
  // also resolve by name, since the install is what users discover them through.
  const skillPathChecks: [args: string[], skillName: string][] = [
    [["skill", "path"], "hunk-review"],
    [["skill", "path", "hunk-review"], "hunk-review"],
    [["skill", "path", "hunk-extensions"], "hunk-extensions"],
  ];

  for (const [args, skillName] of skillPathChecks) {
    const skillPath = run([installedHunk, ...args], { env: commandEnv }).stdout.trim();
    if (!skillPath.endsWith(path.join("skills", skillName, "SKILL.md")) || !existsSync(skillPath)) {
      throw new Error(
        `Expected installed \`hunk ${args.join(" ")}\` to resolve the bundled ${skillName} skill.\n${skillPath}`,
      );
    }
  }

  const bunCheck = Bun.spawnSync(
    [
      nodePath,
      "-e",
      "const {spawnSync}=require('node:child_process'); process.exit(spawnSync('bun',['--version'],{stdio:'ignore'}).status===0?1:0);",
    ],
    {
      env: commandEnv,
    },
  );

  if (bunCheck.exitCode !== 0) {
    throw new Error("bun unexpectedly available on the prebuilt install smoke-test PATH");
  }

  console.log(`Verified prebuilt npm install smoke test with ${hostSpec.packageName}`);
} finally {
  if (packageDir) {
    rmSync(packageDir, { recursive: true, force: true });
  }
  if (installDir) {
    rmSync(installDir, { recursive: true, force: true });
  }
  if (smokeMetaDir) {
    rmSync(smokeMetaDir, { recursive: true, force: true });
  }
}
