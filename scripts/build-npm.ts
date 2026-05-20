#!/usr/bin/env bun

import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const outdir = path.join(repoRoot, "dist", "npm");
const typesOutdir = path.join(repoRoot, "dist", "npm-types");
const opentuiOutdir = path.join(outdir, "opentui");
const opentuiTypesDir = path.join(typesOutdir, "src", "opentui");
const embeddedOutdir = path.join(outdir, "embedded");
const embeddedTypesDir = path.join(typesOutdir, "src", "embedded");
const libraryExternals = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@opentui/core",
  "@opentui/react",
  "@opentui/react/jsx-runtime",
  "@opentui/react/jsx-dev-runtime",
  "@pierre/diffs",
];

const bunEnv = {
  ...process.env,
  BUN_TMPDIR: path.join(repoRoot, ".bun-tmp"),
  BUN_INSTALL: path.join(repoRoot, ".bun-install"),
};

type LibraryBuildLog = Awaited<ReturnType<typeof Bun.build>>["logs"][number];

interface BuildLibraryExportOptions {
  entrypoint: string;
  name: string;
  outputDirectory: string;
}

interface FormatBuildLibraryExportErrorOptions {
  logs: readonly LibraryBuildLog[];
  name: string;
}

function runBun(args: string[]) {
  const proc = Bun.spawnSync(["bun", ...args], {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: bunEnv,
  });

  if (proc.exitCode !== 0) {
    throw new Error(`bun ${args.join(" ")} failed with exit ${proc.exitCode}`);
  }
}

/** Format a Bun.build failure so the runtime reports the build diagnostics once. */
function formatBuildLibraryExportError({ logs, name }: FormatBuildLibraryExportErrorOptions) {
  const details = logs
    .map((log) => log.message)
    .filter((message) => message.length > 0)
    .join("\n");

  return details
    ? `Failed to build ${name} export:\n${details}`
    : `Failed to build ${name} export.`;
}

/** Build one npm package subpath export. */
async function buildLibraryExport({
  entrypoint,
  name,
  outputDirectory,
}: BuildLibraryExportOptions) {
  const build = await Bun.build({
    entrypoints: [entrypoint],
    target: "node",
    format: "esm",
    outdir: outputDirectory,
    naming: { entry: "index.js" },
    external: libraryExternals,
  });

  if (!build.success) {
    throw new Error(formatBuildLibraryExportError({ logs: build.logs, name }));
  }
}

rmSync(outdir, { recursive: true, force: true });
rmSync(typesOutdir, { recursive: true, force: true });
mkdirSync(opentuiOutdir, { recursive: true });
mkdirSync(embeddedOutdir, { recursive: true });

runBun([
  "build",
  path.join(repoRoot, "src", "main.tsx"),
  "--target",
  "bun",
  "--format",
  "esm",
  "--outdir",
  outdir,
  "--entry-naming",
  "main.js",
]);

const mainJs = path.join(outdir, "main.js");
// chmod is a no-op on Windows; preserve exec bits on Unix so the bin runs in npm-installed packages.
if (process.platform !== "win32") {
  chmodSync(mainJs, 0o755);
}

await buildLibraryExport({
  entrypoint: path.join(repoRoot, "src", "opentui", "index.ts"),
  name: "OpenTUI",
  outputDirectory: opentuiOutdir,
});
await buildLibraryExport({
  entrypoint: path.join(repoRoot, "src", "embedded", "index.ts"),
  name: "embedded Hunk",
  outputDirectory: embeddedOutdir,
});

runBun(["x", "tsc", "-p", path.join(repoRoot, "tsconfig.npm-exports.json")]);

for (const entry of readdirSync(opentuiTypesDir)) {
  if (entry.endsWith(".d.ts")) {
    copyFileSync(path.join(opentuiTypesDir, entry), path.join(opentuiOutdir, entry));
  }
}

for (const entry of ["index.d.ts", "types.d.ts"]) {
  copyFileSync(path.join(embeddedTypesDir, entry), path.join(embeddedOutdir, entry));
}

rmSync(typesOutdir, { recursive: true, force: true });

console.log(`Built ${mainJs}`);
console.log(`Built ${path.join(opentuiOutdir, "index.js")}`);
console.log(`Built ${path.join(embeddedOutdir, "index.js")}`);
