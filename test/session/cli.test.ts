import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function spawnHunkSession(
  fixture: ReturnType<typeof createFixtureFiles>,
  {
    port,
    quitAfterSeconds = 8,
    timeoutSeconds = 10,
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
      HUNK_MCP_PORT: `${port}`,
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

afterEach(() => {
  cleanupTempDirs();
});

describe("session CLI integration", () => {
  test("list/get/context expose live Hunk sessions through the daemon", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const port = 48961;
    const fixture = createFixtureFiles(
      "inspect",
      ["export const value = 1;", "console.log(value);"],
      ["export const value = 2;", "console.log(value * 2);"],
    );
    const session = spawnHunkSession(fixture, { port });

    try {
      const listed = await waitUntil("registered live session", () => {
        const { proc, stdout } = runSessionCli(["list", "--json"], port);
        if (proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(stdout) as SessionListJson;
        return parsed.sessions.length > 0 ? parsed.sessions : null;
      });

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
      session.kill();
      await session.exited;
    }
  });

  test("reload replaces what a live session is showing", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const port = 48963;
    const fixtureA = createFixtureFiles(
      "reload-alpha",
      ["export const alpha = 1;"],
      ["export const alpha = 2;", "export const beta = true;"],
    );
    const fixtureB = createFixtureFiles(
      "reload-beta",
      ["export const before = 10;"],
      ["export const after = 20;", "export const extra = 'yes';"],
    );
    const session = spawnHunkSession(fixtureA, { port, quitAfterSeconds: 18, timeoutSeconds: 20 });

    try {
      const listed = await waitUntil("registered live session", () => {
        const { proc, stdout } = runSessionCli(["list", "--json"], port);
        if (proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(stdout) as SessionListJson;
        return parsed.sessions.length > 0 ? parsed.sessions : null;
      });

      const sessionId = listed[0]!.sessionId;
      const reload = runSessionCli(
        ["reload", sessionId, "--json", "--", "diff", fixtureB.before, fixtureB.after],
        port,
      );
      expect(reload.proc.exitCode).toBe(0);
      expect(reload.stderr).toBe("");
      expect(JSON.parse(reload.stdout)).toMatchObject({
        result: {
          sessionId,
          inputKind: "diff",
          fileCount: 1,
          selectedFilePath: fixtureB.afterName,
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
        return parsed.session?.files?.[0]?.path === fixtureB.afterName ? parsed : null;
      });

      expect(reloaded).toMatchObject({
        session: {
          inputKind: "diff",
          files: [{ path: fixtureB.afterName }],
        },
      });
    } finally {
      session.kill();
      await session.exited;
    }
  }, 20_000);

  test("navigate works, and comment add only focuses the session when --focus is passed", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const port = 48962;
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
    const session = spawnHunkSession(fixture, { port, quitAfterSeconds: 18, timeoutSeconds: 20 });

    try {
      const listed = await waitUntil("registered live session", () => {
        const { proc, stdout } = runSessionCli(["list", "--json"], port);
        if (proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(stdout) as SessionListJson;
        return parsed.sessions.length > 0 ? parsed.sessions : null;
      });

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
      session.kill();
      await session.exited;
    }
  }, 20_000);
});
