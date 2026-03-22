#!/usr/bin/env bun

interface PackedFile {
  path: string;
  size: number;
}

interface PackResult {
  name: string;
  version: string;
  filename: string;
  entryCount: number;
  files: PackedFile[];
}

const proc = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], {
  cwd: process.cwd(),
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});

const stdout = Buffer.from(proc.stdout).toString("utf8").trim();
const stderr = Buffer.from(proc.stderr).toString("utf8").trim();

if (proc.exitCode !== 0) {
  throw new Error(stderr || stdout || "npm pack --dry-run failed");
}

const jsonMatch = stdout.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/);
const jsonText = jsonMatch?.[1];

if (!jsonText) {
  throw new Error(`Could not find npm pack JSON output. Full stdout:\n${stdout}`);
}

const parsed = JSON.parse(jsonText) as PackResult[];
const pack = parsed[0];

if (!pack) {
  throw new Error("npm pack --dry-run returned no pack result.");
}

const publishedPaths = new Set(pack.files.map((file) => file.path));
const requiredPaths = ["bin/hunk.cjs", "dist/npm/main.js", "README.md", "LICENSE", "package.json"];

for (const path of requiredPaths) {
  if (!publishedPaths.has(path)) {
    throw new Error(`Expected npm package to include ${path}.`);
  }
}

const forbiddenPrefixes = [".github/", "src/", "test/", "scripts/", "tmp/"];
const forbiddenPaths = ["AGENTS.md", "bun.lock"];

for (const file of pack.files) {
  if (
    forbiddenPrefixes.some((prefix) => file.path.startsWith(prefix)) ||
    forbiddenPaths.includes(file.path)
  ) {
    throw new Error(`Unexpected file in npm package: ${file.path}`);
  }
}

if (pack.name !== "hunkdiff") {
  throw new Error(`Expected npm package name to be hunkdiff, got ${pack.name}.`);
}

console.log(
  `Verified npm pack output for ${pack.name}@${pack.version} (${pack.entryCount} files).`,
);
