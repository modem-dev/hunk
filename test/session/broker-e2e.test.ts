import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestConfigHomes, createTestConfigHome } from "../helpers/config-home";

const repoRoot = process.cwd();
const sourceEntrypoint = join(repoRoot, "packages/hunk/src/main.tsx");
// Spawned hunk processes must assert built-in defaults, not the developer's ambient user config.
const testConfigHome = createTestConfigHome();

afterAll(cleanupTestConfigHomes);
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

interface HealthResponse {
  ok: boolean;
}

interface SessionListJson {
  sessions: Array<{
    sessionId: string;
    files: Array<{
      path: string;
    }>;
  }>;
}

interface FixtureFiles {
  dir: string;
  before: string;
  after: string;
  transcript: string;
  afterName: string;
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

function stripTerminalControl(text: string) {
  return text
    .replace(/^Script started.*?\n/s, "")
    .replace(/\nScript done.*$/s, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

function createFixtureFiles(
  name: string,
  beforeLines: string[],
  afterLines: string[],
): FixtureFiles {
  const dir = mkdtempSync(join(tmpdir(), `hunk-session-e2e-${name}-`));
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

async function reserveLoopbackPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });

  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));

  if (!port) {
    throw new Error("Failed to reserve a loopback port for the session daemon test.");
  }

  return port;
}

/** Start one real terminal session whose input the test can control directly. */
function spawnHunkSession(fixture: FixtureFiles, port: number) {
  const innerCommand = `bun run ${shellQuote(sourceEntrypoint)} diff --files ${shellQuote(fixture.before)} ${shellQuote(fixture.after)}`;

  return Bun.spawn(["script", "-q", "-f", "-e", "-c", innerCommand, fixture.transcript], {
    cwd: fixture.dir,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: testConfigHome,
      TERM: "xterm-256color",
      COLUMNS: "120",
      LINES: "24",
      HUNK_MCP_PORT: String(port),
    },
  });
}

type HunkSessionProcess = ReturnType<typeof spawnHunkSession>;

/** Ask the live app to quit, discarding a prompted view change when necessary. */
async function quitHunkSession(proc: HunkSessionProcess, fixture: FixtureFiles, timeoutMs = 2_000) {
  proc.stdin.write("q");
  await proc.stdin.flush();

  const outcome = await waitUntil(
    "Hunk session exit or save-preferences prompt",
    async () => {
      if (proc.exitCode !== null) {
        return "exited" as const;
      }

      const file = Bun.file(fixture.transcript);
      if (!(await file.exists())) {
        return null;
      }

      const transcript = stripTerminalControl(await file.text());
      return transcript.includes("Save view preferences?") ? ("prompt" as const) : null;
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

  return result.exitCode;
}

/** Force-stop a live test session without masking the original test failure. */
async function cleanupHunkSession(proc: HunkSessionProcess) {
  proc.kill();
  await proc.exited.catch(() => undefined);
}

function runSessionCli(args: string[], port: number) {
  const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", "session", ...args], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: testConfigHome,
      HUNK_MCP_PORT: `${port}`,
    },
  });

  const stdout = Buffer.from(proc.stdout).toString("utf8");
  const stderr = Buffer.from(proc.stderr).toString("utf8");
  return { proc, stdout, stderr };
}

async function waitUntil<T>(
  label: string,
  fn: () => Promise<T | null> | T | null,
  timeoutMs = 10_000,
  intervalMs = 150,
) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await fn();
    if (value !== null) {
      return value;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }

    await Bun.sleep(intervalMs);
  }
}

/** Read the PID only from this test's launch metadata for teardown, never from public health. */
function readLaunchedDaemonPid(port: number) {
  try {
    const runtimeBase = process.env.XDG_RUNTIME_DIR?.trim() || tmpdir();
    const metadata = JSON.parse(
      readFileSync(join(runtimeBase, "hunk-mcp", `daemon-127-0-0-1-${port}.json`), "utf8"),
    ) as { pid?: unknown };
    return typeof metadata.pid === "number" && metadata.pid > 0 ? metadata.pid : null;
  } catch {
    return null;
  }
}

async function waitForHealth(port: number, timeoutMs = 15_000) {
  return waitUntil(
    "session daemon health endpoint",
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (!response.ok) {
          return null;
        }

        return (await response.json()) as HealthResponse;
      } catch {
        return null;
      }
    },
    timeoutMs,
  );
}

/** Wait until the flushed terminal transcript shows an observable app state. */
async function waitForTranscript(
  fixture: FixtureFiles,
  label: string,
  predicate: (transcript: string) => boolean,
  timeoutMs = 10_000,
) {
  return waitUntil(
    label,
    async () => {
      const file = Bun.file(fixture.transcript);
      if (!(await file.exists())) {
        return null;
      }

      const transcript = stripTerminalControl(await file.text());
      return predicate(transcript) ? transcript : null;
    },
    timeoutMs,
    50,
  );
}

