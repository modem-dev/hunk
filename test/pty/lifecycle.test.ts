import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { dlopen, FFIType, ptr, type Library } from "bun:ffi";
import { spawn } from "node:child_process";
import { closeSync, existsSync, read, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for process ${pid} to exit.`);
}

function stopDaemonsUnder(runtimeDir: string) {
  const daemonDir = join(runtimeDir, "hunk-mcp");
  if (!existsSync(daemonDir)) {
    return;
  }

  for (const entry of readdirSync(daemonDir)) {
    if (!entry.startsWith("daemon-") || !entry.endsWith(".json")) {
      continue;
    }

    try {
      const { pid } = JSON.parse(readFileSync(join(daemonDir, entry), "utf8")) as { pid?: number };
      if (pid && pid > 0) {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // Partially written metadata, or a daemon that already exited.
    }
  }
}

function revokeTerminal(path: string) {
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    revoke: {
      args: [FFIType.cstring],
      returns: FFIType.i32,
    },
  });
  try {
    return libc.symbols.revoke(ptr(Buffer.from(`${path}\0`)));
  } finally {
    libc.close();
  }
}

const OPENPTY_LIBRARIES =
  process.platform === "darwin"
    ? ["/usr/lib/libSystem.B.dylib"]
    : ["libutil.so.1", "libc.so.6", "libc.so"];

const OPENPTY_SYMBOLS = {
  openpty: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
} as const;

/**
 * Allocate a PTY pair so test can drop the master while child keeps slave
 */
function openPtyPair({ rows = 24, columns = 140 } = {}) {
  let libc: Library<typeof OPENPTY_SYMBOLS> | undefined;
  for (const candidate of OPENPTY_LIBRARIES) {
    try {
      libc = dlopen(candidate, OPENPTY_SYMBOLS);
      break;
    } catch {
      // Try the next platform candidate.
    }
  }
  if (!libc) {
    throw new Error(`No libc with openpty found (tried ${OPENPTY_LIBRARIES.join(", ")}).`);
  }

  try {
    const fds = new Int32Array(2);
    const winsize = new Uint16Array([rows, columns, 0, 0]);
    const result = libc.symbols.openpty(
      ptr(fds),
      ptr(fds, Int32Array.BYTES_PER_ELEMENT),
      null,
      null,
      ptr(winsize),
    );
    if (result !== 0) {
      throw new Error(`openpty failed with ${result}.`);
    }

    return { master: fds[0]!, slave: fds[1]! };
  } finally {
    libc.close();
  }
}

/** Read the PTY master until the app has rendered so disconnect lands on live session. */
async function waitForPtyOutput(fd: number, pattern: RegExp, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const buffer = Buffer.alloc(64 * 1024);
  let text = "";

  while (Date.now() < deadline) {
    const bytes = await new Promise<number>((resolve, reject) => {
      read(fd, buffer, 0, buffer.length, null, (error, bytesRead) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(bytesRead);
      });
    });
    if (bytes === 0) {
      break;
    }

    text += buffer.subarray(0, bytes).toString("utf8");
    if (pattern.test(text)) {
      return text;
    }
  }

  throw new Error(`Timed out waiting for ${pattern} on the PTY. Saw:\n${text}`);
}

describe("PTY lifecycle", () => {
  // Windows delivers no SIGHUP so terminal loss there is not a signal at all.
  test.skipIf(process.platform === "win32")("exits when the terminal sends SIGHUP", async () => {
    const fixture = harness.createLongWrapFilePair();
    const pidFile = join(fixture.dir, "hunk.pid");
    const runtimeDir = harness.createIsolatedConfigHome();
    const hunkCommand = harness.buildHunkCommand(["diff", fixture.before, fixture.after]);
    const session = await harness.launchShellCommand({
      command: `printf '%s' "$$" > ${harness.shellQuote(pidFile)}; exec ${hunkCommand}`,
      cwd: fixture.dir,
      env: {
        // OpenTUI's own SIGHUP listener only destroys the renderer so whether the process exits
        // depends on something to hold the loop open. In a default run it is session brokering
        // and disabling it here would hide the bug (unlike other tests).
        HUNK_MCP_DISABLE: "0",
        XDG_RUNTIME_DIR: runtimeDir,
      },
    });

    try {
      await session.waitForText(/this is a very long wrapped line/, { timeout: 15_000 });
      const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      expect(pid).toBeGreaterThan(0);

      process.kill(pid, "SIGHUP");
      await waitForProcessExit(pid);
    } finally {
      session.close();
      stopDaemonsUnder(runtimeDir);
    }
  });

  // Windows has no PTY slave to strand, and the disconnect signal there is not a stream event.
  test.skipIf(process.platform === "win32")(
    "exits when the host closes the PTY master",
    async () => {
      const fixture = harness.createLongWrapFilePair();
      const { master, slave } = openPtyPair();
      const hunkCommand = harness.buildHunkCommand(["diff", fixture.before, fixture.after]);
      // `exec` to keep the pid pointing at Hunk
      const child = spawn("/bin/sh", ["-c", `exec ${hunkCommand}`], {
        cwd: fixture.dir,
        stdio: [slave, slave, slave],
        env: {
          ...process.env,
          TERM: "xterm-256color",
          XDG_CONFIG_HOME: harness.createIsolatedConfigHome(),
          HUNK_MCP_DISABLE: "1",
          HUNK_DISABLE_UPDATE_NOTICE: "1",
        },
      });

      closeSync(slave);
      const pid = child.pid;
      expect(pid).toBeGreaterThan(0);

      let masterClosed = false;
      const closeMaster = () => {
        if (!masterClosed) {
          masterClosed = true;
          closeSync(master);
        }
      };

      try {
        await waitForPtyOutput(master, /this is a very long wrapped line/);

        // Some hosts drop the master between commands without killing the child.
        closeMaster();
        await waitForProcessExit(pid!, 3_000);
      } finally {
        closeMaster();
        if (processExists(pid!)) {
          child.kill("SIGKILL");
        }
      }
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "exits when macOS revokes the controlling terminal",
    async () => {
      const fixture = harness.createLongWrapFilePair();
      const pidFile = join(fixture.dir, "hunk.pid");
      const ttyFile = join(fixture.dir, "hunk.tty");
      const hunkCommand = harness.buildHunkCommand(["diff", fixture.before, fixture.after]);
      const session = await harness.launchShellCommand({
        command: `trap '' HUP; printf '%s' "$$" > ${harness.shellQuote(pidFile)}; tty > ${harness.shellQuote(ttyFile)}; exec ${hunkCommand}`,
        cwd: fixture.dir,
      });

      try {
        await session.waitForText(/this is a very long wrapped line/, { timeout: 15_000 });
        const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        const ttyPath = readFileSync(ttyFile, "utf8").trim();
        expect(pid).toBeGreaterThan(0);
        expect(ttyPath).toStartWith("/dev/tty");

        expect(revokeTerminal(ttyPath)).toBe(0);
        await waitForProcessExit(pid);
      } finally {
        session.close();
      }
    },
  );
});
