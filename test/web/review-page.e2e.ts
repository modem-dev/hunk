/**
 * Opens a live review in Chromium the way a person would: a real daemon from source, a real
 * session registered with it, and the review URL with its capability fragment.
 * `HUNK_TEST_EXECUTABLE` runs the daemon from a compiled binary instead, which exercises the
 * page assets embedded in it.
 *
 * Asserts what the M3 shell promises — the page connects, shows the file count, renders the
 * first file through Pierre with syntax colors — and that it does so under the page's
 * content security policy without a single violation or console error.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
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
const PATCH_FIXTURE = join(TEST_DIR, "fixtures", "two-files.patch");
const BUN = process.env.HUNK_TEST_BUN ?? "bun";
const COMPILED_EXECUTABLE = process.env.HUNK_TEST_EXECUTABLE;

const processes: ChildProcess[] = [];
const directories: string[] = [];

/** Reserve one free loopback port for the test's private daemon. */
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
async function waitForTestCondition<T>(
  label: string,
  check: () => Promise<T | undefined>,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Environment that points every spawned Hunk process at a private daemon and runtime dir. */
function createTestEnvironment(port: number) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "hunk-web-runtime-"));
  const configHome = mkdtempSync(join(tmpdir(), "hunk-web-config-"));
  directories.push(runtimeDir, configHome);
  return {
    ...process.env,
    HUNK_MCP_PORT: String(port),
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_CONFIG_HOME: configHome,
  };
}

/** Spawn one process from the repository root and remember it for cleanup. */
function spawnTestProcess(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "inherit"] });
  processes.push(child);
  return child;
}

/** Read the review URL the session fixture prints as its first line. */
async function readTestReviewUrl(session: ChildProcess) {
  const lines = createInterface({ input: session.stdout! });
  for await (const line of lines) {
    if (!line.startsWith("{")) {
      continue;
    }
    const parsed = JSON.parse(line) as { url?: string };
    if (parsed.url) {
      return parsed.url;
    }
  }
  throw new Error("The review session exited before printing its URL.");
}

test.afterAll(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("opens a live review, renders a Pierre diff, and stays inside the page CSP", async ({
  page,
}) => {
  const port = await reserveTestPort();
  const env = createTestEnvironment(port);
  const origin = `http://127.0.0.1:${port}`;

  if (COMPILED_EXECUTABLE) {
    spawnTestProcess(COMPILED_EXECUTABLE, ["daemon", "serve"], env);
  } else {
    spawnTestProcess(BUN, [SOURCE_ENTRYPOINT, "daemon", "serve"], env);
  }
  await waitForTestCondition("the daemon to answer", async () => {
    const response = await fetch(`${origin}/health`);
    return response.ok ? true : undefined;
  });

  const session = spawnTestProcess(BUN, [SESSION_FIXTURE, PATCH_FIXTURE], env);
  const reviewUrl = await readTestReviewUrl(session);
  const url = new URL(reviewUrl);
  const route = parseReviewPagePath(url.pathname);
  const capability = parseReviewCapabilityFragment(url.hash);
  expect(route?.kind).toBe("document");
  expect(capability).toBeDefined();

  // Registration is asynchronous; wait until the daemon serves the publication.
  await waitForTestCondition("the session's publication", async () => {
    const response = await fetch(
      `${origin}${reviewHttpPath({ kind: "publication", sessionId: (route as { sessionId: string }).sessionId })}`,
      { headers: { [HUNK_REVIEW_CAPABILITY_HEADER]: capability! } },
    );
    return response.ok ? true : undefined;
  });

  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("requestfailed", (request) => problems.push(`request failed: ${request.url()}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  const documentResponse = await page.goto(reviewUrl);
  expect(documentResponse?.status()).toBe(200);
  expect(documentResponse?.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(documentResponse?.headers()["cache-control"]).toBe("no-store");

  await expect(page.locator('[data-state="connected"]')).toHaveText("Connected");
  await expect(page.getByTestId("file-count")).toHaveText("2 files");

  // Pierre renders inside a shadow root; wait until the diff lines carry syntax colors, which
  // only happens once its lazily loaded grammar and theme chunks have been fetched.
  const rendered = await waitForTestCondition(
    "Pierre to render the highlighted diff",
    () =>
      page.evaluate(() => {
        const container = document.querySelector('[data-testid="first-file-diff"] diffs-container');
        const root = container?.shadowRoot;
        if (!root) return undefined;
        const lines = root.querySelectorAll("[data-line]").length;
        // Highlighted tokens carry inline theme styles; several distinct computed colors mean
        // the grammar ran rather than plain text falling back to one foreground.
        const tokenColors = new Set(
          Array.from(root.querySelectorAll("span[style]"), (span) => getComputedStyle(span).color),
        );
        const text = root.textContent ?? "";
        return lines > 0 && tokenColors.size > 2
          ? { lines, colors: tokenColors.size, text }
          : undefined;
      }),
    30_000,
  );
  expect(rendered.text).toContain("punctuation");
  expect(rendered.text).toContain("greeting.ts");

  // Give late chunks and deferred work a moment to report anything they would.
  await page.waitForTimeout(500);
  expect(problems).toEqual([]);
});
