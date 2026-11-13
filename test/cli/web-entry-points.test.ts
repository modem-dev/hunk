/**
 * Black-box contract for the web review entry points: `--web`, `--no-open`, `--no-watch`.
 *
 * Until `WEB_REVIEW_ENTRY_POINTS_RELEASED` flips, the flags parse but stay out of help and
 * completions. `--web` prints exactly one URL line on stdout, opens it unless `--no-open`, keeps
 * serving when the browser launch fails, and reloads on input changes unless `--no-watch`.
 *
 * The opener is observed through `$BROWSER`: a stub script records its argv, so no test starts a
 * real browser. Process tests are Unix-only (POSIX signals, shell stubs) and skip on Windows; the
 * Windows launch plan is unit-tested in `packages/hunk/src/core/process/openUrl.test.ts`.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  parseReviewCapabilityFragment,
} from "../../packages/hunk/src/session/reviewHttpProtocol";
import { cleanupTestConfigHomes, createTestConfigHome } from "../helpers/config-home";
import { createTestRuntimeDir } from "../helpers/runtime-dir";

const repoRoot = process.cwd();
const sourceEntrypoint = join(repoRoot, "packages/hunk/src/main.tsx");
const testConfigHome = createTestConfigHome();
const { path: testRuntimeDir, cleanup: cleanupTestRuntimeDir } =
  createTestRuntimeDir("hunk-web-entry-runtime-");
const tempDirs: string[] = [];
const ports: number[] = [];
// Every web review a test starts, so a failed or timed-out test cannot leak a session.
const webReviews = new Set<Subprocess>();

/** SIGKILL every web review a test started that is still running, and wait for each. */
async function killTestWebReviews() {
  const running = [...webReviews];
  webReviews.clear();
  await Promise.all(
    running.map(async (proc) => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await proc.exited.catch(() => undefined);
    }),
  );
}

afterAll(cleanupTestConfigHomes);
afterAll(async () => {
  // Sessions first, so none relaunches a daemon stopped below; `afterEach` normally already did.
  await killTestWebReviews();
  // Stop every daemon these runs auto-started, found through this suite's launch metadata.
  for (const port of ports) {
    try {
      const metadata = JSON.parse(
        readFileSync(join(testRuntimeDir, "hunk-mcp", `daemon-127-0-0-1-${port}.json`), "utf8"),
      ) as { pid?: unknown };
      if (typeof metadata.pid === "number" && metadata.pid > 0) process.kill(metadata.pid);
    } catch {
      // Never started, or already gone.
    }
  }
  await cleanupTestRuntimeDir();
});
afterEach(async () => {
  try {
    await killTestWebReviews();
  } finally {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
});

/** Environment for one spawned Hunk run, isolated from the developer's config and daemon. */
function testEnv(port: number, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    XDG_CONFIG_HOME: testConfigHome,
    XDG_RUNTIME_DIR: testRuntimeDir,
    HUNK_MCP_PORT: String(port),
    HUNK_DISABLE_UPDATE_NOTICE: "1",
    // A run that forgets --no-open must still never start a real browser.
    BROWSER: "/nonexistent/hunk-test-default-browser",
    ...extra,
  };
}

/** Run one Hunk command to completion. */
function runHunk(args: string[], env: Record<string, string | undefined> = process.env) {
  const proc = Bun.spawnSync(["bun", "run", sourceEntrypoint, ...args], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
  };
}

/** Reserve one free loopback port for a private daemon. */
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
async function waitUntil<T>(label: string, fn: () => Promise<T | null> | T | null) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await Bun.sleep(150);
  }
}

/** Create a git repository with one uncommitted change to `values.ts`. */
function createTestRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-web-entry-"));
  tempDirs.push(dir);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: dir,
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
    if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString());
  };
  git("init", "-q");
  writeFileSync(join(dir, "values.ts"), "export const value = 1;\n");
  git("add", "values.ts");
  git("commit", "-q", "-m", "values");
  writeFileSync(join(dir, "values.ts"), "export const value = 2;\n");
  return dir;
}

