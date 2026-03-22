#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  binaryFilenameForSpec,
  getHostPlatformPackageSpec,
  releaseArtifactsDir,
} from "./prebuilt-package-helpers";

function parseArgs(argv: string[]) {
  let outputRoot: string | undefined;
  let expectedPackage: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output-root") {
      outputRoot = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--expect-package") {
      expectedPackage = argv[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return { outputRoot, expectedPackage };
}

const repoRoot = path.resolve(import.meta.dir, "..");
const options = parseArgs(process.argv.slice(2));
const spec = getHostPlatformPackageSpec();
const binaryName = binaryFilenameForSpec(spec);
const compiledBinary = path.join(repoRoot, "dist", "hunk");
const outputRoot = path.resolve(options.outputRoot ?? releaseArtifactsDir(repoRoot));
const outputDir = path.join(outputRoot, spec.packageName);

if (options.expectedPackage && options.expectedPackage !== spec.packageName) {
  throw new Error(
    `Host build resolved to ${spec.packageName}, but the workflow expected ${options.expectedPackage}.`,
  );
}

if (!existsSync(compiledBinary)) {
  throw new Error(`Missing compiled binary at ${compiledBinary}. Run \`bun run build:bin\` first.`);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
cpSync(compiledBinary, path.join(outputDir, binaryName));
writeFileSync(
  path.join(outputDir, "metadata.json"),
  `${JSON.stringify(
    {
      packageName: spec.packageName,
      os: spec.os,
      cpu: spec.cpu,
      binaryName,
    },
    null,
    2,
  )}\n`,
);

console.log(`Prepared prebuilt artifact in ${outputDir}`);
