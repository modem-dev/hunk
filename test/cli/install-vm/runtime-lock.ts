import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
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

/** Acquire the shared install-VM runtime lock, reclaiming only a demonstrably stale owner. */
export function acquireInstallVmRuntimeLock(
  lockDirectory: string,
  options: {
    pid?: number;
    alive?: (pid: number) => boolean;
    beforeStaleClaim?: () => void;
  } = {},
) {
  const pid = options.pid ?? process.pid;
  const alive = options.alive ?? processIsAlive;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Install VM lock needs a valid pid.");

  const create = () => {
    mkdirSync(lockDirectory);
    writeFileSync(path.join(lockDirectory, "owner.json"), `${JSON.stringify({ pid })}\n`, {
      mode: 0o600,
    });
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

      options.beforeStaleClaim?.();
      const quarantine = `${lockDirectory}.stale-${pid}-${randomUUID()}`;
      try {
        renameSync(lockDirectory, quarantine);
      } catch (claimError) {
        if ((claimError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw claimError;
      }

      let claimedOwner: number | undefined;
      try {
        claimedOwner = readOwnerPid(quarantine);
      } catch {
        // An invalid stale lock is safe to quarantine, but never silently replace a new valid one.
      }
      if (claimedOwner !== undefined && claimedOwner !== observedOwner) {
        try {
          renameSync(quarantine, lockDirectory);
        } catch {
          rmSync(quarantine, { recursive: true, force: true });
        }
        continue;
      }

      try {
        create();
      } catch (createError) {
        rmSync(quarantine, { recursive: true, force: true });
        if ((createError as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw createError;
      }
      rmSync(quarantine, { recursive: true, force: true });
      break;
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
