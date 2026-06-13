#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  releaseBenchmarkPath,
  releaseBenchmarkDir,
  readPackageVersion,
} from "./compare-release-benchmarks";

export interface RunReleaseBenchmarkOptions {
  version: string;
  samples: number;
  out: string;
}

const repoRoot = path.resolve(import.meta.dir, "..");

function readArgValue(args: string[], index: number) {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${args[index]}`);
  }
  return value;
}

/** Parse release benchmark CLI options while preserving explicit output paths. */
export async function parseRunReleaseBenchmarkArgs(
  args: string[],
): Promise<RunReleaseBenchmarkOptions> {
  const version = await readPackageVersion(repoRoot);
  const options: RunReleaseBenchmarkOptions = {
    version,
    samples: Number(process.env.HUNK_RELEASE_BENCHMARK_SAMPLES ?? 5),
    out: releaseBenchmarkPath(version, releaseBenchmarkDir(repoRoot)),
  };
  let outExplicitlySet = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--version") {
      options.version = readArgValue(args, index);
      if (!outExplicitlySet) {
        options.out = releaseBenchmarkPath(options.version, releaseBenchmarkDir(repoRoot));
      }
      index += 1;
      continue;
    }

    if (arg === "--samples") {
      options.samples = Number(readArgValue(args, index));
      index += 1;
      continue;
    }

    if (arg === "--out") {
      options.out = path.resolve(readArgValue(args, index));
      outExplicitlySet = true;
      index += 1;
      continue;
    }

    throw new Error(`Unknown release benchmark argument: ${arg}`);
  }

  if (!Number.isFinite(options.samples) || options.samples < 1) {
    throw new Error("--samples must be a positive number");
  }

  return options;
}

/** Run the default benchmark suite and write the versioned release snapshot. */
export async function main(args = Bun.argv.slice(2)) {
  const options = await parseRunReleaseBenchmarkArgs(args);
  mkdirSync(path.dirname(options.out), { recursive: true });

  const proc = Bun.spawn(
    ["bun", "run", "benchmarks/run.ts", "--samples", String(options.samples), "--out", options.out],
    {
      cwd: repoRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, CI: process.env.CI ?? "1" },
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Release benchmark run failed with exit code ${exitCode}`);
  }

  console.log(`Wrote release benchmark ${options.out}`);
  console.log("Commit this file with the release prep change before pushing the release tag.");
}

if (import.meta.main) {
  await main();
}
