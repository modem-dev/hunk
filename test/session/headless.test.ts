import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  parseReviewCapabilityFragment,
} from "../../packages/hunk/src/session/reviewHttpProtocol";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../../packages/hunk/src/session/reviewProtocol";
import { cleanupTestConfigHomes, createTestConfigHome } from "../helpers/config-home";
import { createTestRuntimeDir } from "../helpers/runtime-dir";

const repoRoot = process.cwd();
const sourceEntrypoint = join(repoRoot, "packages/hunk/src/main.tsx");
// Spawned hunk processes must assert built-in defaults, not the developer's ambient user config.
const testConfigHome = createTestConfigHome();
const { path: testRuntimeDir, cleanup: cleanupTestRuntimeDir } =
  createTestRuntimeDir("hunk-headless-runtime-");
const tempDirs: string[] = [];
const ports: number[] = [];

afterAll(cleanupTestConfigHomes);
afterAll(() => {
  // Stop every daemon a headless session auto-started for this suite, found through this suite's
  // own launch metadata rather than the public health endpoint.
  for (const port of ports) {
    const pid = readLaunchedDaemonPid(port);
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    }
  }
  cleanupTestRuntimeDir();
});
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Read the PID of the daemon this suite launched on one port, from its launch metadata. */
function readLaunchedDaemonPid(port: number) {
  try {
    const metadata = JSON.parse(
      readFileSync(join(testRuntimeDir, "hunk-mcp", `daemon-127-0-0-1-${port}.json`), "utf8"),
    ) as { pid?: unknown };
    return typeof metadata.pid === "number" && metadata.pid > 0 ? metadata.pid : null;
  } catch {
    return null;
  }
}

/** Environment every spawned Hunk process in this suite shares. */
function testEnv(port: number) {
  return {
    ...process.env,
    XDG_CONFIG_HOME: testConfigHome,
    XDG_RUNTIME_DIR: testRuntimeDir,
    HUNK_MCP_PORT: String(port),
    HUNK_DISABLE_UPDATE_NOTICE: "1",
  };
}

/** Reserve one free loopback port for this test's private daemon. */
async function reserveLoopbackPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (!port) throw new Error("Failed to reserve a loopback port.");
  ports.push(port);
  return port;
}

/** Poll until a value is available or the deadline passes. */
async function waitUntil<T>(
  label: string,
  fn: () => Promise<T | null> | T | null,
  timeoutMs = 20_000,
  intervalMs = 150,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await Bun.sleep(intervalMs);
  }
}

/** Run one git command in a fixture repository. */
function git(dir: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Hunk Test",
      GIT_AUTHOR_EMAIL: "hunk@example.invalid",
      GIT_COMMITTER_NAME: "Hunk Test",
      GIT_COMMITTER_EMAIL: "hunk@example.invalid",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${Buffer.from(result.stderr).toString()}`);
  }
}

/**
 * Create a repository with two commits and an uncommitted two-hunk change to `values.ts`.
 *
 * `hunk diff` reviews the working tree; `hunk show HEAD` reviews `notes.ts`, a different input.
 */
function createTestFixture() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-headless-"));
  tempDirs.push(dir);
  const lines = Array.from(
    { length: 30 },
    (_, index) => `export const value${index + 1} = ${index + 1};`,
  );
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "values.ts"), `${lines.join("\n")}\n`);
  git(dir, ["add", "values.ts"]);
  git(dir, ["commit", "-q", "-m", "values"]);
  writeFileSync(join(dir, "notes.ts"), "export const note = true;\n");
  git(dir, ["add", "notes.ts"]);
  git(dir, ["commit", "-q", "-m", "notes"]);
  const after = [...lines];
  after[1] = "export const value2 = 200;";
  after[25] = "export const value26 = 2600;";
  writeFileSync(join(dir, "values.ts"), `${after.join("\n")}\n`);
  return dir;
}

/** Run one `hunk session` command against this test's daemon. */
function session(port: number, args: string[], stdin?: string) {
  const proc = Bun.spawnSync(["bun", "run", sourceEntrypoint, "session", ...args], {
    cwd: repoRoot,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: testEnv(port),
  });
  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
  };
}

/** Run one session command that must succeed and parse its `--json` output. */
function sessionJson<T = Record<string, unknown>>(port: number, args: string[], stdin?: string) {
  // `--json` belongs to the session command, before any `--` that starts a reload input.
  const separator = args.indexOf("--");
  const withJson =
    separator < 0
      ? [...args, "--json"]
      : [...args.slice(0, separator), "--json", ...args.slice(separator)];
  const result = session(port, withJson, stdin);
  if (result.exitCode !== 0) {
    throw new Error(`hunk session ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
  }
  return JSON.parse(result.stdout) as T;
}

