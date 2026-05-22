#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function bundledSkillPath() {
  return path.join(__dirname, "..", "skills", "hunk-review", "SKILL.md");
}

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
  const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[os.platform()];
  const arch = { x64: "x64", arm64: "arm64" }[os.arch()];
  if (!platform || !arch || (platform === "windows" && arch !== "x64")) {
    return [];
  }

  return [
    {
      packageName: `hunkdiff-${platform}-${arch}`,
      binary: platform === "windows" ? "hunk.exe" : "hunk",
    },
  ];
}

function readPackageVersion(packageRoot) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch {
    return null;
  }
}

function findInstalledBinary(startDir) {
  const expectedVersion = readPackageVersion(path.join(__dirname, ".."));
  let current = startDir;

  for (;;) {
    const modulesDir = path.join(current, "node_modules");
    if (fs.existsSync(modulesDir)) {
      for (const candidate of hostCandidates()) {
        const packageRoot = path.join(modulesDir, candidate.packageName);
        const resolved = path.join(packageRoot, "bin", candidate.binary);
        if (fs.existsSync(resolved)) {
          const installedVersion = readPackageVersion(packageRoot);
          if (expectedVersion && installedVersion && installedVersion !== expectedVersion) {
            continue;
          }

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

const forwardedArgs = process.argv.slice(2);
if (forwardedArgs.length === 2 && forwardedArgs[0] === "skill" && forwardedArgs[1] === "path") {
  const skillPath = bundledSkillPath();
  if (!fs.existsSync(skillPath)) {
    console.error(`hunk: could not locate the bundled Hunk review skill at ${skillPath}`);
    process.exit(1);
  }

  process.stdout.write(`${skillPath}\n`);
  process.exit(0);
}

const overrideBinary = process.env.HUNK_BIN_PATH;
if (overrideBinary) {
  run(overrideBinary, forwardedArgs);
}

const scriptDir = path.dirname(fs.realpathSync(__filename));
const prebuiltBinary = findInstalledBinary(scriptDir);
if (prebuiltBinary) {
  run(prebuiltBinary, forwardedArgs);
}

const bunBinary = bundledBunRuntime();
if (bunBinary) {
  const entrypoint = path.join(__dirname, "..", "dist", "npm", "main.js");
  run(bunBinary, [entrypoint, ...forwardedArgs]);
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
