import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Return whether a process id still names a live process, treating permission denial as live. */
function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read and validate the pid recorded by one lock directory. */
function readOwnerPid(lockDirectory: string) {
  const owner = JSON.parse(readFileSync(path.join(lockDirectory, "owner.json"), "utf8")) as {
    pid?: unknown;
  };
  if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) throw new Error("invalid pid");
  return Number(owner.pid);
}

/** Acquire the shared install-VM runtime lock without racing stale-owner reclamation. */
export function acquireInstallVmRuntimeLock(
  lockDirectory: string,
  options: {
    pid?: number;
    alive?: (pid: number) => boolean;
  } = {},
) {
  const pid = options.pid ?? process.pid;
  const alive = options.alive ?? processIsAlive;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Install VM lock needs a valid pid.");

  const create = () => {
    mkdirSync(lockDirectory);
    try {
      writeFileSync(path.join(lockDirectory, "owner.json"), `${JSON.stringify({ pid })}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      rmSync(lockDirectory, { recursive: true, force: true });
      throw error;
    }
  };

  for (;;) {
    try {
      create();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lstatSync(lockDirectory).isSymbolicLink()) {
        throw new Error(`Refusing symlinked install VM lock: ${lockDirectory}`);
      }

      let observedOwner: number;
      try {
        observedOwner = readOwnerPid(lockDirectory);
      } catch {
        throw new Error(
          `Install VM lock has no valid owner; remove it after confirming no suite is running: ${lockDirectory}`,
        );
      }
      if (alive(observedOwner)) {
        throw new Error(`Install VM suite is already running under pid ${observedOwner}.`);
      }
      throw new Error(
        `Install VM lock belongs to stale pid ${observedOwner}; remove it after confirming no suite is running: ${lockDirectory}`,
      );
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (!existsSync(lockDirectory) || lstatSync(lockDirectory).isSymbolicLink()) return;
    try {
      if (readOwnerPid(lockDirectory) !== pid) return;
    } catch {
      return;
    }
    rmSync(lockDirectory, { recursive: true, force: true });
  };
}
