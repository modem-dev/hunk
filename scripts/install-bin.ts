#!/usr/bin/env bun

import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const isWindows = process.platform === "win32";
const binaryName = isWindows ? "hunk.exe" : "hunk";
const legacyBinaryName = isWindows ? "otdiff.exe" : "otdiff";
const binaryPath = path.join(repoRoot, "dist", binaryName);

function defaultInstallDir() {
  if (isWindows) {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Programs", "hunk");
  }

  return path.join(os.homedir(), ".local", "bin");
}

const installDir = process.env.HUNK_INSTALL_DIR ?? defaultInstallDir();
const installPath = path.join(installDir, binaryName);
const legacyInstallPath = path.join(installDir, legacyBinaryName);

const buildScript = path.join(repoRoot, "scripts", "build-bin.ts");
const build = Bun.spawnSync(["bun", "run", buildScript], {
  cwd: repoRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

if (build.exitCode !== 0) {
  throw new Error(`scripts/build-bin.ts failed with exit ${build.exitCode}`);
}

mkdirSync(installDir, { recursive: true });
copyFileSync(binaryPath, installPath);
if (!isWindows) {
  chmodSync(installPath, 0o755);
}
rmSync(legacyInstallPath, { force: true });

console.log(`Installed ${installPath}`);

const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
const installDirOnPath = pathEntries.some((entry) => {
  // Windows paths are case-insensitive; normalize both sides for the comparison.
  const normalizedEntry = isWindows ? path.normalize(entry).toLowerCase() : path.normalize(entry);
  const normalizedInstallDir = isWindows
    ? path.normalize(installDir).toLowerCase()
    : path.normalize(installDir);
  return normalizedEntry === normalizedInstallDir;
});

if (!installDirOnPath) {
  console.warn(`Warning: ${installDir} is not on PATH`);
}
