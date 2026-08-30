import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { dlopen, FFIType, ptr, type Library } from "bun:ffi";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, read, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Wait for a child to exit and preserve whether it returned or died from a signal. */
function waitForChildExit(child: ChildProcess, timeoutMs = 2_000): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`Timed out waiting for process ${child.pid} to exit.`));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

/** Kill a child left behind by a failed assertion and wait for the process to be terminated. */
async function stopChild(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await waitForChildExit(child).catch(() => undefined);
}

/** Wait for a shell supervisor to record the reviewed process's exit code. */
async function waitForExitCode(path: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return Number.parseInt(readFileSync(path, "utf8"), 10);
    }
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for an exit code in ${path}.`);
}

async function stopDaemonsUnder(runtimeDir: string) {
  const daemonDir = join(runtimeDir, "hunk-mcp");
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    if (existsSync(daemonDir)) {
      const metadataFiles = readdirSync(daemonDir).filter(
        (entry) => entry.startsWith("daemon-") && entry.endsWith(".json"),
      );
      if (metadataFiles.length > 0) {
        for (const entry of metadataFiles) {
          try {
            const { pid } = JSON.parse(readFileSync(join(daemonDir, entry), "utf8")) as {
              pid?: number;
            };
            if (pid && pid > 0) {
              process.kill(pid, "SIGTERM");
            }
          } catch {
            // Partially written metadata, or a daemon that already exited.
          }
        }
        return;
      }
    }
    await Bun.sleep(25);
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

/** Read child output until the app paints, then leave the stream flowing for teardown. */
function waitForStreamOutput(stream: NodeJS.ReadableStream, pattern: RegExp, timeoutMs = 20_000) {
  return new Promise<void>((resolve, reject) => {
    let text = "";
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
    };
    const onData = (chunk: Buffer | string) => {
      text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (pattern.test(text)) {
        cleanup();
        stream.resume();
        resolve();
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`Child output ended before ${pattern}. Saw:\n${text}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}. Saw:\n${text}`));
    }, timeoutMs);

    stream.on("data", onData);
    stream.on("end", onEnd);
  });
}

describe("PTY lifecycle", () => {
  for (const signal of ["SIGHUP", "SIGQUIT", "SIGPIPE"] as const) {
    test.skipIf(process.platform === "win32")(`exits cleanly on ${signal}`, async () => {
      const fixture = harness.createLongWrapFilePair();
      const runtimeDir = harness.createIsolatedConfigHome();
      const hunkCommand = harness.buildHunkCommand([
        "diff",
        "--files",
        fixture.before,
        fixture.after,
      ]);
      const child = spawn("/bin/sh", ["-c", `exec ${hunkCommand}`], {
        cwd: fixture.dir,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          TERM: "xterm-256color",
          XDG_CONFIG_HOME: harness.createIsolatedConfigHome(),
          XDG_RUNTIME_DIR: runtimeDir,
          // Brokering exposes an issue: disabled, passes on unfixed code.
          HUNK_MCP_DISABLE: "0",
          HUNK_DISABLE_UPDATE_NOTICE: "1",
        },
      });
      child.stderr?.resume();

      try {
        await waitForStreamOutput(child.stdout!, /this is a very long wrapped line/);
        process.kill(child.pid!, signal);

        await expect(waitForChildExit(child)).resolves.toEqual({ code: 0, signal: null });
      } finally {
        await stopChild(child);
        await stopDaemonsUnder(runtimeDir);
      }
    });
  }

  // Windows has no PTY slave to strand, and the disconnect signal there is not a stream event.
  test.skipIf(process.platform === "win32")(
    "exits when the host closes the PTY master",
    async () => {
      const fixture = harness.createLongWrapFilePair();
      const { master, slave } = openPtyPair();
      const hunkCommand = harness.buildHunkCommand([
        "diff",
        "--files",
        fixture.before,
        fixture.after,
      ]);
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
      expect(child.pid).toBeGreaterThan(0);

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
        await expect(waitForChildExit(child, 3_000)).resolves.toEqual({
          code: 0,
          signal: null,
        });
      } finally {
        closeMaster();
        await stopChild(child);
      }
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "exits when macOS revokes the controlling terminal",
    async () => {
      const fixture = harness.createLongWrapFilePair();
      const pidFile = join(fixture.dir, "hunk.pid");
      const exitFile = join(fixture.dir, "hunk.exit");
      const ttyFile = join(fixture.dir, "hunk.tty");
      const hunkCommand = harness.buildHunkCommand([
        "diff",
        "--files",
        fixture.before,
        fixture.after,
      ]);
      const session = await harness.launchShellCommand({
        command: `trap '' HUP; tty_path="$(tty)"; printf '%s' "$tty_path" > ${harness.shellQuote(ttyFile)}; ${hunkCommand} < "$tty_path" & hunk_pid=$!; printf '%s' "$hunk_pid" > ${harness.shellQuote(pidFile)}; wait "$hunk_pid"; printf '%s' "$?" > ${harness.shellQuote(exitFile)}`,
        cwd: fixture.dir,
      });

      try {
        await session.waitForText(/this is a very long wrapped line/, { timeout: 15_000 });
        const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        const ttyPath = readFileSync(ttyFile, "utf8").trim();
        expect(pid).toBeGreaterThan(0);
        expect(ttyPath).toStartWith("/dev/tty");

        expect(revokeTerminal(ttyPath)).toBe(0);
        expect(await waitForExitCode(exitFile)).toBe(0);
      } finally {
        session.close();
      }
    },
  );
});
