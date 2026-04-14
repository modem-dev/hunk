#!/usr/bin/env bun

import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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

const repoRoot = path.resolve(import.meta.dir, "..");
const packageVersion = JSON.parse(await Bun.file(path.join(repoRoot, "package.json")).text())
  .version as string;
const releaseRoot = releaseNpmDir(repoRoot);
const hostSpec = getHostPlatformPackageSpec();
const tempRoot = path.join(repoRoot, "tmp");
mkdirSync(tempRoot, { recursive: true });
const packageDir = mkdtempSync(path.join(tempRoot, "hunk-prebuilt-pack-"));
const installDir = mkdtempSync(path.join(tempRoot, "hunk-prebuilt-install-"));
const smokeMetaDir = mkdtempSync(path.join(tempRoot, "hunk-prebuilt-meta-"));
const nodeBinary = Bun.spawnSync(["bash", "-lc", "command -v node"], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});
const resolvedNode = Buffer.from(nodeBinary.stdout).toString("utf8").trim();
if (nodeBinary.exitCode !== 0 || resolvedNode.length === 0) {
  throw new Error("Could not resolve node on PATH for the prebuilt install smoke test.");
}
const bashBinary = Bun.spawnSync(["bash", "-lc", "command -v bash"], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});
const resolvedBash = Buffer.from(bashBinary.stdout).toString("utf8").trim();
if (bashBinary.exitCode !== 0 || resolvedBash.length === 0) {
  throw new Error("Could not resolve bash on PATH for the prebuilt install smoke test.");
}
const nodeDir = path.dirname(resolvedNode);
const bashDir = path.dirname(resolvedBash);

try {
  run(["npm", "pack", "--pack-destination", packageDir], {
    cwd: path.join(releaseRoot, hostSpec.packageName),
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

  run(["npm", "pack", "--pack-destination", packageDir], {
    cwd: smokePackageDir,
  });
  const metaTarball = path.join(packageDir, `hunkdiff-${packageVersion}.tgz`);

  run(["npm", "install", "-g", "--prefix", installDir, metaTarball]);

  const sanitizedPath = [path.join(installDir, "bin"), nodeDir, bashDir].join(":");
  const installedHunk = path.join(installDir, "bin", "hunk");
  const installedPlatformBinary = path.join(
    installDir,
    "lib",
    "node_modules",
    "hunkdiff",
    "node_modules",
    hostSpec.packageName,
    "bin",
    binaryFilenameForSpec(hostSpec),
  );
  const commandEnv = {
    ...process.env,
    PATH: sanitizedPath,
  };

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

  const skillPath = run([installedHunk, "skill", "path"], {
    env: commandEnv,
  }).stdout.trim();
  if (
    !skillPath.endsWith(path.join("skills", "hunk-review", "SKILL.md")) ||
    !existsSync(skillPath)
  ) {
    throw new Error(
      `Expected installed hunk skill path to resolve to the bundled skill.\n${skillPath}`,
    );
  }

  const bunCheck = Bun.spawnSync(
    [
      resolvedNode,
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
  rmSync(packageDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
  rmSync(smokeMetaDir, { recursive: true, force: true });
}
