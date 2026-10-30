#!/usr/bin/env bun

/**
 * Compiles Hunk into a single-file executable at `dist/hunk` and stages the skills beside it.
 *
 * Every compiled distribution goes through this script: `bun run build:bin` for local installs,
 * the prebuilt npm and GitHub release artifacts, and `nix/package.nix`. Keep the Bun command here
 * rather than copying it, so the entrypoints and runtime policy cannot drift between channels.
 *
 * Options:
 *   --runtime-executable <path>  Bun executable to embed as the compiled binary's runtime instead
 *                                of letting Bun download one for the target. The caller guarantees
 *                                it matches the target `compileTargetForHost` picks for this host
 *                                (on x64 that is a `-baseline` build). Offline builds such as Nix
 *                                rely on this.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { HUNK_PACKAGE_ROOT, HUNK_SOURCE_ROOT, REPO_ROOT } from "./package-paths";

/**
 * Source files Bun compiles into the single-file executable, relative to `packages/hunk/src`.
 *
 * The first entry is the program; the rest are additional entrypoints Bun embeds so the compiled
 * binary can resolve them at runtime. `highlightWorkerClient.ts` spawns the syntax worker from
 * `highlightWorkerEntry.js`, so a build that omits it silently falls back to no highlighting.
 */
export const COMPILE_ENTRYPOINTS = ["main.tsx", "highlightWorkerEntry.ts"] as const;

/**
 * Resolves the Bun compile target for one host, or null to keep Bun's own host default.
 *
 * x64 hosts compile against Bun's baseline runtime. Bun's default x64 runtime is built for
 * Haswell (AVX2/BMI2, 2013+) and dies with SIGILL before any Hunk code runs on older CPUs and
 * on VMs that expose a conservative CPU model, so the shipped binary would be unusable there.
 * The baseline runtime only asks for x86-64-v2 (SSE4.2/POPCNT). arm64 has no such split and
 * keeps whatever runtime the host Bun already carries.
 */
export function compileTargetForHost(
  platform: NodeJS.Platform,
  arch: string,
  isMuslHost = () => existsSync("/lib/ld-musl-x86_64.so.1"),
) {
  if (arch !== "x64") {
    return null;
  }

  if (platform === "darwin") {
    return "bun-darwin-x64-baseline";
  }

  if (platform === "win32") {
    return "bun-windows-x64-baseline";
  }

  if (platform === "linux") {
    // The musl and glibc runtimes are not interchangeable, so keep the host's libc.
    return isMuslHost() ? "bun-linux-x64-musl-baseline" : "bun-linux-x64-baseline";
  }

  return null;
}

/** Returns compiler cache variables scoped to the Bun version that populates them. */
export function bunCompilerCacheEnvironment(repoRoot: string, runtimeVersion: string) {
  const installRoot = path.join(repoRoot, ".bun-install", runtimeVersion);
  return {
    BUN_INSTALL: installRoot,
    BUN_INSTALL_CACHE_DIR: path.join(installRoot, "install", "cache"),
  };
}

export interface CompileCommandOptions {
  /** Bun executable that runs the build; also the embedded runtime when no target is set. */
  bun: string;
  /** Compile target from `compileTargetForHost`, or null for Bun's host default. */
  target: string | null;
  /** Pre-fetched runtime for `target`; skips Bun's download. */
  runtimeExecutable?: string | null;
  sourceRoot: string;
  outfile: string;
}

/** Builds the `bun build --compile` argv that produces the Hunk executable. */
export function compileCommand({
  bun,
  target,
  runtimeExecutable,
  sourceRoot,
  outfile,
}: CompileCommandOptions) {
  return [
    bun,
    "build",
    "--compile",
    "--no-compile-autoload-bunfig",
    ...(target ? [`--target=${target}`] : []),
    ...(runtimeExecutable ? [`--compile-executable-path=${runtimeExecutable}`] : []),
    ...COMPILE_ENTRYPOINTS.map((entrypoint) => path.join(sourceRoot, entrypoint)),
    "--outfile",
    outfile,
  ];
}

/**
 * Parses the script's command line; throws on unknown options.
 *
 * Resolves `--runtime-executable` against the caller's `cwd` because the compiler runs from the
 * repo root, where a relative path would point somewhere else.
 */
export function parseBuildOptions(argv: string[], cwd = process.cwd()) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "runtime-executable": { type: "string" },
    },
    strict: true,
  });

  const runtimeExecutable = values["runtime-executable"];
  return { runtimeExecutable: runtimeExecutable ? path.resolve(cwd, runtimeExecutable) : null };
}

if (import.meta.main) {
  const repoRoot = REPO_ROOT;
  const distDir = path.join(repoRoot, "dist");
  const binaryName = process.platform === "win32" ? "hunk.exe" : "hunk";
  const outfile = path.join(distDir, binaryName);
  const legacyOutfile = path.join(distDir, process.platform === "win32" ? "otdiff.exe" : "otdiff");
  const { runtimeExecutable } = parseBuildOptions(process.argv.slice(2));

  if (runtimeExecutable && !existsSync(runtimeExecutable)) {
    throw new Error(`--runtime-executable ${runtimeExecutable} does not exist.`);
  }

  const bunTmpDir = path.join(repoRoot, ".bun-tmp");
  mkdirSync(distDir, { recursive: true });
  mkdirSync(bunTmpDir, { recursive: true });
  rmSync(legacyOutfile, { force: true });

  const target = compileTargetForHost(process.platform, process.arch);

  // Spawn the Bun that is running this script, not whichever `bun` is first on PATH, so the
  // compiler version matches `Bun.version` used for the cache below and callers can pin it.
  const proc = Bun.spawnSync(
    compileCommand({
      bun: process.execPath,
      target,
      runtimeExecutable,
      sourceRoot: HUNK_SOURCE_ROOT,
      outfile,
    }),
    {
      cwd: repoRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        BUN_TMPDIR: bunTmpDir,
        ...bunCompilerCacheEnvironment(repoRoot, Bun.version),
      },
    },
  );

  if (proc.exitCode !== 0) {
    // Bun fetches a non-host target runtime instead of reusing the installed one, so the first
    // build on a machine needs network access; after that it comes from the repo-local cache.
    const offlineHint =
      target && !runtimeExecutable
        ? ` Building for ${target} downloads that runtime once into .bun-install; rerun with network access if the download failed, or pass --runtime-executable.`
        : "";
    throw new Error(`bun build --compile failed with exit ${proc.exitCode}.${offlineHint}`);
  }

  const skillsOutdir = path.join(distDir, "skills");
  rmSync(skillsOutdir, { recursive: true, force: true });
  cpSync(path.join(HUNK_PACKAGE_ROOT, "skills"), skillsOutdir, { recursive: true });

  const runtimeNote = runtimeExecutable ? ` using runtime ${runtimeExecutable}` : "";
  console.log(`Built ${outfile}${target ? ` for ${target}` : ""}${runtimeNote}`);
  console.log(`Staged ${skillsOutdir}`);
}
