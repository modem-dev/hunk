import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../..");
const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

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
