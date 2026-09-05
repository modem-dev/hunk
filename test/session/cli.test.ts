import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestConfigHomes, createTestConfigHome } from "../helpers/config-home";
import { removeTestDirectory } from "../helpers/filesystem";

const repoRoot = process.cwd();
const sourceEntrypoint = join(repoRoot, "packages/hunk/src/main.tsx");
// Spawned hunk processes must assert built-in defaults, not the developer's ambient user config.
const testConfigHome = createTestConfigHome();
const testRuntimeDir = mkdtempSync(join(tmpdir(), "hunk-session-cli-runtime-"));

afterAll(cleanupTestConfigHomes);
afterAll(() => removeTestDirectory(testRuntimeDir));
const tempDirs: string[] = [];
/** Check for the util-linux `script` interface these Unix-only terminal tests require. */
function supportsControllableScript() {
  try {
    return (
      Bun.spawnSync(["script", "-q", "-f", "-e", "-c", "exit 0", "/dev/null"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0
    );
  } catch {
    return false;
  }
}

const ttyToolsAvailable = supportsControllableScript();

/** Reserve a currently unused loopback port for one isolated daemon test. */
async function reserveLoopbackPort() {
  const listener = createServer(() => undefined);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });

  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

interface SessionListJson {
  sessions: Array<{
    sessionId: string;
    files: Array<{
      path: string;
    }>;
  }>;
}

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function waitUntil<T>(
  label: string,
  poll: () => T | null | Promise<T | null>,
  timeoutMs = 10_000,
  intervalMs = 100,
) {
  const deadline = Date.now() + timeoutMs;

  return new Promise<T>((resolve, reject) => {
    void (async () => {
      while (Date.now() < deadline) {
        const value = await poll();
        if (value !== null) {
          resolve(value);
          return;
        }

        await Bun.sleep(intervalMs);
      }

      reject(new Error(`Timed out waiting for ${label}.`));
    })().catch(reject);
  });
}

function createFixtureFiles(name: string, beforeLines: string[], afterLines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), `hunk-session-cli-${name}-`));
  tempDirs.push(dir);

  const beforeName = `${name}-before.ts`;
  const afterName = `${name}-after.ts`;
  const before = join(dir, beforeName);
  const after = join(dir, afterName);
  const transcript = join(dir, `${name}-transcript.txt`);

  writeFileSync(before, [...beforeLines, ""].join("\n"));
  writeFileSync(after, [...afterLines, ""].join("\n"));

  return { dir, before, after, transcript, afterName };
}

function spawnHunkSession(fixture: ReturnType<typeof createFixtureFiles>, port: number) {
  const innerCommand = `bun run ${shellQuote(sourceEntrypoint)} diff --files ${shellQuote(fixture.before)} ${shellQuote(fixture.after)}`;

  return Bun.spawn(["script", "-q", "-f", "-e", "-c", innerCommand, fixture.transcript], {
    cwd: fixture.dir,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: testConfigHome,
      XDG_RUNTIME_DIR: testRuntimeDir,
      TERM: "xterm-256color",
      COLUMNS: "120",
      LINES: "24",
      HUNK_MCP_PORT: `${port}`,
    },
  });
}

type HunkSessionProcess = ReturnType<typeof spawnHunkSession>;

