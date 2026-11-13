/**
 * Starts a real daemon and a real headless review session for one browser test, and watches a
 * page for anything the content security policy or the console reports.
 *
 * The session is Hunk itself: `hunk patch <file> --web`, or `hunk diff --staged --web` in a
 * git repository the fixtures write, run from source. It prints its review URL on stdout and
 * answers `hunk session` commands like any session, which is how a test reloads it. Every
 * spawned process gets a private daemon port, runtime directory, and config home, so tests
 * never touch a developer's daemon. `HUNK_TEST_EXECUTABLE` runs the daemon and the session from
 * a compiled binary instead, which exercises the page assets embedded in it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  parseReviewCapabilityFragment,
  parseReviewPagePath,
  reviewHttpPath,
} from "../../packages/hunk/src/session/reviewHttpProtocol";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../../packages/hunk/src/session/reviewProtocol";
import {
  reviewOrderSidecarPath,
  writeManyReviewRepo,
  writeRichReviewGeneration,
  writeRichReviewRepo,
  type TestSidecarFileContext,
} from "./fixtures/rich-review";
import { writePreviewReviewRepo } from "./fixtures/preview-review";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..");
const SOURCE_ENTRYPOINT = join(REPO_ROOT, "packages", "hunk", "src", "main.tsx");
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

/** One running daemon and session, and how to drive and stop them. */
export interface TestWebReview {
  url: string;
  origin: string;
  sessionId: string;
  /** The repository the session reviews, for the git-backed scenarios. */
  repo?: string;
  /** Run one `hunk` command against this test's daemon, with optional stdin; resolves stdout. */
  hunk(args: readonly string[], input?: string): Promise<string>;
  /** Stage the rich review's next generation and reload the session, as an agent would. */
  reload(): Promise<void>;
  /** Read one review API route as JSON, presenting the capability as the page does. */
  readApi(kind: "publication" | "state"): Promise<Record<string, unknown>>;
  /** Send one review action through the review link, as a browser actor (the only kind it accepts). */
  postAction(
    action: Record<string, unknown>,
    kind?: "terminal" | "browser" | "agent",
  ): Promise<Response>;
  stop(): Promise<void>;
}

/** What a test adds to its session beyond the scenario. */
export interface TestWebReviewOptions {
  /** Extra review options, such as `--agent-notes` or `--experimental`. */
  args?: readonly string[];
  /** A user `config.toml` for the session, e.g. a custom theme. */
  config?: string;
  /** Agent context for files of the rich scenario, by path, written into its sidecar. */
  context?: Readonly<Record<string, TestSidecarFileContext>>;
}

/**
 * Start a daemon and one headless session serving `input`: a patch path, `--rich`, `--previews`
 * (images and Markdown), or `--many=N`.
 */