afterEach(() => {
  cleanupTempDirs();
});

describe("session broker end-to-end", () => {
  test("a live Hunk session auto-starts the daemon and renders CLI comments inline", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const fixture = createFixtureFiles(
      "single",
      ["export const alpha = 1;", "export const keep = true;"],
      ["export const alpha = 2;", "export const keep = true;", "export const gamma = true;"],
    );
    const port = await reserveLoopbackPort();
    const hunkProc = spawnHunkSession(fixture, port);

    let daemonPid: number | null = null;

    try {
      const health = await waitForHealth(port);
      daemonPid = readLaunchedDaemonPid(port);
      expect(health.ok).toBe(true);

      const listed = await waitUntil("registered Hunk session", async () => {
        const { proc, stdout } = runSessionCli(["list", "--json"], port);
        if (proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(stdout) as SessionListJson;
        return parsed.sessions.length > 0 ? parsed.sessions : null;
      });

      const targetSession =
        listed.find((session) => session.files.some((file) => file.path === fixture.afterName)) ??
        listed[0]!;
      const comment = runSessionCli(
        [
          "comment",
          "add",
          targetSession.sessionId,
          "--file",
          fixture.afterName,
          "--new-line",
          "2",
          "--summary",
          "CLI autostart note",
          "--rationale",
          "Injected after the Hunk session auto-started the local daemon.",
          "--author",
          "Pi",
          "--focus",
          "--json",
        ],
        port,
      );
      expect(comment.proc.exitCode).toBe(0);
      expect(comment.stderr).toBe("");
      expect(JSON.parse(comment.stdout)).toMatchObject({
        result: {
          filePath: fixture.afterName,
          line: 2,
        },
      });

      const transcript = await waitForTranscript(
        fixture,
        "rendered CLI comment",
        (current) =>
          current.includes("CLI autostart note") && current.includes("Injected after the Hunk"),
      );
      expect(transcript).toContain("CLI autostart note");
      expect(transcript).toContain("Injected after the Hunk");
      expect(await quitHunkSession(hunkProc, fixture)).toBe(0);
    } finally {
      await cleanupHunkSession(hunkProc);

      if (daemonPid) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          // Ignore daemons that already exited during cleanup.
        }
      }
    }
  }, 20_000);

  test("session CLI can inspect current focus and navigate hunks in a live session", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const fixture = createFixtureFiles(
      "navigate",
      [
        "export const line1 = 1;",
        "export const line2 = 2;",
        "export const line3 = 3;",
        "export const line4 = 4;",
        "export const line5 = 5;",
        "export const line6 = 6;",
        "export const line7 = 7;",
        "export const line8 = 8;",
        "export const line9 = 9;",
        "export const line10 = 10;",
      ],
      [
        "export const line1 = 101;",
        "export const line2 = 2;",
        "export const line3 = 3;",
        "export const line4 = 4;",
        "export const line5 = 5;",
        "export const line6 = 6;",
        "export const line7 = 7;",
        "export const line8 = 8;",
        "export const line9 = 9;",
        "export const line10 = 110;",
      ],
    );
    const port = await reserveLoopbackPort();
    const hunkProc = spawnHunkSession(fixture, port);

    let daemonPid: number | null = null;

    try {
      const health = await waitForHealth(port);
      daemonPid = readLaunchedDaemonPid(port);
      expect(health.ok).toBe(true);

      const listed = await waitUntil("registered Hunk session", async () => {
        const { proc, stdout } = runSessionCli(["list", "--json"], port);
        if (proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(stdout) as SessionListJson;
        return parsed.sessions.length > 0 ? parsed.sessions : null;
      });
      const targetSession =
        listed.find((session) => session.files.some((file) => file.path === fixture.afterName)) ??
        listed[0]!;

      const initialContext = runSessionCli(["context", targetSession.sessionId, "--json"], port);
      expect(initialContext.proc.exitCode).toBe(0);
      expect(JSON.parse(initialContext.stdout)).toMatchObject({
        context: {
          selectedFile: {
            path: fixture.afterName,
          },
          selectedHunk: {
            index: 0,
          },
        },
      });

      const navigate = runSessionCli(
        ["navigate", targetSession.sessionId, "--file", fixture.afterName, "--hunk", "2", "--json"],
        port,
      );
      expect(navigate.proc.exitCode).toBe(0);
      expect(JSON.parse(navigate.stdout)).toMatchObject({
        result: {
          filePath: fixture.afterName,
          hunkIndex: 1,
        },
      });

      await waitUntil("selected hunk update", () => {
        const context = runSessionCli(["context", targetSession.sessionId, "--json"], port);
        if (context.proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(context.stdout) as {
          context?: { selectedHunk?: { index: number } };
        };
        return parsed.context?.selectedHunk?.index === 1 ? parsed : null;
      });

      expect(await quitHunkSession(hunkProc, fixture)).toBe(0);
    } finally {
      await cleanupHunkSession(hunkProc);

      if (daemonPid) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          // Ignore daemons that already exited during cleanup.
        }
      }
    }
  }, 20_000);

  test("session CLI marks a character range and reveals its exact line in a live session", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    // One tall hunk: every line differs, so git emits a single hunk whose deep lines cannot
    // share a 24-row viewport with its anchor — the shape hunk navigation cannot land.
    const needleLine = 111;
    const needleToken = "ATTENTIONNEEDLE";
    const fixture = createFixtureFiles(
      "attention",
      Array.from(
        { length: 130 },
        (_, index) => `export const line${String(index + 1).padStart(3, "0")} = ${index + 1};`,
      ),
      Array.from({ length: 130 }, (_, index) =>
        index + 1 === needleLine
          ? `export const needle = "${needleToken}";`
          : `export const line${String(index + 1).padStart(3, "0")} = ${index + 1001};`,
      ),
    );
    const port = await reserveLoopbackPort();
    const hunkProc = spawnHunkSession(fixture, port);

    let daemonPid: number | null = null;

    try {
      const health = await waitForHealth(port);
      daemonPid = readLaunchedDaemonPid(port);
      expect(health.ok).toBe(true);

      const listed = await waitUntil("registered Hunk session", async () => {
        const { proc, stdout } = runSessionCli(["list", "--json"], port);
        if (proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(stdout) as SessionListJson;
        return parsed.sessions.length > 0 ? parsed.sessions : null;
      });
      const targetSession =
        listed.find((session) => session.files.some((file) => file.path === fixture.afterName)) ??
        listed[0]!;

      // The review opens at the hunk anchor, pages above the marked line.
      const initial = await waitForTranscript(fixture, "rendered review", (current) =>
        current.includes("line001"),
      );
      expect(initial).not.toContain(needleToken);

      // Mark "needle" on the deep line and focus it in one call.
      const highlight = runSessionCli(
        [
          "highlight",
          "add",
          targetSession.sessionId,
          "--file",
          fixture.afterName,
          "--new-line",
          String(needleLine),
          "--start",
          "13",
          "--end",
          "19",
          "--tone",
          "warning",
          "--focus",
          "--json",
        ],
        port,
      );
      expect(highlight.proc.exitCode).toBe(0);
      expect(highlight.stderr).toBe("");
      expect(JSON.parse(highlight.stdout)).toMatchObject({
        result: {
          filePath: fixture.afterName,
          side: "new",
          line: needleLine,
          start: 13,
          end: 19,
          tone: "warning",
          fileMarkCount: 1,
          revealed: "line",
        },
      });

      // The focus reveal scrolled the marked line into the live terminal.
      await waitForTranscript(fixture, "revealed marked line", (current) =>
        current.includes(needleToken),
      );

      // Line-target navigation reports the same line-exact landing.
      const navigate = runSessionCli(
        [
          "navigate",
          targetSession.sessionId,
          "--file",
          fixture.afterName,
          "--new-line",
          "25",
          "--json",
        ],
        port,
      );
      expect(navigate.proc.exitCode).toBe(0);
      expect(JSON.parse(navigate.stdout)).toMatchObject({
        result: {
          filePath: fixture.afterName,
          revealed: "line",
          side: "new",
          line: 25,
        },
      });

      const cleared = runSessionCli(
        ["highlight", "clear", targetSession.sessionId, "--json"],
        port,
      );
      expect(cleared.proc.exitCode).toBe(0);
      expect(JSON.parse(cleared.stdout)).toMatchObject({
        result: { removedCount: 1, remainingCount: 0 },
      });

      expect(await quitHunkSession(hunkProc, fixture)).toBe(0);
    } finally {
      await cleanupHunkSession(hunkProc);

      if (daemonPid) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          // Ignore daemons that already exited during cleanup.
        }
      }
    }
  }, 30_000);

  test("one daemon routes CLI comments to the correct Hunk session when multiple local sessions are open", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const fixtureA = createFixtureFiles(
      "alpha",
      ["export const alpha = 1;", "export const shared = true;"],
      ["export const alpha = 2;", "export const shared = true;", "export const onlyAlpha = true;"],
    );
    const fixtureB = createFixtureFiles(
      "beta",
      ["export const beta = 1;", "export const shared = true;"],
      ["export const beta = 2;", "export const shared = true;", "export const onlyBeta = true;"],
    );
    const port = await reserveLoopbackPort();
    const hunkProcA = spawnHunkSession(fixtureA, port);
    const hunkProcB = spawnHunkSession(fixtureB, port);

    let daemonPid: number | null = null;

    try {
      const health = await waitForHealth(port, 20_000);
      daemonPid = readLaunchedDaemonPid(port);
      expect(health.ok).toBe(true);

      const sessions = await waitUntil("two registered Hunk sessions", async () => {
        const listed = runSessionCli(["list", "--json"], port);
        if (listed.proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(listed.stdout) as SessionListJson;
        return parsed.sessions.length === 2 ? parsed.sessions : null;
      });

      const sessionA = sessions.find((session) =>
        session.files.some((file) => file.path === fixtureA.afterName),
      );
      const sessionB = sessions.find((session) =>
        session.files.some((file) => file.path === fixtureB.afterName),
      );
      expect(sessionA).toBeDefined();
      expect(sessionB).toBeDefined();

      const commentA = runSessionCli(
        [
          "comment",
          "add",
          sessionA!.sessionId,
          "--file",
          fixtureA.afterName,
          "--new-line",
          "2",
          "--summary",
          "Alpha note",
          "--rationale",
          "Delivered only to the alpha Hunk session.",
          "--focus",
        ],
        port,
      );
      expect(commentA.proc.exitCode).toBe(0);

      const commentB = runSessionCli(
        [
          "comment",
          "add",
          sessionB!.sessionId,
          "--file",
          fixtureB.afterName,
          "--new-line",
          "2",
          "--summary",
          "Beta note",
          "--rationale",
          "Delivered only to the beta Hunk session.",
          "--focus",
        ],
        port,
      );
      expect(commentB.proc.exitCode).toBe(0);

      await Promise.all([
        waitForTranscript(
          fixtureA,
          "alpha comment rendering",
          (current) =>
            current.includes("Alpha note") && current.includes("Delivered only to the alpha"),
        ),
        waitForTranscript(
          fixtureB,
          "beta comment rendering",
          (current) =>
            current.includes("Beta note") && current.includes("Delivered only to the beta"),
        ),
      ]);

      const [exitCodeA, exitCodeB] = await Promise.all([
        quitHunkSession(hunkProcA, fixtureA),
        quitHunkSession(hunkProcB, fixtureB),
      ]);
      expect(exitCodeA).toBe(0);
      expect(exitCodeB).toBe(0);

      // Read both finalized transcripts at one common barrier so a late cross-session render
      // cannot escape the negative routing assertions.
      const [transcriptA, transcriptB] = await Promise.all([
        Bun.file(fixtureA.transcript).text().then(stripTerminalControl),
        Bun.file(fixtureB.transcript).text().then(stripTerminalControl),
      ]);
      expect(transcriptA).toContain("Alpha note");
      expect(transcriptA).toContain("Delivered only to the alpha");
      expect(transcriptA).not.toContain("Beta note");

      expect(transcriptB).toContain("Beta note");
      expect(transcriptB).toContain("Delivered only to the beta");
      expect(transcriptB).not.toContain("Alpha note");
    } finally {
      await Promise.all([cleanupHunkSession(hunkProcA), cleanupHunkSession(hunkProcB)]);

      if (daemonPid) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          // Ignore daemons that already exited during cleanup.
        }
      }
    }
  }, 30_000);

  test("a normal Hunk session still renders and exits cleanly when a non-Hunk listener owns the MCP port", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const fixture = createFixtureFiles(
      "conflict",
      ["export const alpha = 1;", "export const keep = true;"],
      ["export const alpha = 2;", "export const keep = true;", "export const gamma = true;"],
    );

    let conflictingRequestCount = 0;
    const conflictingListener = createServer((_request, response) => {
      conflictingRequestCount += 1;
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not hunk");
    });
    await new Promise<void>((resolve, reject) => {
      conflictingListener.once("error", reject);
      conflictingListener.listen(0, "127.0.0.1", () => resolve());
    });

    const address = conflictingListener.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const hunkProc = spawnHunkSession(fixture, port);

    try {
      const transcript = await waitForTranscript(
        fixture,
        "rendered session after probing a conflicting broker listener",
        (current) =>
          conflictingRequestCount > 0 &&
          current.includes("View  Navigate  Agent  Help") &&
          current.includes(fixture.afterName) &&
          current.includes("export const gamma = true;"),
      );
      expect(conflictingRequestCount).toBeGreaterThan(0);
      expect(transcript).toContain("View  Navigate  Agent  Help");
      expect(transcript).toContain(`${fixture.afterName}`);
      expect(transcript).toContain("export const gamma = true;");
      expect(await quitHunkSession(hunkProc, fixture)).toBe(0);
    } finally {
      await cleanupHunkSession(hunkProc);
      await new Promise<void>((resolve) => conflictingListener.close(() => resolve()));
    }
  }, 20_000);
});
