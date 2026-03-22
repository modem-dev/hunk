import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const sourceEntrypoint = join(repoRoot, "src/main.tsx");
const tempDirs: string[] = [];
const ttyToolsAvailable =
  Bun.spawnSync(["bash", "-lc", "command -v script >/dev/null && command -v timeout >/dev/null"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;

interface HealthResponse {
  ok: boolean;
  pid: number;
  sessions: number;
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

function spawnHunkSession(
  fixture: FixtureFiles,
  {
    port,
    quitAfterSeconds = 6,
    timeoutSeconds = 8,
  }: {
    port: number;
    quitAfterSeconds?: number;
    timeoutSeconds?: number;
  },
) {
  const innerCommand = `bun run ${shellQuote(sourceEntrypoint)} diff ${shellQuote(fixture.before)} ${shellQuote(fixture.after)}`;
  const hunkCommand = [
    `(sleep ${quitAfterSeconds}; printf q) | timeout ${timeoutSeconds} script -q -f -e -c`,
    shellQuote(innerCommand),
    shellQuote(fixture.transcript),
  ].join(" ");

  return Bun.spawn(["bash", "-lc", hunkCommand], {
    cwd: fixture.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLUMNS: "120",
      LINES: "24",
      HUNK_MCP_PORT: String(port),
    },
  });
}

function runSessionCli(args: string[], port: number) {
  const proc = Bun.spawnSync(["bun", "run", "src/main.tsx", "session", ...args], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
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

async function waitForHealth(port: number) {
  return waitUntil("session daemon health endpoint", async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (!response.ok) {
        return null;
      }

      return (await response.json()) as HealthResponse;
    } catch {
      return null;
    }
  });
}

afterEach(() => {
  cleanupTempDirs();
});

describe("live session end-to-end", () => {
  test("a live Hunk session auto-starts the daemon and renders CLI comments inline", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const fixture = createFixtureFiles(
      "single",
      ["export const alpha = 1;", "export const keep = true;"],
      ["export const alpha = 2;", "export const keep = true;", "export const gamma = true;"],
    );
    const port = 48000 + Math.floor(Math.random() * 1000);
    const hunkProc = spawnHunkSession(fixture, { port });

    let daemonPid: number | null = null;

    try {
      const health = await waitForHealth(port);
      daemonPid = health.pid;
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

      const hunkExitCode = await hunkProc.exited;
      expect([0, 124]).toContain(hunkExitCode);

      const transcript = stripTerminalControl(await Bun.file(fixture.transcript).text());
      expect(transcript).toContain("CLI autostart note");
      expect(transcript).toContain("Injected after the Hunk");
    } finally {
      hunkProc.kill();
      await hunkProc.exited.catch(() => undefined);

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
    const port = 48500 + Math.floor(Math.random() * 1000);
    const hunkProc = spawnHunkSession(fixture, { port, quitAfterSeconds: 14, timeoutSeconds: 16 });

    let daemonPid: number | null = null;

    try {
      const health = await waitForHealth(port);
      daemonPid = health.pid;
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

      const hunkExitCode = await hunkProc.exited;
      expect([0, 124]).toContain(hunkExitCode);
    } finally {
      hunkProc.kill();
      await hunkProc.exited.catch(() => undefined);

      if (daemonPid) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          // Ignore daemons that already exited during cleanup.
        }
      }
    }
  }, 20_000);

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
    const port = 49000 + Math.floor(Math.random() * 1000);
    const hunkProcA = spawnHunkSession(fixtureA, {
      port,
      quitAfterSeconds: 10,
      timeoutSeconds: 12,
    });
    const hunkProcB = spawnHunkSession(fixtureB, {
      port,
      quitAfterSeconds: 10,
      timeoutSeconds: 12,
    });

    let daemonPid: number | null = null;

    try {
      const health = await waitForHealth(port);
      daemonPid = health.pid;
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
        ],
        port,
      );
      expect(commentB.proc.exitCode).toBe(0);

      const [exitCodeA, exitCodeB] = await Promise.all([hunkProcA.exited, hunkProcB.exited]);
      expect([0, 124]).toContain(exitCodeA);
      expect([0, 124]).toContain(exitCodeB);

      const transcriptA = stripTerminalControl(await Bun.file(fixtureA.transcript).text());
      const transcriptB = stripTerminalControl(await Bun.file(fixtureB.transcript).text());

      expect(transcriptA).toContain("Alpha note");
      expect(transcriptA).toContain("Delivered only to the alpha");
      expect(transcriptA).not.toContain("Beta note");

      expect(transcriptB).toContain("Beta note");
      expect(transcriptB).toContain("Delivered only to the beta");
      expect(transcriptB).not.toContain("Alpha note");
    } finally {
      hunkProcA.kill();
      hunkProcB.kill();
      await Promise.allSettled([hunkProcA.exited, hunkProcB.exited]);

      if (daemonPid) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          // Ignore daemons that already exited during cleanup.
        }
      }
    }
  }, 20_000);

  test("a normal Hunk session still renders and exits cleanly when a non-Hunk listener owns the MCP port", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const fixture = createFixtureFiles(
      "conflict",
      ["export const alpha = 1;", "export const keep = true;"],
      ["export const alpha = 2;", "export const keep = true;", "export const gamma = true;"],
    );

    const port = 50000 + Math.floor(Math.random() * 1000);
    const conflictingListener = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not hunk");
    });
    await new Promise<void>((resolve, reject) => {
      conflictingListener.once("error", reject);
      conflictingListener.listen(port, "127.0.0.1", () => resolve());
    });

    const hunkProc = spawnHunkSession(fixture, {
      port,
      quitAfterSeconds: 6,
      timeoutSeconds: 8,
    });

    try {
      const exitCode = await hunkProc.exited;
      expect([0, 124]).toContain(exitCode);

      const transcript = stripTerminalControl(await Bun.file(fixture.transcript).text());
      expect(transcript).toContain("View  Navigate  Theme  Agent  Help");
      expect(transcript).toContain(`${fixture.afterName}`);
      expect(transcript).toContain("export const gamma = true;");
    } finally {
      hunkProc.kill();
      await hunkProc.exited.catch(() => undefined);
      await new Promise<void>((resolve) => conflictingListener.close(() => resolve()));
    }
  }, 20_000);
});