/** Strip terminal controls so prompts can be matched in flushed transcripts. */
function stripTerminalControl(text: string) {
  return text
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

/** Ask a live test session to quit, discarding changed view preferences when prompted. */
async function requestHunkSessionQuit(
  proc: HunkSessionProcess,
  fixture: ReturnType<typeof createFixtureFiles>,
  timeoutMs = 2_000,
) {
  proc.stdin.write("q");
  await proc.stdin.flush();
  let quitAttempts = 1;
  let lastQuitAttemptAt = Date.now();

  const outcome = await waitUntil(
    "Hunk session exit or save-preferences prompt",
    async () => {
      if (proc.exitCode !== null) {
        return "exited" as const;
      }
      const file = Bun.file(fixture.transcript);
      if (await file.exists()) {
        const output = stripTerminalControl(await file.text());
        if (output.includes("Save view preferences?")) {
          return "prompt" as const;
        }
      }

      // A command-triggered repaint can consume input sent during its handoff. Retry only while the
      // app remains live and no prompt is visible, keeping teardown condition-driven and bounded.
      if (quitAttempts < 3 && Date.now() - lastQuitAttemptAt >= 100) {
        proc.stdin.write("q");
        await proc.stdin.flush();
        quitAttempts += 1;
        lastQuitAttemptAt = Date.now();
      }
      return null;
    },
    timeoutMs,
    25,
  );

  if (outcome === "prompt") {
    proc.stdin.write("q");
    await proc.stdin.flush();
  }

  const result = await Promise.race([
    proc.exited.then((exitCode) => ({ exitCode })),
    Bun.sleep(timeoutMs).then(() => null),
  ]);
  if (!result) {
    proc.kill();
    await proc.exited.catch(() => undefined);
    throw new Error(`Timed out waiting ${timeoutMs}ms for the Hunk session to quit.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`Hunk session exited with ${result.exitCode}.`);
  }
}

/** Guarantee process cleanup even when graceful terminal teardown fails. */
async function quitHunkSession(
  proc: HunkSessionProcess,
  fixture: ReturnType<typeof createFixtureFiles>,
) {
  try {
    await requestHunkSessionQuit(proc, fixture);
  } catch (error) {
    proc.kill();
    await proc.exited.catch(() => undefined);
    throw error;
  }
}

const ownedDaemonPids = new Map<number, number>();

/** Poll through the authenticated CLI because public health intentionally exposes no session facts. */
async function waitForRegisteredSessions(port: number) {
  return waitUntil("registered live session", () => {
    const { proc, stdout } = runSessionCli(["list", "--json"], port);
    if (proc.exitCode !== 0) return null;
    const sessions = (JSON.parse(stdout) as SessionListJson).sessions;
    if (sessions.length === 0) return null;
    try {
      const metadata = JSON.parse(
        readFileSync(join(testRuntimeDir, "hunk-mcp", `daemon-127-0-0-1-${port}.json`), "utf8"),
      ) as { pid?: unknown };
      if (typeof metadata.pid === "number" && metadata.pid > 0)
        ownedDaemonPids.set(port, metadata.pid);
    } catch {
      // Teardown can still rely on daemon idleness if metadata publication raced this read.
    }
    return sessions;
  });
}

/** Read one test daemon's health without leaking connection failures into teardown. */
async function readDaemonHealth(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) return null;
    return (await response.json()) as { ok: boolean };
  } catch {
    return null;
  }
}

/** Report whether an owned daemon PID still exists. */
function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Signal an owned daemon while tolerating a concurrent clean exit. */
function signalProcess(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Wait until an owned daemon process exits and releases its loopback port. */
async function waitForDaemonExit(port: number, pid: number, label: string) {
  await waitUntil(
    label,
    async () => {
      const health = await readDaemonHealth(port);
      return !isProcessRunning(pid) && health === null ? true : null;
    },
    1_500,
    25,
  );
}

/** Stop the detached daemon that an integration session auto-started. */
async function stopTestDaemon(port: number) {
  const pid = ownedDaemonPids.get(port);
  ownedDaemonPids.delete(port);
  if (pid === undefined) return;

  signalProcess(pid, "SIGTERM");
  try {
    await waitForDaemonExit(port, pid, "session daemon exit");
  } catch {
    signalProcess(pid, "SIGKILL");
    await waitForDaemonExit(port, pid, "killed session daemon exit");
  }
}

/** Quit a test session and always stop the detached daemon it owns. */
async function cleanupHunkSession(
  proc: HunkSessionProcess,
  fixture: ReturnType<typeof createFixtureFiles>,
  port: number,
) {
  try {
    await quitHunkSession(proc, fixture);
  } finally {
    await stopTestDaemon(port);
  }
}

function runSessionCli(args: string[], port: number, stdinText?: string) {
  const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", "session", ...args], {
    cwd: repoRoot,
    stdin: stdinText === undefined ? "ignore" : Buffer.from(stdinText),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: testConfigHome,
      XDG_RUNTIME_DIR: testRuntimeDir,
      HUNK_MCP_PORT: `${port}`,
    },
  });

  const stdout = Buffer.from(proc.stdout).toString("utf8");
  const stderr = Buffer.from(proc.stderr).toString("utf8");
  return { proc, stdout, stderr };
}

afterEach(() => {
  cleanupTempDirs();
});

const sessionDescribe = ttyToolsAvailable ? describe : describe.skip;

sessionDescribe("session CLI integration", () => {
  test("list/get/context expose live Hunk sessions through the daemon", async () => {
    const port = await reserveLoopbackPort();
    const fixture = createFixtureFiles(
      "inspect",
      ["export const value = 1;", "console.log(value);"],
      ["export const value = 2;", "console.log(value * 2);"],
    );
    const session = spawnHunkSession(fixture, port);

    try {
      const listed = await waitForRegisteredSessions(port);

      const sessionId = listed[0]!.sessionId;
      const get = runSessionCli(["get", sessionId, "--json"], port);
      expect(get.proc.exitCode).toBe(0);
      expect(get.stderr).toBe("");
      expect(JSON.parse(get.stdout)).toMatchObject({
        session: {
          sessionId,
          files: [
            {
              path: fixture.afterName,
            },
          ],
        },
      });

      const context = runSessionCli(["context", sessionId, "--json"], port);
      expect(context.proc.exitCode).toBe(0);
      expect(context.stderr).toBe("");
      expect(JSON.parse(context.stdout)).toMatchObject({
        context: {
          sessionId,
          selectedFile: {
            path: fixture.afterName,
          },
          selectedHunk: {
            index: 0,
          },
        },
      });
    } finally {
      await cleanupHunkSession(session, fixture, port);
    }
  });

  test("reload replaces what a live session is showing", async () => {
    const port = await reserveLoopbackPort();
    const fixture = createFixtureFiles(
      "reload-alpha",
      ["export const alpha = 1;"],
      ["export const alpha = 2;", "export const beta = true;"],
    );
    mkdirSync(join(fixture.dir, ".git"));
    const session = spawnHunkSession(fixture, port);

    try {
      const listed = await waitForRegisteredSessions(port);

      const sessionId = listed[0]!.sessionId;
      writeFileSync(fixture.before, "export const before = 10;\n");
      writeFileSync(fixture.after, "export const after = 20;\nexport const extra = 'yes';\n");

      const reload = runSessionCli(
        ["reload", sessionId, "--json", "--", "diff", "--files", fixture.before, fixture.after],
        port,
      );
      expect(reload.proc.exitCode).toBe(0);
      expect(reload.stderr).toBe("");
      expect(JSON.parse(reload.stdout)).toMatchObject({
        result: {
          sessionId,
          inputKind: "diff",
          fileCount: 1,
          selectedFilePath: fixture.afterName,
          selectedHunkIndex: 0,
        },
      });

      const reloaded = await waitUntil("reloaded session metadata", () => {
        const get = runSessionCli(["get", sessionId, "--json"], port);
        if (get.proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(get.stdout) as {
          session?: {
            inputKind?: string;
            files?: Array<{ path: string }>;
          };
        };
        return parsed.session?.files?.[0]?.path === fixture.afterName ? parsed : null;
      });

      expect(reloaded).toMatchObject({
        session: {
          inputKind: "diff",
          files: [{ path: fixture.afterName }],
        },
      });
    } finally {
      await cleanupHunkSession(session, fixture, port);
    }
  }, 20_000);

  test("reload refuses to read files outside the live session root", async () => {
    const port = await reserveLoopbackPort();
    const fixture = createFixtureFiles(
      "reload-denied",
      ["export const visible = 1;"],
      ["export const visible = 2;"],
    );
    const outside = createFixtureFiles(
      "reload-secret",
      ["export const secret = 1;"],
      ["export const secret = 2;"],
    );
    mkdirSync(join(fixture.dir, ".git"));
    const session = spawnHunkSession(fixture, port);

    try {
      const listed = await waitForRegisteredSessions(port);

      const sessionId = listed[0]!.sessionId;
      const reload = runSessionCli(
        [
          "reload",
          sessionId,
          "--json",
          "--source",
          outside.dir,
          "--",
          "diff",
          "--files",
          outside.before,
          outside.after,
        ],
        port,
      );
      expect(reload.proc.exitCode).not.toBe(0);
      expect(reload.stderr).toContain("outside the initial Hunk root");

      const get = runSessionCli(["get", sessionId, "--json"], port);
      expect(get.proc.exitCode).toBe(0);
      expect(JSON.parse(get.stdout)).toMatchObject({
        session: {
          files: [{ path: fixture.afterName }],
        },
      });
    } finally {
      await cleanupHunkSession(session, fixture, port);
    }
  }, 20_000);

  test("raw session API callers cannot present option-like VCS ranges", async () => {
    const port = await reserveLoopbackPort();
    const fixture = createFixtureFiles(
      "reload-injection",
      ["export const visible = 1;"],
      ["export const visible = 2;"],
    );
    mkdirSync(join(fixture.dir, ".git"));
    const session = spawnHunkSession(fixture, port);

    try {
      const listed = await waitForRegisteredSessions(port);

      const sessionId = listed[0]!.sessionId;
      // Raw callers never reach app parsing without the owner-private signed caller session.
      const sentinel = join(fixture.dir, "hunk-poc");
      const response = await fetch(`http://127.0.0.1:${port}/session-api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "reload",
          selector: { sessionId },
          nextInput: {
            kind: "vcs",
            range: `--output=${sentinel}`,
            staged: false,
            options: {},
          },
        }),
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: "authentication-required",
        message: expect.stringContaining("upgraded"),
      });
      expect(existsSync(sentinel)).toBe(false);

      const get = runSessionCli(["get", sessionId, "--json"], port);
      expect(get.proc.exitCode).toBe(0);
      expect(JSON.parse(get.stdout)).toMatchObject({
        session: {
          files: [{ path: fixture.afterName }],
        },
      });
    } finally {
      await cleanupHunkSession(session, fixture, port);
    }
  }, 20_000);

  test("navigate works, and comment add only focuses the session when --focus is passed", async () => {
    const port = await reserveLoopbackPort();
    const fixture = createFixtureFiles(
      "mutate",
      [
        "export const one = 1;",
        "export const two = 2;",
        "export const three = 3;",
        "export const four = 4;",
        "export const five = 5;",
        "export const six = 6;",
        "export const seven = 7;",
        "export const eight = 8;",
        "export const nine = 9;",
        "export const ten = 10;",
        "export const eleven = 11;",
        "export const twelve = 12;",
        "export const thirteen = 13;",
      ],
      [
        "export const one = 1;",
        "export const two = 20;",
        "export const three = 3;",
        "export const four = 4;",
        "export const five = 5;",
        "export const six = 6;",
        "export const seven = 7;",
        "export const eight = 8;",
        "export const nine = 9;",
        "export const ten = 10;",
        "export const eleven = 11;",
        "export const twelve = 12;",
        "export const thirteen = 130;",
      ],
    );
    const session = spawnHunkSession(fixture, port);

    try {
      const listed = await waitForRegisteredSessions(port);

      const sessionId = listed[0]!.sessionId;

      const navigate = runSessionCli(
        ["navigate", sessionId, "--file", fixture.afterName, "--hunk", "2", "--json"],
        port,
      );
      expect(navigate.proc.exitCode).toBe(0);
      expect(navigate.stderr).toBe("");
      expect(JSON.parse(navigate.stdout)).toMatchObject({
        result: {
          filePath: fixture.afterName,
          hunkIndex: 1,
        },
      });

      await waitUntil("updated session context", () => {
        const context = runSessionCli(["context", sessionId, "--json"], port);
        if (context.proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(context.stdout) as {
          context?: { selectedHunk?: { index: number } };
        };
        return parsed.context?.selectedHunk?.index === 1 ? parsed : null;
      });

      const resetSelection = runSessionCli(
        ["navigate", sessionId, "--file", fixture.afterName, "--hunk", "1", "--json"],
        port,
      );
      expect(resetSelection.proc.exitCode).toBe(0);
      expect(resetSelection.stderr).toBe("");

      await waitUntil("reset session context", () => {
        const context = runSessionCli(["context", sessionId, "--json"], port);
        if (context.proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(context.stdout) as {
          context?: { selectedHunk?: { index: number }; showAgentNotes?: boolean };
        };
        return parsed.context?.selectedHunk?.index === 0 && parsed.context?.showAgentNotes === false
          ? parsed
          : null;
      });

      const comment = runSessionCli(
        [
          "comment",
          "add",
          sessionId,
          "--file",
          fixture.afterName,
          "--new-line",
          "10",
          "--summary",
          "Second hunk note",
          "--rationale",
          "Added through the session CLI.",
          "--author",
          "Pi",
          "--json",
        ],
        port,
      );
      expect(comment.proc.exitCode).toBe(0);
      expect(comment.stderr).toBe("");
      const addedComment = JSON.parse(comment.stdout) as {
        result?: {
          commentId?: string;
          filePath?: string;
          hunkIndex?: number;
          side?: string;
          line?: number;
        };
      };
      expect(addedComment).toMatchObject({
        result: {
          filePath: fixture.afterName,
          hunkIndex: 1,
          side: "new",
          line: 10,
        },
      });
      expect(typeof addedComment.result?.commentId).toBe("string");

      await waitUntil("comment registered without focus", () => {
        const listedComments = runSessionCli(["comment", "list", sessionId, "--json"], port);
        if (listedComments.proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(listedComments.stdout) as {
          comments?: Array<{ summary?: string }>;
        };
        return parsed.comments?.some((comment) => comment.summary === "Second hunk note")
          ? parsed
          : null;
      });

      const unchangedContext = runSessionCli(["context", sessionId, "--json"], port);
      expect(unchangedContext.proc.exitCode).toBe(0);
      expect(JSON.parse(unchangedContext.stdout)).toMatchObject({
        context: {
          selectedHunk: {
            index: 0,
          },
          showAgentNotes: false,
        },
      });

      const commentId = addedComment.result?.commentId;
      expect(commentId).toBeDefined();
      const navigateToComment = runSessionCli(
        ["navigate", sessionId, "--comment", commentId!, "--json"],
        port,
      );
      expect(navigateToComment.proc.exitCode).toBe(0);
      expect(navigateToComment.stderr).toBe("");
      expect(JSON.parse(navigateToComment.stdout)).toMatchObject({
        result: {
          filePath: fixture.afterName,
          hunkIndex: 1,
          side: "new",
          line: 10,
        },
      });

      await waitUntil("comment navigation context", () => {
        const context = runSessionCli(["context", sessionId, "--json"], port);
        if (context.proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(context.stdout) as {
          context?: { selectedHunk?: { index: number } };
        };
        return parsed.context?.selectedHunk?.index === 1 ? parsed : null;
      });

      const resetAfterCommentNavigation = runSessionCli(
        ["navigate", sessionId, "--file", fixture.afterName, "--hunk", "1", "--json"],
        port,
      );
      expect(resetAfterCommentNavigation.proc.exitCode).toBe(0);
      expect(resetAfterCommentNavigation.stderr).toBe("");

      await waitUntil("reset after comment navigation", () => {
        const context = runSessionCli(["context", sessionId, "--json"], port);
        if (context.proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(context.stdout) as {
          context?: { selectedHunk?: { index: number }; showAgentNotes?: boolean };
        };
        return parsed.context?.selectedHunk?.index === 0 && parsed.context?.showAgentNotes === false
          ? parsed
          : null;
      });

      const focusedComment = runSessionCli(
        [
          "comment",
          "add",
          sessionId,
          "--file",
          fixture.afterName,
          "--new-line",
          "10",
          "--summary",
          "Second hunk focused note",
          "--focus",
          "--json",
        ],
        port,
      );
      expect(focusedComment.proc.exitCode).toBe(0);
      expect(focusedComment.stderr).toBe("");
      expect(JSON.parse(focusedComment.stdout)).toMatchObject({
        result: {
          filePath: fixture.afterName,
          hunkIndex: 1,
          side: "new",
          line: 10,
        },
      });

      await waitUntil("focused session context", () => {
        const context = runSessionCli(["context", sessionId, "--json"], port);
        if (context.proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(context.stdout) as {
          context?: { selectedHunk?: { index: number }; showAgentNotes?: boolean };
        };
        return parsed.context?.selectedHunk?.index === 1 && parsed.context?.showAgentNotes === true
          ? parsed
          : null;
      });
    } finally {
      await cleanupHunkSession(session, fixture, port);
    }
  }, 20_000);

  test("comment apply adds a batch from stdin without moving focus by default", async () => {
    const port = await reserveLoopbackPort();
    const fixture = createFixtureFiles(
      "apply-batch",
      [
        "export const one = 1;",
        "export const two = 2;",
        "export const three = 3;",
        "export const four = 4;",
        "export const five = 5;",
        "export const six = 6;",
        "export const seven = 7;",
        "export const eight = 8;",
        "export const nine = 9;",
        "export const ten = 10;",
        "export const eleven = 11;",
        "export const twelve = 12;",
        "export const thirteen = 13;",
      ],
      [
        "export const one = 1;",
        "export const two = 20;",
        "export const three = 3;",
        "export const four = 4;",
        "export const five = 5;",
        "export const six = 6;",
        "export const seven = 7;",
        "export const eight = 8;",
        "export const nine = 9;",
        "export const ten = 10;",
        "export const eleven = 11;",
        "export const twelve = 12;",
        "export const thirteen = 130;",
      ],
    );
    const session = spawnHunkSession(fixture, port);

    try {
      const listed = await waitForRegisteredSessions(port);

      const sessionId = listed[0]!.sessionId;
      const apply = runSessionCli(
        ["comment", "apply", sessionId, "--stdin", "--json"],
        port,
        JSON.stringify({
          comments: [
            {
              filePath: fixture.afterName,
              hunk: 1,
              summary: "First hunk note",
              author: "Pi",
            },
            {
              filePath: fixture.afterName,
              hunk: 2,
              summary: "Second hunk note",
              rationale: "Applied in one batch.",
              author: "Pi",
            },
          ],
        }),
      );

      expect(apply.proc.exitCode).toBe(0);
      expect(apply.stderr).toBe("");
      expect(JSON.parse(apply.stdout)).toMatchObject({
        result: {
          applied: [
            {
              filePath: fixture.afterName,
              hunkIndex: 0,
              side: "new",
              line: 2,
            },
            {
              filePath: fixture.afterName,
              hunkIndex: 1,
              side: "new",
              line: 13,
            },
          ],
        },
      });

      const context = runSessionCli(["context", sessionId, "--json"], port);
      expect(context.proc.exitCode).toBe(0);
      expect(JSON.parse(context.stdout)).toMatchObject({
        context: {
          selectedHunk: {
            index: 0,
          },
        },
      });

      const comments = runSessionCli(["comment", "list", sessionId, "--json"], port);
      expect(comments.proc.exitCode).toBe(0);
      expect(JSON.parse(comments.stdout)).toMatchObject({
        comments: [{ summary: "First hunk note" }, { summary: "Second hunk note" }],
      });
    } finally {
      await cleanupHunkSession(session, fixture, port);
    }
  }, 20_000);

  test("comment apply with --focus jumps to the first applied comment", async () => {
    const port = await reserveLoopbackPort();
    const fixture = createFixtureFiles(
      "apply-batch-focus",
      [
        "export const one = 1;",
        "export const two = 2;",
        "export const three = 3;",
        "export const four = 4;",
        "export const five = 5;",
        "export const six = 6;",
        "export const seven = 7;",
        "export const eight = 8;",
        "export const nine = 9;",
        "export const ten = 10;",
        "export const eleven = 11;",
        "export const twelve = 12;",
        "export const thirteen = 13;",
      ],
      [
        "export const one = 1;",
        "export const two = 20;",
        "export const three = 3;",
        "export const four = 4;",
        "export const five = 5;",
        "export const six = 6;",
        "export const seven = 7;",
        "export const eight = 8;",
        "export const nine = 9;",
        "export const ten = 10;",
        "export const eleven = 11;",
        "export const twelve = 12;",
        "export const thirteen = 130;",
      ],
    );
    const session = spawnHunkSession(fixture, port);

    try {
      const listed = await waitForRegisteredSessions(port);

      const sessionId = listed[0]!.sessionId;
      const apply = runSessionCli(
        ["comment", "apply", sessionId, "--stdin", "--focus", "--json"],
        port,
        JSON.stringify({
          comments: [
            {
              filePath: fixture.afterName,
              hunk: 2,
              summary: "Second hunk note",
            },
            {
              filePath: fixture.afterName,
              hunk: 1,
              summary: "First hunk note",
            },
          ],
        }),
      );

      expect(apply.proc.exitCode).toBe(0);
      expect(apply.stderr).toBe("");
      expect(JSON.parse(apply.stdout)).toMatchObject({
        result: {
          applied: [
            { filePath: fixture.afterName, hunkIndex: 1, side: "new", line: 13 },
            { filePath: fixture.afterName, hunkIndex: 0, side: "new", line: 2 },
          ],
        },
      });

      await waitUntil("focused first applied comment", () => {
        const context = runSessionCli(["context", sessionId, "--json"], port);
        if (context.proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(context.stdout) as {
          context?: { selectedHunk?: { index: number }; showAgentNotes?: boolean };
        };
        return parsed.context?.selectedHunk?.index === 1 && parsed.context?.showAgentNotes === true
          ? parsed
          : null;
      });
    } finally {
      await cleanupHunkSession(session, fixture, port);
    }
  }, 20_000);
});
