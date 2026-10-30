#!/usr/bin/env bun

/**
 * Opens an interactive shell in one clean Firecracker guest and destroys it on exit.
 *
 * The host runner verifies prerequisites and delegates KVM/network setup to the same constrained
 * controller image used by install compatibility tests. It never mounts the checkout into Docker.
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { CHANGESET_PARSE_SCENARIOS, createSyntheticPatch } from "../../../benchmarks/lib/fixtures";
import {
  assertDistinctInstallVmRuntimePaths,
  assertSafeInstallVmRuntimePath,
  buildControllerImageCommand,
  buildDockerVmShellCommand,
  validateInstallVmPins,
  type InstallVmPins,
} from "./contract";
import { collectInstallVmPreflightFailures } from "./preflight";
import { controllerImageTag, InstallVmCommandError, InstallVmCommandRunner } from "./runner";
import { acquireInstallVmRuntimeLock } from "./runtime-lock";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const harnessRoot = import.meta.dir;
const runtimeRoot = path.join(repoRoot, "tmp", "install-vm");

export interface VmShellArgs {
  withHunk: boolean;
}

export const VM_SHELL_EXAMPLE_FILES = [
  "1-hello-diff/after.ts",
  "1-hello-diff/before.ts",
  "2-mini-app-refactor/change.patch",
  "3-agent-review-demo/agent-context.json",
  "3-agent-review-demo/change.patch",
  "4-ui-polish/after.tsx",
  "4-ui-polish/before.tsx",
  "5-pager-tour/after.ts",
  "5-pager-tour/before.ts",
  "6-readme-screenshot/agent-context.json",
  "6-readme-screenshot/change.patch",
  "7-opentui-component/change.patch",
  "9-agent-markup-notes/agent-context.json",
  "9-agent-markup-notes/change.patch",
] as const;

const VM_SHELL_FIXTURE_README = `# Hunk VM fixtures

The disposable shell starts in /root. These commands use only files staged for this VM:

If you started the shell without --with-hunk, install the Hunk build you want to test first.

  hunk diff --files fixtures/examples/1-hello-diff/before.ts fixtures/examples/1-hello-diff/after.ts
  hunk patch fixtures/examples/2-mini-app-refactor/change.patch
  hunk patch fixtures/examples/3-agent-review-demo/change.patch --agent-context fixtures/examples/3-agent-review-demo/agent-context.json
  hunk diff --files fixtures/examples/4-ui-polish/before.tsx fixtures/examples/4-ui-polish/after.tsx
  hunk diff --files fixtures/examples/5-pager-tour/before.ts fixtures/examples/5-pager-tour/after.ts --pager
  hunk patch fixtures/examples/6-readme-screenshot/change.patch --agent-context fixtures/examples/6-readme-screenshot/agent-context.json --mode split --theme midnight
  hunk patch fixtures/examples/7-opentui-component/change.patch
  hunk patch fixtures/examples/9-agent-markup-notes/change.patch --agent-context fixtures/examples/9-agent-markup-notes/agent-context.json

Benchmark-shaped patches exercise the same deterministic inputs as the repository parser benchmark:

  hunk patch fixtures/benchmarks/many-small-files.patch
  hunk patch fixtures/benchmarks/balanced-changeset.patch
  hunk patch fixtures/benchmarks/large-single-file.patch
`;

/** Parse the intentionally small disposable-shell option contract. */
export function parseVmShellArgs(argv: readonly string[]): VmShellArgs {
  let withHunk = false;
  for (const argument of argv) {
    if (argument !== "--with-hunk") throw new Error(`Unknown VM shell option: ${argument}`);
    if (withHunk) throw new Error("--with-hunk may be specified only once.");
    withHunk = true;
  }
  return { withHunk };
}

/** Require both sides of the interactive session to be attached to a terminal. */
export function validateVmShellTty(stdinIsTty: boolean, stdoutIsTty: boolean) {
  if (!stdinIsTty || !stdoutIsTty) {
    throw new Error("The disposable VM shell requires interactive stdin and stdout terminals.");
  }
}

