#!/usr/bin/env bun

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
// Solid JSX needs babel-preset-solid at bundle time. The CLI `bun build
// --compile` cannot load a JS plugin, so the binary is compiled through the
// Bun.build API instead, wiring @opentui/solid's plugin explicitly.
import solidPlugin from "@opentui/solid/bun-plugin";

const repoRoot = path.resolve(import.meta.dir, "..");
const distDir = path.join(repoRoot, "dist");
const binaryName = process.platform === "win32" ? "hunk.exe" : "hunk";
const outfile = path.join(distDir, binaryName);
const legacyOutfile = path.join(distDir, process.platform === "win32" ? "otdiff.exe" : "otdiff");

// Keep the compile's temp/install dirs repo-local, matching the prior CLI build.
process.env.BUN_TMPDIR ??= path.join(repoRoot, ".bun-tmp");
process.env.BUN_INSTALL ??= path.join(repoRoot, ".bun-install");

mkdirSync(distDir, { recursive: true });
rmSync(legacyOutfile, { force: true });

const result = await Bun.build({
  entrypoints: [path.join(repoRoot, "src", "main.tsx")],
  target: "bun",
  plugins: [solidPlugin],
  compile: { outfile },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Bun.build --compile failed");
}

console.log(`Built ${outfile}`);
