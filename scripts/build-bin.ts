#!/usr/bin/env bun

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createOpentuiStableNativeLibPlugin } from "./opentuiStableNativeLibPlugin";

const repoRoot = path.resolve(import.meta.dir, "..");
const distDir = path.join(repoRoot, "dist");
const binaryName = process.platform === "win32" ? "hunk.exe" : "hunk";
const outfile = path.join(distDir, binaryName);
const legacyOutfile = path.join(distDir, process.platform === "win32" ? "otdiff.exe" : "otdiff");

mkdirSync(distDir, { recursive: true });
rmSync(legacyOutfile, { force: true });

// Keep the build's own temp usage repo-local, as the previous CLI spawn did
// via env.
process.env.BUN_TMPDIR = path.join(repoRoot, ".bun-tmp");
process.env.BUN_INSTALL = path.join(repoRoot, ".bun-install");

const result = await Bun.build({
  entrypoints: [path.join(repoRoot, "src", "main.tsx")],
  target: "bun",
  compile: {
    outfile,
    // Matches the previous `--no-compile-autoload-bunfig`.
    autoloadBunfig: false,
  },
  plugins: [createOpentuiStableNativeLibPlugin(repoRoot)],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("bun build --compile failed; see logs above");
}

console.log(`Built ${outfile}`);
