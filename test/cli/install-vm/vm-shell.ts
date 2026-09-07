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
} from "node:fs";
import path from "node:path";
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

/** Reject symlinks and non-regular entries before copying generated skills into the staging area. */
function assertRegularTree(root: string) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink())
      throw new Error(`VM shell Hunk input may not be a symlink: ${current}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) pending.push(path.join(current, entry));
    } else if (!stat.isFile()) {
      throw new Error(`VM shell Hunk input must contain only files and directories: ${current}`);
    }
  }
}

/** Remove one staging path only after revalidating its harness-owned location. */
export function removeVmShellHunkInput(repo: string, stagingDir: string) {
  const safeStagingDir = assertSafeInstallVmRuntimePath(repo, stagingDir);
  rmSync(safeStagingDir, { recursive: true, force: true });
}

/** Atomically stage the freshly built binary and bundled source-install skill layout. */
export function stageVmShellHunkInput(repo: string, stagingDir: string) {
  const safeStagingDir = assertSafeInstallVmRuntimePath(repo, stagingDir);
  const stagingParent = path.dirname(safeStagingDir);
  const binary = path.join(repo, "dist", "hunk");
  const skills = path.join(repo, "dist", "skills");
  assertRegularTree(binary);
  assertRegularTree(skills);

  const temporaryDir = mkdtempSync(path.join(stagingParent, ".vm-shell-input-"));
  chmodSync(temporaryDir, 0o700);
  try {
    copyFileSync(binary, path.join(temporaryDir, "hunk"));
    chmodSync(path.join(temporaryDir, "hunk"), 0o755);
    const stagedSkills = path.join(temporaryDir, "hunkdiff", "skills");
    mkdirSync(path.dirname(stagedSkills), { recursive: true, mode: 0o700 });
    cpSync(skills, stagedSkills, { recursive: true });
    removeVmShellHunkInput(repo, safeStagingDir);
    renameSync(temporaryDir, safeStagingDir);
    return safeStagingDir;
  } catch (error) {
    rmSync(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

/** Build the current checkout before publishing its validated files to the VM controller. */
export async function prepareVmShellHunkInput(
  repo: string,
  stagingDir: string,
  commandRunner: Pick<InstallVmCommandRunner, "run">,
  bunExecutable = process.execPath,
) {
  removeVmShellHunkInput(repo, stagingDir);
  await commandRunner.run([bunExecutable, "run", "build:bin"], { cwd: repo });
  return stageVmShellHunkInput(repo, stagingDir);
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
  const hunkInputDir = assertSafeInstallVmRuntimePath(
    repoRoot,
    path.join(runtimeRoot, "vm-shell-input"),
  );
  assertDistinctInstallVmRuntimePaths({ cacheDir, hunkInputDir });
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
    let stagedHunkInput: string | undefined;
    try {
      if (options.withHunk) {
        stagedHunkInput = await prepareVmShellHunkInput(repoRoot, hunkInputDir, commandRunner);
      }
      const image = controllerImageTag();
      await commandRunner.run(buildControllerImageCommand(image, harnessRoot, pins));
      const revalidatedCacheDir = assertSafeInstallVmRuntimePath(repoRoot, cacheDir);
      const revalidatedHunkInput = stagedHunkInput
        ? assertSafeInstallVmRuntimePath(repoRoot, stagedHunkInput)
        : undefined;
      const dockerCommand = buildDockerVmShellCommand(
        image,
        revalidatedCacheDir,
        { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
        { hunkInputDir: revalidatedHunkInput },
      );
      await commandRunner.run(dockerCommand, {
        timeoutMs: false,
        terminationGraceMs: 30_000,
      });
      commandRunner.checkInterrupted();
      return 0;
    } finally {
      if (stagedHunkInput) removeVmShellHunkInput(repoRoot, stagedHunkInput);
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
