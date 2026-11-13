/**
 * Tracks the daemons and sessions the browser tests start, so none outlives the run.
 *
 * Each test stops its own processes (sessions first, then the daemon) in its teardown. A
 * Playwright worker that dies mid-test cannot, so every process is also recorded under the
 * run's own directory (`HUNK_WEB_TEST_RUN_DIR`, made by `globalSetup.ts`), and the run's global
 * teardown stops whatever is still running from that list. Each process leads its own process
 * group, so stopping it also stops anything it spawned. On Linux a recorded pid is stopped
 * only while its environment still names this run's directory, so a reused pid is never hit.
 */
import { type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The environment variable naming this run's directory. */
export const TEST_RUN_DIR_ENV = "HUNK_WEB_TEST_RUN_DIR";

/** Whether children lead their own process group here (POSIX only). */
export const TEST_PROCESS_GROUPS = process.platform !== "win32";

/** The directory this run's processes and temp directories live under, if a run made one. */
export function testRunDirectory() {
  return process.env[TEST_RUN_DIR_ENV];
}

/** Record one spawned process under the run's directory, so a dead worker cannot orphan it. */
export function trackTestProcess(child: ChildProcess) {
  const runDir = testRunDirectory();
  if (!runDir || child.pid === undefined) return;
  const pids = join(runDir, "pids");
  mkdirSync(pids, { recursive: true });
  writeFileSync(join(pids, String(child.pid)), "");
}

/** Send one signal to a process's group, or to the process alone where groups do not apply. */
function signalTestProcess(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(TEST_PROCESS_GROUPS ? -pid : pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Stop one process (and its group) and wait briefly for it to exit. */
export async function terminateTestProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (!signalTestProcess(child.pid, "SIGTERM")) child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

/** Whether one recorded pid still belongs to this run, as far as the platform can tell. */
function belongsToRun(pid: number, runDir: string) {
  const environ = `/proc/${pid}/environ`;
  if (existsSync("/proc/self/environ")) {
    try {
      return readFileSync(environ, "utf8")
        .split("\0")
        .some((entry) => entry.includes(runDir));
    } catch {
      return false;
    }
  }
  return signalTestProcess(pid, 0);
}

/** Stop every recorded process of one run that is still running, then remove the run. */
export async function sweepTestRun(runDir: string) {
  const pidsDir = join(runDir, "pids");
  const pids = existsSync(pidsDir)
    ? readdirSync(pidsDir)
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    : [];
  const alive = pids.filter((pid) => belongsToRun(pid, runDir));
  for (const pid of alive) signalTestProcess(pid, "SIGTERM");
  if (alive.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    for (const pid of alive.filter((candidate) => belongsToRun(candidate, runDir))) {
      signalTestProcess(pid, "SIGKILL");
    }
  }
  rmSync(runDir, { recursive: true, force: true });
}
