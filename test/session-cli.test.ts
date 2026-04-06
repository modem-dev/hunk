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
    quitAfterSeconds = 12,
    timeoutSeconds = 15,
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

function runSessionCli(args: string[], port: number, stdinText?: string) {
  const proc = Bun.spawnSync(["bun", "run", "src/main.tsx", "session", ...args], {
    cwd: repoRoot,
    stdin: stdinText === undefined ? "ignore" : Buffer.from(stdinText),
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

describe("session CLI", () => {
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

  test("navigate and comment add control a live Hunk session", async () => {
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

      const comment = runSessionCli(
        [
          "comment",
          "add",
          sessionId,
          "--file",
          fixture.afterName,
          "--hunk",
          "2",
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
          line: 13,
        },
      });

      expect(typeof addedComment.result?.commentId).toBe("string");
    } finally {
      session.kill();
      await session.exited;
    }
  }, 20_000);

  test("comment apply adds a batch from stdin without moving focus by default", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const port = 48964;
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
      const applied = JSON.parse(apply.stdout) as {
        result?: {
          applied?: Array<{
            filePath?: string;
            hunkIndex?: number;
            side?: string;
            line?: number;
          }>;
        };
      };
      expect(applied).toMatchObject({
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
      session.kill();
      await session.exited;
    }
  }, 20_000);

  test("comment apply with --focus jumps to the first applied comment", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const port = 48965;
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

      await waitUntil("second hunk selection", () => {
        const context = runSessionCli(["context", sessionId, "--json"], port);
        if (context.proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(context.stdout) as {
          context?: { selectedHunk?: { index: number } };
        };
        return parsed.context?.selectedHunk?.index === 1 ? parsed : null;
      });

      const apply = runSessionCli(
        ["comment", "apply", sessionId, "--stdin", "--focus", "--json"],
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
              author: "Pi",
            },
          ],
        }),
      );
      expect(apply.proc.exitCode).toBe(0);
      expect(apply.stderr).toBe("");

      const focused = await waitUntil("first hunk selection after focused batch apply", () => {
        const context = runSessionCli(["context", sessionId, "--json"], port);
        if (context.proc.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(context.stdout) as {
          context?: { selectedHunk?: { index: number } };
        };
        return parsed.context?.selectedHunk?.index === 0 ? parsed : null;
      });

      expect(focused).toMatchObject({
        context: {
          selectedHunk: {
            index: 0,
          },
        },
      });
    } finally {
      session.kill();
      await session.exited;
    }
  }, 20_000);
});