/** Start one headless review and wait for its URL and daemon registration. */
async function startHeadlessReview(dir: string, port: number) {
  // `--no-open`: `--web` now opens a browser, which a test must never do.
  const proc = Bun.spawn(
    ["bun", "run", sourceEntrypoint, "diff", "--web", "--no-open", "--experimental"],
    {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: testEnv(port),
    },
  );
  let stdout = "";
  // Drain stdout continuously; the URL is its only line.
  void (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      stdout += decoder.decode(chunk.value);
    }
  })();
  const url = await waitUntil("the printed review URL", () => {
    const line = stdout.split("\n").find((entry) => entry.startsWith("http://"));
    return line ?? null;
  });
  const sessionId = await waitUntil("the registered headless session", () => {
    const result = session(port, ["list", "--json"]);
    if (result.exitCode !== 0) return null;
    const listed = JSON.parse(result.stdout) as { sessions: Array<{ sessionId: string }> };
    return listed.sessions[0]?.sessionId ?? null;
  });
  return { proc, url, sessionId };
}

/** Present the URL's capability to one review API route. */
function reviewApi(url: string, sessionId: string, route: string, init: RequestInit = {}) {
  const parsed = new URL(url);
  const capability = parseReviewCapabilityFragment(parsed.hash);
  return fetch(`${parsed.origin}/review-api/${encodeURIComponent(sessionId)}/${route}`, {
    ...init,
    headers: {
      ...(capability ? { [HUNK_REVIEW_CAPABILITY_HEADER]: capability } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

// Spawns real Hunk processes and a real daemon; POSIX signal delivery for SIGINT is Unix-only,
// so the suite is skipped on Windows, where `process.kill(pid, "SIGINT")` cannot reach a child.
describe.skipIf(process.platform === "win32")("headless review session", () => {
  test("serves every hunk session command and shuts down cleanly on SIGINT", async () => {
    const dir = createTestFixture();
    const port = await reserveLoopbackPort();
    const { proc, url, sessionId } = await startHeadlessReview(dir, port);

    try {
      expect(url).toContain(`/review/${sessionId}/#capability=`);

      const got = sessionJson<{ session: { sessionId: string } }>(port, ["get", sessionId]);
      expect(got.session.sessionId).toBe(sessionId);
      expect(JSON.stringify(sessionJson(port, ["context", sessionId]))).toContain("values.ts");

      const review = sessionJson<{ review: { files: Array<{ path: string; patch?: string }> } }>(
        port,
        ["review", sessionId],
      );
      expect(review.review.files.map((file) => file.path)).toEqual(["values.ts"]);
      const withPatch = sessionJson<{ review: { files: Array<{ patch?: string }> } }>(port, [
        "review",
        sessionId,
        "--include-patch",
      ]);
      expect(withPatch.review.files[0]?.patch).toContain("value26 = 2600");

      const navigated = sessionJson<{ result: Record<string, unknown> }>(port, [
        "navigate",
        sessionId,
        "--file",
        "values.ts",
        "--new-line",
        "26",
      ]);
      expect(navigated.result).toMatchObject({
        filePath: "values.ts",
        hunkIndex: 1,
        revealed: "hunk",
      });
      expect(
        sessionJson<{ result: Record<string, unknown> }>(port, [
          "navigate",
          sessionId,
          "--file",
          "values.ts",
          "--hunk",
          "1",
        ]).result,
      ).toMatchObject({ hunkIndex: 0 });

      const added = sessionJson<{ result: { commentId: string; markupWidth?: number } }>(port, [
        "comment",
        "add",
        sessionId,
        "--file",
        "values.ts",
        "--new-line",
        "2",
        "--summary",
        "Check this value",
        "--markup",
        "<b>bold</b>",
      ]);
      expect(added.result.markupWidth).toBeGreaterThan(0);
      // The comment reaches a browser through the shared-state snapshot.
      const stateBody = await waitUntil("the comment in the shared state", async () => {
        const response = await reviewApi(url, sessionId, "state");
        if (response.status !== 200) return null;
        const body = (await response.json()) as {
          state: { notes: Array<{ origin: string; note: { id: string; summary: string } }> };
        };
        return body.state.notes.some((entry) => entry.note.id === added.result.commentId)
          ? body
          : null;
      });
      expect(
        stateBody.state.notes.find((entry) => entry.note.id === added.result.commentId),
      ).toMatchObject({ origin: "live", note: { summary: "Check this value" } });
      const applied = sessionJson<{ result: { applied: Array<{ commentId: string }> } }>(
        port,
        ["comment", "apply", sessionId, "--stdin"],
        JSON.stringify({
          comments: [{ filePath: "values.ts", newLine: 26, summary: "Second note" }],
        }),
      );
      expect(applied.result.applied).toHaveLength(1);
      const listed = sessionJson<{ comments: Array<{ commentId: string }> }>(port, [
        "comment",
        "list",
        sessionId,
      ]);
      expect(listed.comments).toHaveLength(2);
      expect(
        sessionJson<{ result: Record<string, unknown> }>(port, [
          "navigate",
          sessionId,
          "--next-comment",
        ]).result,
      ).toMatchObject({ filePath: "values.ts" });
      sessionJson(port, ["comment", "rm", sessionId, added.result.commentId]);
      expect(
        sessionJson<{ result: { removedCount: number } }>(port, [
          "comment",
          "clear",
          sessionId,
          "--yes",
        ]).result.removedCount,
      ).toBe(1);

      const marked = sessionJson<{ result: { fileMarkCount: number } }>(port, [
        "highlight",
        "add",
        sessionId,
        "--file",
        "values.ts",
        "--new-line",
        "2",
        "--start",
        "0",
        "--end",
        "6",
      ]);
      expect(marked.result.fileMarkCount).toBe(1);
      expect(
        sessionJson<{ result: { removedCount: number } }>(port, ["highlight", "clear", sessionId])
          .result.removedCount,
      ).toBe(1);

      // `hunk session open --no-open` asks the session for its URL: the same capability the
      // process printed, as exactly one stdout line, and it authorizes the review API.
      const opened = session(port, ["open", sessionId, "--no-open"]);
      expect(opened.exitCode).toBe(0);
      expect(opened.stdout).toBe(`${url}\n`);
      expect((await reviewApi(opened.stdout.trim(), sessionId, "publication")).status).toBe(200);

      // The printed capability authorizes the review API, and brokered actions apply.
      const unauthorized = await fetch(
        `${new URL(url).origin}/review-api/${encodeURIComponent(sessionId)}/publication`,
      );
      expect(unauthorized.status).toBe(401);
      const publication = await reviewApi(url, sessionId, "publication");
      expect(publication.status).toBe(200);
      const {
        publication: { generation },
      } = (await publication.json()) as { publication: { generation: string } };
      const action = await reviewApi(url, sessionId, "actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
          generation,
          actor: { clientId: "headless-test", kind: "browser" },
          action: { type: "notes/set-visibility", visible: true },
        }),
      });
      expect(action.status).toBe(200);
      await waitUntil("the action to reach the session snapshot", () => {
        const context = JSON.stringify(sessionJson(port, ["get", sessionId]));
        return context.includes('"showAgentNotes":true') ? true : null;
      });

      // A browser's refresh reloads the session's own input, with no arguments.
      const refreshed = await reviewApi(url, sessionId, "refresh", { method: "POST" });
      expect(refreshed.status).toBe(200);
      const refreshBody = (await refreshed.json()) as { publication: { generation: string } };
      expect(refreshBody.publication.generation).not.toBe(generation);

      // Same-input and new-input reloads replace the review without a terminal.
      const sameInput = sessionJson<{ result: { fileCount: number } }>(port, [
        "reload",
        sessionId,
        "--",
        "diff",
      ]);
      expect(sameInput.result.fileCount).toBe(1);
      sessionJson(port, ["reload", sessionId, "--", "show", "HEAD"]);
      const reloaded = sessionJson<{ review: { files: Array<{ path: string }> } }>(port, [
        "review",
        sessionId,
      ]);
      expect(reloaded.review.files.map((file) => file.path)).toEqual(["notes.ts"]);
      expect((await reviewApi(url, sessionId, "publication")).status).toBe(200);

      proc.kill("SIGINT");
      expect(await proc.exited).toBe(0);
      await waitUntil("the session to leave the daemon", () => {
        const listedAfter = session(port, ["list", "--json"]);
        if (listedAfter.exitCode !== 0) return null;
        const parsed = JSON.parse(listedAfter.stdout) as { sessions: unknown[] };
        return parsed.sessions.length === 0 ? true : null;
      });
    } finally {
      if (proc.exitCode === null) {
        proc.kill();
        await proc.exited.catch(() => undefined);
      }
    }
  }, 120_000);
});