/** Write a `$BROWSER` stub that records each argument on its own line. */
function createTestBrowserStub() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-web-browser-"));
  tempDirs.push(dir);
  const log = join(dir, "argv.log");
  const script = join(dir, "browser.sh");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`);
  chmodSync(script, 0o755);
  return { script, log };
}

/** Start `hunk diff --web ...` and wait for its URL line and daemon registration. */
async function startWebReview(dir: string, port: number, args: string[], extraEnv = {}) {
  const proc = Bun.spawn(["bun", "run", sourceEntrypoint, "diff", "--web", ...args], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: testEnv(port, extraEnv),
  });
  webReviews.add(proc);
  const output = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"] as const) {
    void (async () => {
      const decoder = new TextDecoder();
      const reader = proc[stream].getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        output[stream] += decoder.decode(chunk.value);
      }
    })();
  }
  const url = await waitUntil("the printed review URL", () =>
    output.stdout.includes("\n") ? output.stdout.split("\n")[0]! : null,
  );
  const sessionId = new URL(url).pathname.split("/").filter(Boolean).at(-1)!;
  return { proc, output, url, sessionId };
}

/** Read the review's current publication generation with the URL's capability. */
async function readTestGeneration(url: string, sessionId: string) {
  const parsed = new URL(url);
  const capability = parseReviewCapabilityFragment(parsed.hash)!;
  // A daemon that has not yet published this review's state reads as null.
  const response = await fetch(
    `${parsed.origin}/review-api/${encodeURIComponent(sessionId)}/publication`,
    { headers: { [HUNK_REVIEW_CAPABILITY_HEADER]: capability } },
  ).catch(() => null);
  if (response?.status !== 200) return null;
  return ((await response.json()) as { publication: { generation: string } }).publication
    .generation;
}

/** Stop one web review the way a person does, and wait for it to exit. */
async function stopWebReview(proc: ReturnType<typeof Bun.spawn>) {
  if (proc.exitCode === null) proc.kill("SIGINT");
  return proc.exited;
}

describe("web review entry points: parsing and visibility", () => {
  test("hides --web, --no-open, --no-watch, and session open from help and completions", () => {
    const surfaces = [
      runHunk(["--help"]),
      runHunk(["diff", "--help"]),
      runHunk(["show", "--help"]),
      runHunk(["session", "--help"]),
      runHunk(["completion", "bash"]),
      runHunk(["completion", "zsh"]),
    ];

    for (const surface of surfaces) {
      expect(surface.exitCode).toBe(0);
      expect(surface.stdout).not.toContain("--web");
      expect(surface.stdout).not.toContain("--no-open");
      expect(surface.stdout).not.toContain("--no-watch");
      expect(surface.stdout).not.toContain("session open");
    }
  });

  test("rejects --no-open without --web, and --watch with --no-watch", () => {
    const noOpen = runHunk(["diff", "--no-open"]);
    expect(noOpen.exitCode).not.toBe(0);
    expect(noOpen.stderr).toContain("`--no-open` only applies to `--web`.");

    const both = runHunk(["diff", "--web", "--watch", "--no-watch"]);
    expect(both.exitCode).not.toBe(0);
    expect(both.stderr).toContain("`--watch` and `--no-watch` cannot be combined.");
  });
});

// Spawns real Hunk processes, a real daemon, and shell stubs; SIGINT delivery and `#!/bin/sh`
// are Unix-only, so the suite is skipped on Windows.
describe.skipIf(process.platform === "win32")("web review entry points: processes", () => {
  test("--web --no-open prints exactly one URL line on stdout and opens nothing", async () => {
    const dir = createTestRepo();
    const port = await reserveLoopbackPort();
    const browser = createTestBrowserStub();
    const { proc, output, url, sessionId } = await startWebReview(dir, port, ["--no-open"], {
      BROWSER: browser.script,
    });

    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/review\/[^/]+\/#capability=/);
      await waitUntil("the session to serve", () => readTestGeneration(url, sessionId));
      expect(await stopWebReview(proc)).toBe(0);
      expect(output.stdout).toBe(`${url}\n`);
      expect(() => readFileSync(browser.log, "utf8")).toThrow();
    } finally {
      await stopWebReview(proc);
    }
  }, 60_000);

  // `$BROWSER` is the Unix opener convention; macOS always uses `open`, which this suite must
  // not run, so the argv check runs where `$BROWSER` decides the launch.
  test.skipIf(process.platform === "darwin")(
    "--web opens the exact URL, fragment included, through $BROWSER",
    async () => {
      const dir = createTestRepo();
      const port = await reserveLoopbackPort();
      const browser = createTestBrowserStub();
      const { proc, output, url } = await startWebReview(dir, port, [], {
        BROWSER: browser.script,
      });

      try {
        const argv = await waitUntil("the browser stub to run", () => {
          try {
            return readFileSync(browser.log, "utf8");
          } catch {
            return null;
          }
        });
        expect(argv).toBe(`${url}\n`);
        expect(new URL(url).hash).toStartWith("#capability=");
        expect(output.stdout).toBe(`${url}\n`);
      } finally {
        expect(await stopWebReview(proc)).toBe(0);
      }
    },
    60_000,
  );

  test.skipIf(process.platform === "darwin")(
    "a failed browser launch is one stderr line without the capability, and serving continues",
    async () => {
      const dir = createTestRepo();
      const port = await reserveLoopbackPort();
      const { proc, output, url, sessionId } = await startWebReview(dir, port, [], {
        BROWSER: "/nonexistent/hunk-test-browser",
      });

      try {
        await waitUntil("the launch failure", () =>
          output.stderr.includes("Could not open a browser") ? true : null,
        );
        expect(output.stderr).toContain(
          "hunk: warning: Could not open a browser with /nonexistent/hunk-test-browser (ENOENT). Open the URL above in a browser instead.\n",
        );
        expect(output.stderr).not.toContain(parseReviewCapabilityFragment(new URL(url).hash)!);
        await waitUntil("the session to serve", () => readTestGeneration(url, sessionId));
        expect(proc.exitCode).toBeNull();
      } finally {
        expect(await stopWebReview(proc)).toBe(0);
      }
    },
    60_000,
  );

  test("--web implies --watch: an input change publishes a new generation", async () => {
    const dir = createTestRepo();
    const port = await reserveLoopbackPort();
    const { proc, url, sessionId } = await startWebReview(dir, port, ["--no-open"]);

    try {
      const first = await waitUntil("the first generation", () =>
        readTestGeneration(url, sessionId),
      );
      writeFileSync(join(dir, "values.ts"), "export const value = 3;\n");
      const next = await waitUntil("a watch reload", async () => {
        const generation = await readTestGeneration(url, sessionId);
        return generation && generation !== first ? generation : null;
      });
      expect(next).not.toBe(first);
    } finally {
      expect(await stopWebReview(proc)).toBe(0);
    }
  }, 60_000);

  test("--no-watch keeps the first generation after an input change", async () => {
    const dir = createTestRepo();
    const port = await reserveLoopbackPort();
    const { proc, url, sessionId } = await startWebReview(dir, port, ["--no-open", "--no-watch"]);

    try {
      const first = await waitUntil("the first generation", () =>
        readTestGeneration(url, sessionId),
      );
      writeFileSync(join(dir, "values.ts"), "export const value = 3;\n");
      // Longer than the watch's event debounce and its 2 s safety check, which the implied-watch
      // test above shows reloading well within this window.
      await Bun.sleep(4_000);
      expect(await readTestGeneration(url, sessionId)).toBe(first);
    } finally {
      expect(await stopWebReview(proc)).toBe(0);
    }
  }, 60_000);
});
