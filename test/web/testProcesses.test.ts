/**
 * Covers the browser-test process sweep with real short-lived processes: a recorded process
 * group is stopped with everything it spawned, an unrecorded process and a recorded pid that
 * now belongs to a process outside this run are left running, and the run directory is removed.
 *
 * Linux only: the ownership check reads `/proc/<pid>/environ`, and process groups are POSIX.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepTestRun, TEST_RUN_DIR_ENV, trackTestProcess } from "./testProcesses";

const started: ChildProcess[] = [];

afterEach(() => {
  for (const child of started.splice(0)) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already stopped by the sweep under test.
    }
  }
});

/** Start one shell command leading its own process group, with `env` added to its environment. */
function spawnTestGroup(command: string, env: Record<string, string> = {}) {
  const child = spawn("sh", ["-c", command], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, [TEST_RUN_DIR_ENV]: "", ...env },
  });
  started.push(child);
  return child;
}

/** Read the first line a child prints, such as a grandchild's pid. */
function readTestLine(child: ChildProcess) {
  return new Promise<string>((resolve) => {
    let text = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("\n")) resolve(text.split("\n")[0]!.trim());
    });
  });
}

/** Whether a pid names a live process; a zombie waiting to be reaped counts as stopped. */
function isTestProcessRunning(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

/** Record one pid in a run's directory the way `trackTestProcess` does. */
function recordTestPid(runDir: string, pid: number) {
  mkdirSync(join(runDir, "pids"), { recursive: true });
  writeFileSync(join(runDir, "pids", String(pid)), "");
}

describe.skipIf(process.platform !== "linux")("sweepTestRun", () => {
  test("stops this run's process groups and nothing else, then removes the run", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "hunk-web-run-"));
    const previous = process.env[TEST_RUN_DIR_ENV];

    // A recorded session whose own child (the grandchild) must go with it.
    const owned = spawnTestGroup("sleep 30 & echo $!; wait", { [TEST_RUN_DIR_ENV]: runDir });
    const grandchild = Number(await readTestLine(owned));
    process.env[TEST_RUN_DIR_ENV] = runDir;
    try {
      trackTestProcess(owned);
    } finally {
      if (previous === undefined) delete process.env[TEST_RUN_DIR_ENV];
      else process.env[TEST_RUN_DIR_ENV] = previous;
    }
    // A process this run never recorded.
    const unrelated = spawnTestGroup("sleep 30");
    // A recorded pid whose process no longer names the run (a reused pid).
    const reused = spawnTestGroup("sleep 30");
    recordTestPid(runDir, reused.pid!);

    const ownedExit = new Promise((resolve) => owned.once("exit", resolve));
    await sweepTestRun(runDir);
    await ownedExit;

    expect(isTestProcessRunning(owned.pid!)).toBe(false);
    for (let attempt = 0; attempt < 50 && isTestProcessRunning(grandchild); attempt += 1) {
      await Bun.sleep(20);
    }
    expect(isTestProcessRunning(grandchild)).toBe(false);
    expect(isTestProcessRunning(unrelated.pid!)).toBe(true);
    expect(isTestProcessRunning(reused.pid!)).toBe(true);
    expect(existsSync(runDir)).toBe(false);
  }, 15_000);

  test("removes a run that recorded nothing", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "hunk-web-run-"));

    await sweepTestRun(runDir);

    expect(existsSync(runDir)).toBe(false);
  });
});
