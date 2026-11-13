/**
 * Starts a real daemon and a real review session from source for one browser test, and
 * watches a page for anything the content security policy or the console reports.
 *
 * Every spawned process gets a private daemon port, runtime directory, and config home, so
 * tests never touch a developer's daemon. `HUNK_TEST_EXECUTABLE` runs the daemon from a
 * compiled binary instead, which exercises the page assets embedded in it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  parseReviewCapabilityFragment,
  parseReviewPagePath,
  reviewHttpPath,
} from "../../packages/hunk/src/session/reviewHttpProtocol";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..");
const SOURCE_ENTRYPOINT = join(REPO_ROOT, "packages", "hunk", "src", "main.tsx");
const SESSION_FIXTURE = join(TEST_DIR, "fixtures", "review-session.ts");
export const PATCH_FIXTURE = join(TEST_DIR, "fixtures", "two-files.patch");
const BUN = process.env.HUNK_TEST_BUN ?? "bun";
const COMPILED_EXECUTABLE = process.env.HUNK_TEST_EXECUTABLE;

/** Reserve one free loopback port for a private daemon. */
async function reserveTestPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  const address = listener.address();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (typeof address !== "object" || !address) {
    throw new Error("Could not reserve a loopback port for the web test daemon.");
  }
  return address.port;
}

/** Poll until `check` returns a value, or fail with `label` after the deadline. */
export async function waitForTestCondition<T>(
  label: string,
  check: () => Promise<T | undefined>,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** One running daemon and session, and how to stop them. */
export interface TestWebReview {
  url: string;
  origin: string;
  session: ChildProcess;
  /** Lines the session prints after its URL, such as reload acknowledgements. */
  nextLine(): Promise<string>;
  stop(): Promise<void>;
}

/** Start a daemon and one session serving `input` (a patch path or `--rich`). */
export async function startTestWebReview(input: string): Promise<TestWebReview> {
  const port = await reserveTestPort();
  const directories = [
    mkdtempSync(join(tmpdir(), "hunk-web-runtime-")),
    mkdtempSync(join(tmpdir(), "hunk-web-config-")),
  ];
  const env = {
    ...process.env,
    HUNK_MCP_PORT: String(port),
    XDG_RUNTIME_DIR: directories[0],
    XDG_CONFIG_HOME: directories[1],
  };
  const origin = `http://127.0.0.1:${port}`;
  const processes: ChildProcess[] = [];
  const spawnTest = (command: string, args: string[]) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    processes.push(child);
    return child;
  };

  if (COMPILED_EXECUTABLE) spawnTest(COMPILED_EXECUTABLE, ["daemon", "serve"]);
  else spawnTest(BUN, [SOURCE_ENTRYPOINT, "daemon", "serve"]);
  await waitForTestCondition("the daemon to answer", async () =>
    (await fetch(`${origin}/health`)).ok ? true : undefined,
  );

  const session = spawnTest(BUN, [SESSION_FIXTURE, input]);
  const lines: Interface = createInterface({ input: session.stdout! });
  const pending: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  lines.on("line", (line) => {
    if (!line.startsWith("{")) return;
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else pending.push(line);
  });
  const nextLine = () =>
    new Promise<string>((resolve) => {
      const line = pending.shift();
      if (line) resolve(line);
      else waiters.push(resolve);
    });

  const url = (JSON.parse(await nextLine()) as { url: string }).url;
  const parsed = new URL(url);
  const route = parseReviewPagePath(parsed.pathname);
  const capability = parseReviewCapabilityFragment(parsed.hash);
  if (route?.kind !== "document" || !capability) {
    throw new Error(`The session printed an unusable review URL: ${url}`);
  }
  await waitForTestCondition("the session's publication", async () => {
    const response = await fetch(
      `${origin}${reviewHttpPath({ kind: "publication", sessionId: route.sessionId })}`,
      { headers: { [HUNK_REVIEW_CAPABILITY_HEADER]: capability } },
    );
    return response.ok ? true : undefined;
  });

  return {
    url,
    origin,
    session,
    nextLine,
    async stop() {
      for (const child of processes) {
        if (child.exitCode === null) {
          const exited = new Promise((resolve) => child.once("exit", resolve));
          child.kill("SIGTERM");
          await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
        }
      }
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * How Chromium reports the daemon closing an idle event stream.
 *
 * The daemon's Bun listener drops a request after 10 idle seconds while the review surface
 * heartbeats every 15, so every event stream is cut once and the page reconnects. That is a
 * daemon defect, reported separately; it is tolerated here only for the `/events` route so
 * any other failed request still fails the test.
 */
const DROPPED_EVENT_STREAM = "net::ERR_INCOMPLETE_CHUNKED_ENCODING";

/** Record CSP violations, console errors and warnings, page errors, and failed requests. */
export async function watchTestPageProblems(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    if (message.text() === `Failed to load resource: ${DROPPED_EVENT_STREAM}`) return;
    problems.push(`console ${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText;
    // Aborted fetches are the client cancelling superseded work, not failures.
    if (failure === "net::ERR_ABORTED") return;
    if (failure === DROPPED_EVENT_STREAM && new URL(request.url()).pathname.endsWith("/events")) {
      return;
    }
    problems.push(`request failed: ${request.url()} ${failure}`);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return problems;
}
