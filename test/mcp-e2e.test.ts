import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const repoRoot = process.cwd();
const sourceEntrypoint = join(repoRoot, "src/main.tsx");
const tempDirs: string[] = [];
const ttyToolsAvailable = Bun.spawnSync(["bash", "-lc", "command -v script >/dev/null && command -v timeout >/dev/null"], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
}).exitCode === 0;

interface HealthResponse {
  ok: boolean;
  pid: number;
  sessions: number;
}

interface ListedSessionSummary {
  sessionId: string;
  title: string;
  files: Array<{
    path: string;
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

function createFixtureFiles(name: string, beforeLines: string[], afterLines: string[]): FixtureFiles {
  const dir = mkdtempSync(join(tmpdir(), `hunk-mcp-e2e-${name}-`));
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

async function waitUntil<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 10_000, intervalMs = 150) {
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
  return waitUntil("MCP daemon health endpoint", async () => {
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

async function listSessions(client: Client) {
  const result = await client.callTool({
    name: "list_sessions",
    arguments: {},
  });

  return ((result.structuredContent as { sessions?: ListedSessionSummary[] } | undefined)?.sessions ?? []);
}

afterEach(() => {
  cleanupTempDirs();
});

describe("MCP end-to-end", () => {
  test("a live Hunk session auto-starts the daemon and renders MCP comments inline", async () => {
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
    let transport: StreamableHTTPClientTransport | null = null;

    try {
      const health = await waitForHealth(port);
      daemonPid = health.pid;
      expect(health.ok).toBe(true);

      const client = new Client({ name: "mcp-e2e-test", version: "1.0.0" });
      transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      await client.connect(transport);

      const listed = await waitUntil("registered Hunk session", async () => {
        const sessions = await listSessions(client);
        return sessions.length > 0 ? sessions : null;
      });

      const targetSession = listed.find((session) => session.files.some((file) => file.path === fixture.afterName)) ?? listed[0]!;
      const commentResult = await client.callTool({
        name: "comment",
        arguments: {
          sessionId: targetSession.sessionId,
          filePath: fixture.afterName,
          side: "new",
          line: 2,
          summary: "MCP autostart note",
          rationale: "Injected after the Hunk session auto-started the local daemon.",
          author: "Pi",
          reveal: true,
        },
      });

      const structured = commentResult.structuredContent as { result?: { filePath?: string; line?: number } } | undefined;
      expect(structured?.result?.filePath).toBe(fixture.afterName);
      expect(structured?.result?.line).toBe(2);

      const hunkExitCode = await hunkProc.exited;
      expect([0, 124]).toContain(hunkExitCode);

      const transcript = stripTerminalControl(await Bun.file(fixture.transcript).text());
      expect(transcript).toContain("MCP autostart note");
      expect(transcript).toContain("Injected after the Hunk");
    } finally {
      if (transport) {
        await transport.close().catch(() => undefined);
      }

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

  test("one daemon routes comments to the correct Hunk session when multiple local sessions are open", async () => {
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
    const hunkProcA = spawnHunkSession(fixtureA, { port });
    const hunkProcB = spawnHunkSession(fixtureB, { port });

    let daemonPid: number | null = null;
    let transport: StreamableHTTPClientTransport | null = null;

    try {
      const health = await waitForHealth(port);
      daemonPid = health.pid;
      expect(health.ok).toBe(true);

      const client = new Client({ name: "mcp-multisession-test", version: "1.0.0" });
      transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      await client.connect(transport);

      const sessions = await waitUntil("two registered Hunk sessions", async () => {
        const listed = await listSessions(client);
        return listed.length === 2 ? listed : null;
      });

      const sessionA = sessions.find((session) => session.files.some((file) => file.path === fixtureA.afterName));
      const sessionB = sessions.find((session) => session.files.some((file) => file.path === fixtureB.afterName));
      expect(sessionA).toBeDefined();
      expect(sessionB).toBeDefined();

      await client.callTool({
        name: "comment",
        arguments: {
          sessionId: sessionA!.sessionId,
          filePath: fixtureA.afterName,
          side: "new",
          line: 2,
          summary: "Alpha note",
          rationale: "Delivered only to the alpha Hunk session.",
          author: "Pi",
          reveal: true,
        },
      });

      await client.callTool({
        name: "comment",
        arguments: {
          sessionId: sessionB!.sessionId,
          filePath: fixtureB.afterName,
          side: "new",
          line: 2,
          summary: "Beta note",
          rationale: "Delivered only to the beta Hunk session.",
          author: "Pi",
          reveal: true,
        },
      });

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
      if (transport) {
        await transport.close().catch(() => undefined);
      }

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
