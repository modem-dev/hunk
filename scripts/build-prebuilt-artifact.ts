#!/usr/bin/env bun

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

export interface StagePrebuiltArtifactOptions {
  repoRoot?: string;
  outputRoot?: string;
  expectedPackage?: string;
}

/** Stage one standalone prebuilt release artifact for the current host. */
export function stagePrebuiltArtifact(options: StagePrebuiltArtifactOptions = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(import.meta.dir, ".."));
  const spec = getHostPlatformPackageSpec();
  const binaryName = binaryFilenameForSpec(spec);
  const compiledBinaryCandidates = [
    path.join(repoRoot, "dist", binaryName),
    path.join(repoRoot, "dist", "hunk"),
  ];
  const compiledBinary = compiledBinaryCandidates.find((candidate) => existsSync(candidate));
  const outputRoot = path.resolve(options.outputRoot ?? releaseArtifactsDir(repoRoot));
  const outputDir = path.join(outputRoot, spec.packageName);

  if (options.expectedPackage && options.expectedPackage !== spec.packageName) {
    throw new Error(
      `Host build resolved to ${spec.packageName}, but the workflow expected ${options.expectedPackage}.`,
    );
  }

  if (!compiledBinary) {
    throw new Error(
      `Missing compiled binary at ${compiledBinaryCandidates.join(" or ")}. Run \`bun run build:bin\` first.`,
    );
  }

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const stagedBinary = path.join(outputDir, binaryName);
  cpSync(compiledBinary, stagedBinary);
  if (spec.os !== "windows") {
    chmodSync(stagedBinary, 0o755);
  }

  const skillsSource = path.join(repoRoot, "skills");
  if (!existsSync(skillsSource)) {
    throw new Error(`Missing skills directory at ${skillsSource}.`);
  }

  const hunkReviewSkill = path.join(skillsSource, "hunk-review", "SKILL.md");
  if (!existsSync(hunkReviewSkill)) {
    throw new Error(`Missing bundled Hunk review skill at ${hunkReviewSkill}.`);
  }

  cpSync(skillsSource, path.join(outputDir, "skills"), { recursive: true });

  const kittySource = path.join(repoRoot, "kitty");
  if (!existsSync(kittySource)) {
    throw new Error(`Missing Kitty integration directory at ${kittySource}.`);
  }

  const kittyWatcher = path.join(kittySource, "hunk-follow.py");
  if (!existsSync(kittyWatcher)) {
    throw new Error(`Missing bundled Kitty watcher at ${kittyWatcher}.`);
  }

  cpSync(kittySource, path.join(outputDir, "kitty"), { recursive: true });
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

  return outputDir;
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = stagePrebuiltArtifact(options);
  console.log(`Prepared prebuilt artifact in ${outputDir}`);
}
