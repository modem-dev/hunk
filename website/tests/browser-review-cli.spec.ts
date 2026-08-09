import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../..");
const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

interface IsolatedReviewEnvironment {
  root: string;
  port: number;
  env: NodeJS.ProcessEnv;
}

/** Quote one argument embedded in the Unix-only `script -c` test command. */
function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Strip terminal control records while retaining the cumulative PTY transcript. */
function stripTerminalControl(text: string) {
  return text
    .replace(/^Script started.*?\n/s, "")
    .replace(/\nScript done.*$/s, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

/** Poll a process/HTTP/UI condition without coupling assertions to renderer timing. */
async function waitUntil<T>(
  label: string,
  read: () => T | null | Promise<T | null>,
  timeout = 15_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Create one daemon/config namespace shared by a producer and session commands. */
async function createIsolatedReviewEnvironment(prefix: string): Promise<IsolatedReviewEnvironment> {
  const port = await reservePort();
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  const home = resolve(root, "home");
  const runtime = resolve(root, "runtime");
  mkdirSync(home, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  return {
    root,
    port,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: resolve(root, "config"),
      XDG_RUNTIME_DIR: runtime,
      HUNK_MCP_PORT: String(port),
    },
  };
}

/** Run a source session command against an isolated daemon. */
function runSessionCommand(environment: IsolatedReviewEnvironment, args: string[]) {
  const result = spawnSync("bun", ["run", "src/main.tsx", "session", ...args], {
    cwd: projectRoot,
    env: environment.env,
    encoding: "utf8",
  });
  return { ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Stop the auto-started isolated daemon after its producer has exited. */
async function stopDaemon(environment: IsolatedReviewEnvironment) {
  try {
    const health = (await (await fetch(`http://127.0.0.1:${environment.port}/health`)).json()) as {
      pid?: number;
    };
    if (health.pid) process.kill(health.pid, "SIGTERM");
  } catch {
    // The isolated daemon may already be gone.
  }
}

/** Initialize a tiny two-file Git review without shell-dependent command strings. */
function createGitReview(root: string) {
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.email", "browser-review@example.test"],
    ["config", "user.name", "Browser Review Test"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const alpha = resolve(root, "alpha.ts");
  const beta = resolve(root, "beta.ts");
  writeFileSync(alpha, "export const alpha = 1;\nexport const stable = true;\n");
  writeFileSync(beta, "export const beta = 1;\nexport const stable = true;\n");
  for (const args of [
    ["add", "alpha.ts", "beta.ts"],
    ["commit", "--quiet", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  writeFileSync(alpha, "export const alpha = 2;\nexport const stable = true;\n");
  writeFileSync(beta, "export const beta = 2;\nexport const stable = true;\n");
  return { alpha, beta };
}

/** Write a complete sidecar in one rename so watch never observes partial JSON. */
function writeSidecar(path: string, files: Array<{ path: string; summary: string; note: string }>) {
  const temporary = `${path}.next`;
  writeFileSync(
    temporary,
    JSON.stringify({
      version: 1,
      summary: "Watched browser review",
      files: files.map((file, index) => ({
        path: file.path,
        summary: file.summary,
        annotations: [
          {
            id: `watch-note-${index}`,
            newRange: [1, 1],
            summary: file.note,
            rationale: `Rationale for ${file.path}`,
            title: `Title for ${file.path}`,
            author: "Phase 9",
            createdAt: "2026-03-23T00:00:00.000Z",
            updatedAt: "2026-03-23T00:01:00.000Z",
            tags: ["watch", file.path],
            confidence: "high",
            source: "phase-9-e2e",
            editable: false,
          },
        ],
      })),
    }),
  );
  renameSync(temporary, path);
}

/** Reserve one loopback port for an isolated real producer and daemon. */
async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

/** Read the first complete capability URL printed by a long-lived CLI producer. */
function readCapabilityUrl(child: ChildProcessWithoutNullStreams) {
  return new Promise<string>((resolveUrl, reject) => {
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const line = stdout.split("\n")[0];
      if (line?.startsWith("http://")) resolveUrl(line);
    });
    child.once("exit", (code) => {
      reject(new Error(`Browser review producer exited ${code}: ${stderr}`));
    });
  });
}

/** Exercise the embedded production browser against one real source or compiled CLI process. */
async function smokeBrowserReview(page: Page, executable?: string) {
  const port = await reservePort();
  const root = mkdtempSync(resolve(tmpdir(), "hunk-browser-playwright-"));
  const home = resolve(root, "home");
  const runtime = resolve(root, "runtime");
  mkdirSync(home, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  const patchPath = resolve(root, "change.patch");
  writeFileSync(patchPath, patch);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: resolve(root, "config"),
    XDG_RUNTIME_DIR: runtime,
    HUNK_MCP_PORT: String(port),
  };
  const child = executable
    ? spawn(executable, ["patch", patchPath, "--web", "--no-open"], {
        cwd: root,
        env,
        stdio: "pipe",
      })
    : spawn("bun", ["run", "src/main.tsx", "patch", patchPath, "--web", "--no-open"], {
        cwd: projectRoot,
        env,
        stdio: "pipe",
      });

  try {
    const url = await readCapabilityUrl(child);
    await page.goto(url);
    await expect(page.locator(".web-review")).toBeVisible();
    await expect(page.locator("[data-file-key]")).toContainText("a.txt");
  } finally {
    child.kill();
    if (child.exitCode === null) {
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
    try {
      const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
        pid?: number;
      };
      if (health.pid) process.kill(health.pid);
    } catch {
      // The isolated daemon may already be gone after its producer exits.
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("source CLI serves a real synchronized browser review", async ({ page }) => {
  await smokeBrowserReview(page);
});

test("installed compiled CLI serves a real synchronized browser review", async ({ page }) => {
  test.skip(!process.env.HUNK_TEST_EXECUTABLE, "Set HUNK_TEST_EXECUTABLE to a built Hunk binary.");
  await smokeBrowserReview(page, resolve(process.env.HUNK_TEST_EXECUTABLE!));
});

test("web-only watch publishes one atomic generation and survives tab closure", async ({
  page,
}) => {
  const isolated = await createIsolatedReviewEnvironment("hunk-browser-watch-e2e-");
  const repo = resolve(isolated.root, "repo");
  mkdirSync(repo);
  const { alpha, beta } = createGitReview(repo);
  const sidecar = resolve(repo, ".hunk-agent.json");
  writeFileSync(resolve(repo, ".git", "info", "exclude"), ".hunk-agent.json\n");
  writeSidecar(sidecar, [
    { path: basename(alpha), summary: "Alpha first", note: "Initial alpha note" },
    { path: basename(beta), summary: "Beta second", note: "Initial beta note" },
  ]);
  const child = spawn(
    "bun",
    [
      "run",
      resolve(projectRoot, "src/main.tsx"),
      "diff",
      "--watch",
      "--web",
      "--no-open",
      "--agent-context",
      sidecar,
      "--agent-notes",
    ],
    { cwd: repo, env: isolated.env, stdio: "pipe" },
  );

  try {
    const url = await readCapabilityUrl(child);
    await page.goto(url);
    await expect(page.locator(".web-review")).toHaveAttribute("data-connection", "connected");
    const initialGeneration = await page
      .locator("[data-file-key]")
      .first()
      .getAttribute("data-resource-key")
      .then((key) => key?.split(":canonical:")[0]);
    await expect(page.locator("[data-review-stream] > [data-file-key]")).toHaveCount(2);

    writeFileSync(beta, "export const beta = 3;\nexport const watchedReplacement = true;\n");
    writeSidecar(sidecar, [
      { path: basename(beta), summary: "Beta now first", note: "Replacement beta note" },
      { path: basename(alpha), summary: "Alpha now second", note: "Replacement alpha note" },
    ]);

    await expect(page.locator("[data-review-stream] > [data-file-key]").first()).toHaveAttribute(
      "data-file-path",
      "beta.ts",
      { timeout: 15_000 },
    );
    await expect(page.getByText("Replacement beta note", { exact: true })).toBeVisible();
    await expect(page.getByText("Replacement alpha note", { exact: true })).toBeVisible();
    const atomic = await page.evaluate(async () => {
      const sessionId = location.pathname.split("/")[2]!;
      const response = await fetch(`/review-api/${encodeURIComponent(sessionId)}/snapshot`);
      const snapshot = (await response.json()) as {
        generation: string;
        manifest: {
          generation: string;
          files: Array<{ path: string }>;
          resources: Array<{ id: string }>;
        };
        state: { documentGeneration: string };
      };
      const resourceKeys = Array.from(
        document.querySelectorAll<HTMLElement>("[data-file-key]"),
        (entry) => entry.dataset.resourceKey ?? "",
      );
      return {
        snapshot,
        resourceKeys,
        resourceErrors: document.querySelectorAll(".review-file__state--error").length,
      };
    });
    expect(atomic.snapshot.generation).not.toBe(initialGeneration);
    expect(atomic.snapshot.manifest.generation).toBe(atomic.snapshot.generation);
    expect(atomic.snapshot.state.documentGeneration).toBe(atomic.snapshot.generation);
    expect(atomic.snapshot.manifest.files.map((file) => file.path)).toEqual([
      "beta.ts",
      "alpha.ts",
    ]);
    expect(
      atomic.resourceKeys.every((key) => key.startsWith(`${atomic.snapshot.generation}:`)),
    ).toBe(true);
    expect(atomic.resourceErrors).toBe(0);

    const sessionId = new URL(url).pathname.split("/")[2]!;
    const origin = new URL(url).origin;
    const staleResource = await page.request.get(
      `${origin}/review-api/${encodeURIComponent(sessionId)}/resources/${encodeURIComponent("generation:retired")}/${encodeURIComponent(atomic.snapshot.manifest.resources[0]!.id)}`,
      { headers: { range: "bytes=0-1" } },
    );
    expect(staleResource.status()).toBe(409);
    const rejectedOrigin = await page.request.post(
      `${origin}/review-api/${encodeURIComponent(sessionId)}/actions`,
      {
        headers: { origin: "https://attacker.invalid", "content-type": "application/json" },
        data: {
          generation: atomic.snapshot.generation,
          expectedStateRevision: 0,
          action: { type: "filter/set", filter: "attacker" },
        },
      },
    );
    expect(rejectedOrigin.status()).toBe(403);
    const rejectedHost = await page.request.get(
      `${origin}/review-api/${encodeURIComponent(sessionId)}/snapshot`,
      { headers: { host: "attacker.invalid" } },
    );
    expect(rejectedHost.status()).toBe(403);

    await page.close();
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    expect(child.exitCode).toBeNull();
    const reopened = runSessionCommand(isolated, ["open", sessionId, "--no-open"]);
    expect(reopened.status).toBe(0);
    expect(reopened.stdout.trim()).toBe(url);

    child.kill("SIGINT");
    await new Promise<void>((resolveExit, reject) => {
      const timeout = setTimeout(() => reject(new Error("Web-only watch ignored SIGINT.")), 5_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolveExit();
      });
    });
    expect(child.exitCode).toBe(0);
    await waitUntil("watched session cleanup", () => {
      const listed = runSessionCommand(isolated, ["list", "--json"]);
      if (listed.status !== 0) return null;
      const sessions = JSON.parse(listed.stdout) as { sessions: unknown[] };
      return sessions.sessions.length === 0 ? true : null;
    });
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) return resolveExit();
      child.once("exit", () => resolveExit());
    });
    await stopDaemon(isolated);
    rmSync(isolated.root, { recursive: true, force: true });
  }
});

test("one terminal-owned review synchronizes browser and session actions end to end", async ({
  page,
}) => {
  test.setTimeout(60_000);
  test.skip(process.platform === "win32", "PTY coverage is Unix-only.");
  const scriptProbe = spawnSync("script", ["-q", "-f", "-e", "-c", "exit 0", "/dev/null"]);
  test.skip(scriptProbe.status !== 0, "This test requires the util-linux script command.");

  const isolated = await createIsolatedReviewEnvironment("hunk-browser-terminal-e2e-");
  const repo = resolve(isolated.root, "repo");
  mkdirSync(repo);
  const { alpha, beta } = createGitReview(repo);
  const transcript = resolve(isolated.root, "terminal-transcript.txt");
  const terminalCommand = [
    "bun",
    "run",
    resolve(projectRoot, "src/main.tsx"),
    "diff",
    "--mode",
    "stack",
    "--agent-notes",
  ]
    .map(shellQuote)
    .join(" ");
  const terminal = spawn("script", ["-q", "-f", "-e", "-c", terminalCommand, transcript], {
    cwd: repo,
    env: { ...isolated.env, TERM: "xterm-256color", COLUMNS: "120", LINES: "24" },
    stdio: ["pipe", "ignore", "pipe"],
  });

  try {
    const session = await waitUntil("terminal session registration", () => {
      const listed = runSessionCommand(isolated, ["list", "--json"]);
      if (listed.status !== 0) return null;
      const parsed = JSON.parse(listed.stdout) as {
        sessions: Array<{ sessionId: string; files: Array<{ path: string }> }>;
      };
      return parsed.sessions.find((candidate) => candidate.files.length === 2) ?? null;
    });
    const opened = runSessionCommand(isolated, ["open", session.sessionId, "--no-open"]);
    expect(opened.status).toBe(0);
    const url = opened.stdout.trim();
    expect(url).toContain("#capability=");
    await page.goto(url);
    await expect(page.locator(".web-review")).toHaveAttribute("data-connection", "connected");
    await expect(page.locator("[data-review-stream] > [data-file-key]")).toHaveCount(2);

    const navigate = runSessionCommand(isolated, [
      "navigate",
      session.sessionId,
      "--file",
      basename(beta),
      "--hunk",
      "1",
      "--json",
    ]);
    expect(navigate.status).toBe(0);
    await expect
      .poll(async () => {
        return page.evaluate(async () => {
          const sessionId = location.pathname.split("/")[2]!;
          const response = await fetch(`/review-api/${encodeURIComponent(sessionId)}/snapshot`);
          const snapshot = (await response.json()) as { state: { selection: { fileKey: string } } };
          const betaKey = document.querySelector<HTMLElement>('[data-file-path="beta.ts"]')?.dataset
            .fileKey;
          return snapshot.state.selection.fileKey === betaKey;
        });
      })
      .toBe(true);

    const comment = runSessionCommand(isolated, [
      "comment",
      "add",
      session.sessionId,
      "--file",
      basename(beta),
      "--new-line",
      "1",
      "--summary",
      "Agent session note",
      "--rationale",
      "Visible in both renderers",
      "--focus",
      "--json",
    ]);
    expect(comment.status).toBe(0);
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const sessionId = location.pathname.split("/")[2]!;
          const response = await fetch(`/review-api/${encodeURIComponent(sessionId)}/snapshot`);
          const snapshot = (await response.json()) as {
            state: { notes: Array<{ summary: string }> };
          };
          return snapshot.state.notes.map((note) => note.summary);
        }),
      )
      .toContain("Agent session note");
    await page.reload();
    await expect(page.locator(".web-review")).toHaveAttribute("data-connection", "connected");
    const showAgentNotes = page.getByRole("button", { name: "Show agent notes" });
    if (await showAgentNotes.isVisible()) await showAgentNotes.click();
    await expect(page.getByText("Agent session note", { exact: true })).toBeVisible();
    await waitUntil("agent note in terminal", () => {
      const text = stripTerminalControl(readFileSync(transcript, "utf8"));
      return text.includes("Agent session note") && text.includes("Visible in both renderers")
        ? text
        : null;
    });

    writeFileSync(alpha, "export const alpha = 3;\nexport const reloadedInBrowser = true;\n");
    const reload = runSessionCommand(isolated, [
      "reload",
      session.sessionId,
      "--json",
      "--",
      "diff",
    ]);
    expect(reload.status).toBe(0);
    await expect(
      page.getByText("export const reloadedInBrowser = true;", { exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("[data-review-stream] > [data-file-key]")).toHaveCount(2);

    await page.getByLabel("Add review note").getByRole("textbox").fill("Browser to terminal note");
    await page.getByRole("button", { name: /Add note/ }).click();
    await expect(page.getByText("Browser to terminal note", { exact: true })).toBeVisible();
    const review = await waitUntil("browser note in broker review export", () => {
      const exported = runSessionCommand(isolated, [
        "review",
        session.sessionId,
        "--include-notes",
        "--json",
      ]);
      if (exported.status !== 0 || !exported.stdout.includes("Browser to terminal note"))
        return null;
      return exported.stdout;
    });
    expect(review).toContain("Browser to terminal note");
    const browserNote = (
      JSON.parse(review) as {
        review: {
          reviewNotes: Array<{ body: string; filePath: string; hunkIndex?: number }>;
        };
      }
    ).review.reviewNotes.find((note) => note.body === "Browser to terminal note");
    expect(browserNote).toBeDefined();
    const revealBrowserNote = runSessionCommand(isolated, [
      "navigate",
      session.sessionId,
      "--file",
      browserNote!.filePath,
      "--hunk",
      String((browserNote!.hunkIndex ?? 0) + 1),
      "--json",
    ]);
    expect(revealBrowserNote.status).toBe(0);
    const terminalContext = runSessionCommand(isolated, ["context", session.sessionId, "--json"]);
    expect(terminalContext.status).toBe(0);
    expect(JSON.parse(terminalContext.stdout)).toMatchObject({
      context: { selectedFile: { path: browserNote!.filePath } },
    });
    const browserNoteTranscript = await waitUntil("browser-created note in live terminal", () => {
      const text = stripTerminalControl(readFileSync(transcript, "utf8"));
      return text.replaceAll(/\s/g, "").includes("Browsertoterminalnote") ? text : null;
    });
    expect(browserNoteTranscript.replaceAll(/\s/g, "")).toContain("Browsertoterminalnote");

    const streamPaths = await page
      .locator("[data-review-stream] > [data-file-key]")
      .evaluateAll((entries) => entries.map((entry) => (entry as HTMLElement).dataset.filePath));
    expect(streamPaths).toEqual(["alpha.ts", "beta.ts"]);

    terminal.stdin.write("q");
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    if (terminal.exitCode === null) terminal.stdin.write("q");
    await new Promise<void>((resolveExit, reject) => {
      if (terminal.exitCode !== null) return resolveExit();
      const timeout = setTimeout(() => reject(new Error("Terminal review did not exit.")), 5_000);
      terminal.once("exit", () => {
        clearTimeout(timeout);
        resolveExit();
      });
    });
    expect(terminal.exitCode).toBe(0);
    await expect(page.getByText("Review disconnected", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    if (terminal.exitCode === null) terminal.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      if (terminal.exitCode !== null) return resolveExit();
      terminal.once("exit", () => resolveExit());
    });
    await stopDaemon(isolated);
    rmSync(isolated.root, { recursive: true, force: true });
  }
});
