#!/usr/bin/env bun

import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

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

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const distDir = path.join(repoRoot, "dist");
  const binaryName = process.platform === "win32" ? "hunk.exe" : "hunk";
  const outfile = path.join(distDir, binaryName);
  const legacyOutfile = path.join(distDir, process.platform === "win32" ? "otdiff.exe" : "otdiff");

  mkdirSync(distDir, { recursive: true });
  rmSync(legacyOutfile, { force: true });

  const target = compileTargetForHost(process.platform, process.arch);

  const proc = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      "--no-compile-autoload-bunfig",
      ...(target ? [`--target=${target}`] : []),
      path.join(repoRoot, "src", "main.tsx"),
      path.join(repoRoot, "src", "highlightWorkerEntry.ts"),
      "--outfile",
      outfile,
    ],
    {
      cwd: repoRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        BUN_TMPDIR: path.join(repoRoot, ".bun-tmp"),
        ...bunCompilerCacheEnvironment(repoRoot, Bun.version),
      },
    },
  );

  if (proc.exitCode !== 0) {
    // Bun fetches a non-host target runtime instead of reusing the installed one, so the first
    // build on a machine needs network access; after that it comes from the repo-local cache.
    const offlineHint = target
      ? ` Building for ${target} downloads that runtime once into .bun-install; rerun with network access if the download failed.`
      : "";
    throw new Error(`bun build --compile failed with exit ${proc.exitCode}.${offlineHint}`);
  }

  console.log(`Built ${outfile}${target ? ` for ${target}` : ""}`);
}
