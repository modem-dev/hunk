#!/usr/bin/env bun

import path from "node:path";
import {
  assertBrowserAssetsCurrent,
  assertBrowserBundleCurrent,
  buildBrowserAssetBundle,
  generateBrowserAssets,
} from "./browser-assets";

const repoRoot = path.resolve(import.meta.dir, "..");
if (process.argv.includes("--check")) {
  await assertBrowserBundleCurrent(repoRoot);
  assertBrowserAssetsCurrent(repoRoot);
  console.log("Verified generated browser assets are current.");
} else {
  await buildBrowserAssetBundle(repoRoot);
  console.log(`Generated ${generateBrowserAssets(repoRoot)}.`);
}