/** Reject symlinks and non-regular entries before copying files into the staging area. */
function assertRegularTree(root: string) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`VM shell input may not be a symlink: ${current}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) pending.push(path.join(current, entry));
    } else if (!stat.isFile()) {
      throw new Error(`VM shell input must contain only files and directories: ${current}`);
    }
  }
}

/** Reject unsafe path segments, symlink ancestors, and non-regular allowlisted source files. */
function assertRegularFilePath(root: string, relativePath: string) {
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`VM shell input path is unsafe: ${relativePath}`);
  }

  let current = root;
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = path.join(current, segments[index]!);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`VM shell input may not be a symlink: ${current}`);
    const expectsFile = index === segments.length - 1;
    if (expectsFile ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`VM shell input path has an unexpected file type: ${current}`);
    }
  }
}

/** Remove one staging path only after revalidating its harness-owned location. */
export function removeVmShellInput(repo: string, stagingDir: string) {
  const safeStagingDir = assertSafeInstallVmRuntimePath(repo, stagingDir);
  rmSync(safeStagingDir, { recursive: true, force: true });
}

/** Atomically stage curated fixtures and, when requested, the freshly built Hunk install. */
export function stageVmShellInput(
  repo: string,
  stagingDir: string,
  options: { withHunk: boolean },
  createBenchmarkPatch: typeof createSyntheticPatch = createSyntheticPatch,
) {
  const safeStagingDir = assertSafeInstallVmRuntimePath(repo, stagingDir);
  const stagingParent = path.dirname(safeStagingDir);
  const examplesRoot = path.join(repo, "examples");
  for (const relativePath of VM_SHELL_EXAMPLE_FILES) {
    assertRegularFilePath(examplesRoot, relativePath);
  }

  const binary = path.join(repo, "dist", "hunk");
  const skills = path.join(repo, "dist", "skills");
  if (options.withHunk) {
    assertRegularTree(binary);
    assertRegularTree(skills);
  }

  const temporaryDir = mkdtempSync(path.join(stagingParent, ".vm-shell-input-"));
  chmodSync(temporaryDir, 0o700);
  try {
    const fixturesDir = path.join(temporaryDir, "fixtures");
    const stagedExamples = path.join(fixturesDir, "examples");
    const stagedBenchmarks = path.join(fixturesDir, "benchmarks");
    mkdirSync(stagedExamples, { recursive: true, mode: 0o700 });
    mkdirSync(stagedBenchmarks, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(fixturesDir, "README.md"), VM_SHELL_FIXTURE_README);

    for (const relativePath of VM_SHELL_EXAMPLE_FILES) {
      const destination = path.join(stagedExamples, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(path.join(examplesRoot, relativePath), destination);
    }
    for (const scenario of CHANGESET_PARSE_SCENARIOS) {
      const name = `${scenario.name.replaceAll("_", "-")}.patch`;
      writeFileSync(path.join(stagedBenchmarks, name), createBenchmarkPatch(scenario.options));
    }

    if (options.withHunk) {
      copyFileSync(binary, path.join(temporaryDir, "hunk"));
      chmodSync(path.join(temporaryDir, "hunk"), 0o755);
      const stagedSkills = path.join(temporaryDir, "hunkdiff", "skills");
      mkdirSync(path.dirname(stagedSkills), { recursive: true, mode: 0o700 });
      cpSync(skills, stagedSkills, { recursive: true });
    }

    removeVmShellInput(repo, safeStagingDir);
    renameSync(temporaryDir, safeStagingDir);
    return safeStagingDir;
  } catch (error) {
    rmSync(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

/** Build optional Hunk artifacts before publishing one validated shell payload. */
export async function prepareVmShellInput(
  repo: string,
  stagingDir: string,
  options: { withHunk: boolean },
  commandRunner: Pick<InstallVmCommandRunner, "run">,
  bunExecutable = process.execPath,
  createBenchmarkPatch: typeof createSyntheticPatch = createSyntheticPatch,
) {
  removeVmShellInput(repo, stagingDir);
  if (options.withHunk) {
    await commandRunner.run([bunExecutable, "run", "build:bin"], { cwd: repo });
  }
  return stageVmShellInput(repo, stagingDir, options, createBenchmarkPatch);
}

/** Run one shell task while owning the shared VM lock and signal-forwarding lifecycle. */
export async function runWithVmShellRuntime<T>(
  lockPath: string,
  commandRunner: InstallVmCommandRunner,
  task: () => Promise<T>,
) {
  const releaseLock = acquireInstallVmRuntimeLock(lockPath);
  commandRunner.start();
  try {
    return await task();
  } finally {
    commandRunner.stop();
    releaseLock();
  }
}

/** Build the controller image, open the disposable guest, and release its shared runtime lock. */
export async function main(argv = process.argv.slice(2)) {
  const options = parseVmShellArgs(argv);
  validateVmShellTty(process.stdin.isTTY === true, process.stdout.isTTY === true);

  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const cacheDir = assertSafeInstallVmRuntimePath(repoRoot, path.join(runtimeRoot, "cache"));
  const shellInputDir = assertSafeInstallVmRuntimePath(
    repoRoot,
    path.join(runtimeRoot, "vm-shell-input"),
  );
  assertDistinctInstallVmRuntimePaths({ cacheDir, shellInputDir });
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  chmodSync(cacheDir, 0o700);

  const failures = await collectInstallVmPreflightFailures(runtimeRoot);
  if (failures.length > 0) {
    throw new Error(`Disposable VM shell preflight failed:\n- ${failures.join("\n- ")}`);
  }

  const pins: InstallVmPins = validateInstallVmPins(
    JSON.parse(readFileSync(path.join(harnessRoot, "pins.json"), "utf8")),
  );
  const commandRunner = new InstallVmCommandRunner();
  return await runWithVmShellRuntime(path.join(runtimeRoot, ".lock"), commandRunner, async () => {
    let stagedShellInput: string | undefined;
    try {
      stagedShellInput = await prepareVmShellInput(repoRoot, shellInputDir, options, commandRunner);
      const image = controllerImageTag();
      await commandRunner.run(buildControllerImageCommand(image, harnessRoot, pins));
      const revalidatedCacheDir = assertSafeInstallVmRuntimePath(repoRoot, cacheDir);
      const revalidatedShellInput = assertSafeInstallVmRuntimePath(repoRoot, stagedShellInput);
      const dockerCommand = buildDockerVmShellCommand(
        image,
        revalidatedCacheDir,
        { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
        { shellInputDir: revalidatedShellInput, withHunk: options.withHunk },
      );
      await commandRunner.run(dockerCommand, {
        timeoutMs: false,
        terminationGraceMs: 30_000,
      });
      commandRunner.checkInterrupted();
      return 0;
    } finally {
      if (stagedShellInput) removeVmShellInput(repoRoot, stagedShellInput);
    }
  });
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = error instanceof InstallVmCommandError ? error.exitCode : 1;
  }
}
