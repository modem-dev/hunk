#!/usr/bin/env bun

import path from "node:path";
import {
  assertBrowserAssetsCurrent,
  assertBrowserBundleCurrent,
  buildBrowserAssetBundle,
  canRebuildCanonicalBrowserBundle,
  generateBrowserAssets,
} from "./browser-assets";

const repoRoot = path.resolve(import.meta.dir, "..");
if (process.argv.includes("--check")) {
  await assertBrowserBundleCurrent(repoRoot);
  assertBrowserAssetsCurrent(repoRoot);
  console.log("Verified generated browser assets are current.");
} else {
  if (!canRebuildCanonicalBrowserBundle()) {
    throw new Error(
      "Browser assets must be generated on macOS, Linux, or WSL because Bun's Windows bundle output is host-dependent.",
    );
  }
  await buildBrowserAssetBundle(repoRoot);
  console.log(`Generated ${generateBrowserAssets(repoRoot)}.`);
}
