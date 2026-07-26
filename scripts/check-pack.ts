#!/usr/bin/env bun

import { npmCommand } from "./script-helpers";

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

const proc = Bun.spawnSync([npmCommand, "pack", "--dry-run", "--json"], {
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
const requiredPaths = [
  "bin/hunk.cjs",
  "dist/npm/main.js",
  "dist/npm/extension/index.d.ts",
  "dist/npm/extension/index.js",
  "dist/npm/opentui/index.d.ts",
  "dist/npm/opentui/index.js",
  "README.md",
  "LICENSE",
  "package.json",
];

for (const path of requiredPaths) {
  if (!publishedPaths.has(path)) {
    throw new Error(`Expected npm package to include ${path}.`);
  }
}

const forbiddenPrefixes = [
  ".github/",
  "src/",
  "test/",
  "scripts/",
  "tmp/",
  "dist/npm/core/",
  "dist/npm/ui/",
];
const forbiddenPaths = ["AGENTS.md", "bun.lock"];

for (const file of pack.files) {
  if (
    forbiddenPrefixes.some((prefix) => file.path.startsWith(prefix)) ||
    forbiddenPaths.includes(file.path)
  ) {
    throw new Error(`Unexpected file in npm package: ${file.path}`);
  }
}

// `hunkdiff/extension` is a façade: its declarations must describe the authoring
// contract and nothing else. Whole-program declaration emission happily ships
// every module the entry reaches, so the published tree is allowlisted here —
// a stray `extension/core/**` or `extension/extensions/**` file means the entry
// grew an import into Hunk's internals and leaked them to consumers.
const extensionPrefix = "dist/npm/extension/";
const allowedExtensionEntries = ["index.js", "index.d.ts"];
const allowedExtensionPrefixes = ["extension-api/"];

for (const file of pack.files) {
  if (!file.path.startsWith(extensionPrefix)) {
    continue;
  }

  const relativePath = file.path.slice(extensionPrefix.length);
  if (
    !allowedExtensionEntries.includes(relativePath) &&
    !allowedExtensionPrefixes.some((prefix) => relativePath.startsWith(prefix))
  ) {
    throw new Error(
      `Unexpected file in the published extension surface: ${file.path}. ` +
        "The hunkdiff/extension entry must only reach src/extension-api.",
    );
  }
}

if (pack.name !== "hunkdiff") {
  throw new Error(`Expected npm package name to be hunkdiff, got ${pack.name}.`);
}

console.log(
  `Verified npm pack output for ${pack.name}@${pack.version} (${pack.entryCount} files).`,
);
