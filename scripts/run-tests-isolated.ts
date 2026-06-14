#!/usr/bin/env bun

/**
 * Run each test file in its own `bun test <file>` process and aggregate results.
 *
 * OpenTUI's layout engine (yoga-layout WASM) and Solid's reactive owner are
 * process-level singletons. When `bun test` runs many UI test files in one
 * process, those singletons leak state across files and abort the WASM heap.
 * Running each file in a fresh process restores isolation, so this runner is
 * the source of truth for "does each test file pass on its own".
 *
 * Globs the same paths as the `test` script and exits nonzero if any file fails.
 */

import { Glob } from "bun";
import { resolve } from "node:path";

/** Roots scanned for test files, mirroring the `test` package script. */
const TEST_ROOTS = ["./src", "./packages", "./scripts", "./test/cli", "./test/session"];

/** Match Bun's default test file naming. */
const TEST_FILE_PATTERN = "**/*.{test,spec}.{ts,tsx,js,jsx}";

/** Collect every test file under the configured roots, de-duplicated. */
async function collectTestFiles(): Promise<string[]> {
  const files = new Set<string>();
  for (const root of TEST_ROOTS) {
    const glob = new Glob(TEST_FILE_PATTERN);
    for await (const match of glob.scan({ cwd: root, absolute: true })) {
      // Skip node_modules that may live under a root (e.g. packages/*).
      if (match.includes("/node_modules/")) continue;
      files.add(match);
    }
  }
  return [...files].sort();
}

/** Parse "N pass" / "N fail" out of a `bun test` summary block. */
function parseCounts(output: string): { pass: number; fail: number } {
  const pass = Number(output.match(/^\s*(\d+)\s+pass$/m)?.[1] ?? 0);
  const fail = Number(output.match(/^\s*(\d+)\s+fail$/m)?.[1] ?? 0);
  return { pass, fail };
}

async function main(): Promise<void> {
  const files = await collectTestFiles();
  let totalPass = 0;
  let totalFail = 0;
  const failedFiles: string[] = [];

  for (const file of files) {
    const proc = Bun.spawn(["bun", "test", file], {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // Bun writes the test summary to stderr.
    const combined = `${stdout}\n${stderr}`;
    const { pass, fail } = parseCounts(combined);
    totalPass += pass;
    totalFail += fail;

    const status = fail > 0 || exitCode !== 0 ? "FAIL" : "ok";
    if (status === "FAIL") {
      failedFiles.push(file);
      // Surface the full output for any failing file so CI logs are useful.
      process.stdout.write(combined);
    }
    process.stdout.write(`[${status}] ${pass} pass / ${fail} fail  ${file}\n`);
  }

  process.stdout.write(
    `\n=== isolated totals: ${totalPass} pass / ${totalFail} fail across ${files.length} files ===\n`,
  );
  if (failedFiles.length > 0) {
    process.stdout.write(`failing files:\n${failedFiles.map((f) => `  - ${f}`).join("\n")}\n`);
    process.exit(1);
  }
}

await main();