export async function startTestWebReview(
  input: string,
  options: TestWebReviewOptions = {},
): Promise<TestWebReview> {
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

  // A git-backed scenario reviews the staged changes of a repository the fixtures write, in the
  // order their sidecar states; a patch scenario reviews the patch file.
  const many = /^--many=(\d+)$/.exec(input);
  const repo =
    input === "--rich" || input === "--previews" || many
      ? join(directories[0]!, "review-repo")
      : undefined;
  if (repo && many) writeManyReviewRepo(repo, Number(many[1]));
  else if (repo && input === "--previews") writePreviewReviewRepo(repo);
  else if (repo) writeRichReviewRepo(repo, options.context);
  if (options.config) {
    mkdirSync(join(directories[1]!, "hunk"), { recursive: true });
    writeFileSync(join(directories[1]!, "hunk", "config.toml"), options.config);
  }
  const reviewArgs = repo
    ? ["diff", "--staged", "--agent-context", reviewOrderSidecarPath(repo)]
    : ["patch", input];
  const hunkCommand = (args: readonly string[]) =>
    COMPILED_EXECUTABLE ? [COMPILED_EXECUTABLE, ...args] : [BUN, SOURCE_ENTRYPOINT, ...args];
  // `--web` opens a browser and watches the input by default; a test drives its own browser
  // and its own reloads, so it asks for neither.
  const [sessionCommand, ...sessionArgs] = hunkCommand([
    ...reviewArgs,
    ...(options.args ?? []),
    "--web",
    "--no-open",
    "--no-watch",
  ]);
  const session = spawn(sessionCommand!, sessionArgs, {
    cwd: repo ?? REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  processes.push(session);
  const url = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: session.stdout! });
    lines.once("line", (line) => resolve(line.trim()));
    session.once("exit", (code) => reject(new Error(`The review session exited (${code}).`)));
  });
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

  const hunk = (args: readonly string[], input?: string) => {
    const [command, ...rest] = hunkCommand(args);
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command!, rest, { cwd: repo ?? REPO_ROOT, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve(stdout)
          : reject(new Error(`hunk ${args.join(" ")} exited ${code}: ${stderr.trim()}`)),
      );
      child.stdin.end(input ?? "");
    });
  };
  let generation = 0;
  const readApi = async (kind: "publication" | "state") => {
    const response = await fetch(
      `${origin}${reviewHttpPath({ kind, sessionId: route.sessionId })}`,
      { headers: { [HUNK_REVIEW_CAPABILITY_HEADER]: capability } },
    );
    return (await response.json()) as Record<string, unknown>;
  };

  return {
    url,
    origin,
    sessionId: route.sessionId,
    ...(repo ? { repo } : {}),
    hunk,
    readApi,
    async postAction(action, kind = "browser") {
      const publication = (await readApi("publication")).publication as { generation: string };
      return fetch(`${origin}${reviewHttpPath({ kind: "actions", sessionId: route.sessionId })}`, {
        method: "POST",
        headers: {
          [HUNK_REVIEW_CAPABILITY_HEADER]: capability,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
          generation: publication.generation,
          actor: { clientId: `test-${kind}`, kind },
          action,
        }),
      });
    },
    async reload() {
      if (!repo) throw new Error("Only the git-backed scenarios reload.");
      generation += 1;
      writeRichReviewGeneration(repo, generation);
      await hunk(["session", "reload", route.sessionId, "--", ...reviewArgs]);
    },
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

/** Record CSP violations, console errors and warnings, page errors, and failed requests. */
export async function watchTestPageProblems(page: Page) {
  const problems: string[] = [];
  // The page's focus report (`selection/anchor`) is best effort: one sent as the session
  // reloads is refused for its old generation (409) or while the session is busy (502), and
  // the page drops it. Chromium still logs the refused response, so exactly one such console
  // line is excused per refused POST to the actions route, whichever event arrives first.
  const refusal = (status: number) =>
    `console error: Failed to load resource: the server responded with a status of ${status} (${status === 409 ? "Conflict" : "Bad Gateway"})`;
  const excused: number[] = [];
  page.on("response", (response) => {
    const status = response.status();
    const request = response.request();
    if (
      (status !== 409 && status !== 502) ||
      request.method() !== "POST" ||
      !new URL(response.url()).pathname.endsWith("/actions")
    ) {
      return;
    }
    const logged = problems.indexOf(refusal(status));
    if (logged >= 0) problems.splice(logged, 1);
    else excused.push(status);
  });
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = `console ${message.type()}: ${message.text()}`;
    const status = excused.find((candidate) => refusal(candidate) === text);
    if (status !== undefined) {
      excused.splice(excused.indexOf(status), 1);
      return;
    }
    problems.push(text);
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText;
    // Aborted fetches are the client cancelling superseded work, not failures.
    if (failure === "net::ERR_ABORTED") return;
    problems.push(`request failed: ${request.url()} ${failure}`);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return problems;
}

/** Choose one theme through the toolbar's theme menu. */
export async function chooseTestTheme(page: Page, themeId: string) {
  await page.getByTestId("theme-picker").click();
  await page.locator(`[role="option"][data-theme-id="${themeId}"]`).click();
}
