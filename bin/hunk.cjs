#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function ensureExecutable(target) {
  if (process.platform === "win32") {
    return;
  }

  try {
    const mode = fs.statSync(target).mode & 0o777;
    if ((mode & 0o111) !== 0) {
      return;
    }
    fs.chmodSync(target, mode | 0o755);
  } catch {
    // Let spawnSync surface the real error if chmod is not possible.
  }
}

function run(target, args) {
  ensureExecutable(target);
  const result = childProcess.spawnSync(target, args, {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(typeof result.status === "number" ? result.status : 1);
}

function hostCandidates() {
  const platformMap = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };
  const archMap = {
    x64: "x64",
    arm64: "arm64",
  };

  const platform = platformMap[os.platform()] || os.platform();
  const arch = archMap[os.arch()] || os.arch();
  const binary = platform === "windows" ? "hunk.exe" : "hunk";

  if (platform === "darwin") {
    if (arch === "arm64") return [{ packageName: "hunkdiff-darwin-arm64", binary }];
    if (arch === "x64") return [{ packageName: "hunkdiff-darwin-x64", binary }];
  }

  if (platform === "linux") {
    if (arch === "arm64") return [{ packageName: "hunkdiff-linux-arm64", binary }];
    if (arch === "x64") return [{ packageName: "hunkdiff-linux-x64", binary }];
  }

  return [];
}

function findInstalledBinary(startDir) {
  let current = startDir;

  for (;;) {
    const modulesDir = path.join(current, "node_modules");
    if (fs.existsSync(modulesDir)) {
      for (const candidate of hostCandidates()) {
        const resolved = path.join(modulesDir, candidate.packageName, "bin", candidate.binary);
        if (fs.existsSync(resolved)) {
          return resolved;
        }
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function bundledBunRuntime() {
  try {
    return require.resolve("bun/bin/bun.exe");
  } catch {
    return null;
  }
}

const overrideBinary = process.env.HUNK_BIN_PATH;
if (overrideBinary) {
  run(overrideBinary, process.argv.slice(2));
}

const scriptDir = path.dirname(fs.realpathSync(__filename));
const prebuiltBinary = findInstalledBinary(scriptDir);
if (prebuiltBinary) {
  run(prebuiltBinary, process.argv.slice(2));
}

const bunBinary = bundledBunRuntime();
if (bunBinary) {
  const entrypoint = path.join(__dirname, "..", "dist", "npm", "main.js");
  run(bunBinary, [entrypoint, ...process.argv.slice(2)]);
}

const printablePackages = hostCandidates()
  .map((candidate) => `"${candidate.packageName}"`)
  .join(" or ");
console.error(
  printablePackages.length > 0
    ? `Failed to locate a matching prebuilt Hunk binary. Try reinstalling hunkdiff or manually installing ${printablePackages}.`
    : `Unsupported platform for prebuilt Hunk binaries: ${os.platform()} ${os.arch()}`,
);
process.exit(1);
