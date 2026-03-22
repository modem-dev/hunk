#!/usr/bin/env bun

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { getHostPlatformPackageSpec, releaseNpmDir } from "./prebuilt-package-helpers";

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
const nodeDir = path.dirname(resolvedNode);

try {
  run(["npm", "pack", "--pack-destination", packageDir], {
    cwd: path.join(releaseRoot, hostSpec.packageName),
  });
  run(["npm", "pack", "--pack-destination", packageDir], {
    cwd: path.join(releaseRoot, "hunkdiff"),
  });

  const platformTarball = path.join(packageDir, `${hostSpec.packageName}-${packageVersion}.tgz`);
  const metaTarball = path.join(packageDir, `hunkdiff-${packageVersion}.tgz`);

  run(["npm", "install", "-g", "--prefix", installDir, platformTarball]);
  run(["npm", "install", "-g", "--prefix", installDir, metaTarball]);

  const sanitizedPath = `${path.join(installDir, "bin")}:${nodeDir}`;
  const installedHunk = path.join(installDir, "bin", "hunk");
  const help = run([installedHunk, "--help"], {
    env: {
      ...process.env,
      PATH: sanitizedPath,
    },
  });

  if (help.stdout.includes("Usage: hunk") === false) {
    throw new Error(`Expected help output to include 'Usage: hunk'.\n${help.stdout}`);
  }

  const bunCheck = Bun.spawnSync(
    [
      resolvedNode,
      "-e",
      "const {spawnSync}=require('node:child_process'); process.exit(spawnSync('bun',['--version'],{stdio:'ignore'}).status===0?1:0);",
    ],
    {
      env: {
        ...process.env,
        PATH: sanitizedPath,
      },
    },
  );

  if (bunCheck.exitCode !== 0) {
    throw new Error("bun unexpectedly available on the prebuilt install smoke-test PATH");
  }

  console.log(`Verified prebuilt npm install smoke test with ${hostSpec.packageName}`);
} finally {
  rmSync(packageDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
}
