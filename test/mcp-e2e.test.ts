import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function createFixtureFiles() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-mcp-e2e-"));
  tempDirs.push(dir);

  const before = join(dir, "before.ts");
  const after = join(dir, "after.ts");
  const transcript = join(dir, "transcript.txt");

  writeFileSync(before, ["export const alpha = 1;", "export const keep = true;", ""].join("\n"));
  writeFileSync(after, ["export const alpha = 2;", "export const keep = true;", "export const gamma = true;", ""].join("\n"));

  return { dir, before, after, transcript };
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

      return await response.json();
    } catch {
      return null;
    }
  });
}

afterEach(() => {
  cleanupTempDirs();
});

describe("MCP end-to-end", () => {
  test("daemon comment calls reach a live Hunk TTY session and render inline notes", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const fixture = createFixtureFiles();
    const port = 48000 + Math.floor(Math.random() * 1000);
    const daemonProc = Bun.spawn(["bun", "run", sourceEntrypoint, "--", "mcp", "serve"], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HUNK_MCP_PORT: String(port),
      },
    });

    const hunkCommand = [
      `(sleep 6; printf q) | timeout 8 script -q -f -e -c`,
      shellQuote(`bun run ${shellQuote(sourceEntrypoint)} diff ${shellQuote(fixture.before)} ${shellQuote(fixture.after)}`),
      shellQuote(fixture.transcript),
    ].join(" ");
    const hunkProc = Bun.spawn(["bash", "-lc", hunkCommand], {
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

    let client: Client | null = null;
    let transport: StreamableHTTPClientTransport | null = null;

    try {
      await waitForHealth(port);

      client = new Client({ name: "mcp-e2e-test", version: "1.0.0" });
      transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      await client.connect(transport);

      const listed = await waitUntil("registered Hunk session", async () => {
        const result = await client!.callTool({
          name: "list_sessions",
          arguments: {},
        });
        const sessions = (result.structuredContent as { sessions?: Array<{ sessionId: string; title: string }> } | undefined)?.sessions;

        if (!sessions || sessions.length === 0) {
          return null;
        }

        return sessions;
      });

      const targetSession = listed.find((session) => session.title.includes("after.ts")) ?? listed[0]!;
      const commentResult = await client.callTool({
        name: "comment",
        arguments: {
          sessionId: targetSession.sessionId,
          filePath: "after.ts",
          side: "new",
          line: 2,
          summary: "MCP e2e note",
          rationale: "Injected from the automated MCP integration test.",
          author: "Pi",
          reveal: true,
        },
      });

      const structured = commentResult.structuredContent as { result?: { filePath?: string; line?: number } } | undefined;
      expect(structured?.result?.filePath).toBe("after.ts");
      expect(structured?.result?.line).toBe(2);

      const hunkExitCode = await hunkProc.exited;
      expect([0, 124]).toContain(hunkExitCode);

      const transcript = stripTerminalControl(await Bun.file(fixture.transcript).text());
      expect(transcript).toContain("MCP e2e note");
      expect(transcript).toContain("Injected from the automated");
    } finally {
      if (transport) {
        await transport.close().catch(() => undefined);
      }

      hunkProc.kill();
      daemonProc.kill();
      await hunkProc.exited.catch(() => undefined);
      await daemonProc.exited.catch(() => undefined);
    }
  }, 20_000);
});
