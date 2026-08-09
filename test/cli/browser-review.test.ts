import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const processes: Bun.Subprocess[] = [];
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

/** Reserve one local port without relying on a fixed developer-machine daemon. */
async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Create isolated daemon metadata and config roots for one CLI producer. */
function createEnvironment(port: number) {
  const root = mkdtempSync(join(tmpdir(), "hunk-browser-cli-"));
  roots.push(root);
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  mkdirSync(home, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  return {
    root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_RUNTIME_DIR: runtime,
      HUNK_MCP_PORT: String(port),
    },
  };
}

/** Read one expected output line while leaving the long-lived producer running. */
async function readOutputLine(
  process: Bun.Subprocess,
  accepts: (line: string) => boolean,
  timeoutMs = 10_000,
) {
  const reader = (process.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    let pending = reader.read();
    while (Date.now() < deadline) {
      const result = await Promise.race([pending, Bun.sleep(250).then(() => null)]);
      if (!result) continue;
      if (result.value) text += decoder.decode(result.value, { stream: true });
      const line = text.split("\n")[0];
      if (line && accepts(line)) return line;
      if (result.done) break;
      pending = reader.read();
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`Timed out waiting for browser output; output was ${JSON.stringify(text)}.`);
}

/** Read the capability URL printed only by explicit --no-open mode. */
function readUrl(process: Bun.Subprocess, timeoutMs = 10_000) {
  return readOutputLine(process, (line) => line.startsWith("http://"), timeoutMs);
}

/** Install a Unix test opener that records its argument without leaking it to process output. */
function installTestOpener(root: string, env: Record<string, string | undefined>) {
  const bin = join(root, "bin");
  const output = join(root, "opened-url.txt");
  mkdirSync(bin, { recursive: true });
  const command = join(bin, process.platform === "darwin" ? "open" : "xdg-open");
  writeFileSync(command, '#!/bin/sh\nprintf "%s" "$1" > "$HUNK_TEST_BROWSER_OUTPUT"\n');
  chmodSync(command, 0o755);
  return {
    output,
    env: {
      ...env,
      HUNK_TEST_BROWSER_OUTPUT: output,
      PATH: `${bin}:${env.PATH ?? ""}`,
    },
  };
}

/** Stop the detached auto-started daemon belonging to this isolated port. */
async function stopDaemon(port: number) {
  try {
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      pid?: number;
    };
    if (health.pid) process.kill(health.pid, "SIGTERM");
  } catch {
    // The producer or daemon may already have completed cleanup.
  }
}

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("browser review CLI", () => {
  test("reports flag misuse and disabled brokering without terminal takeover", () => {
    const misuse = Bun.spawnSync(["bun", "run", "src/main.tsx", "diff", "--no-open"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(misuse.exitCode).toBe(1);
    expect(Buffer.from(misuse.stderr).toString("utf8")).toContain("`--no-open` requires `--web`");

    const disabled = Bun.spawnSync(
      ["bun", "run", "src/main.tsx", "session", "open", "missing", "--no-open"],
      {
        cwd: process.cwd(),
        env: { ...process.env, HUNK_MCP_DISABLE: "1" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(disabled.exitCode).toBe(1);
    expect(Buffer.from(disabled.stderr).toString("utf8")).toContain(
      "Browser review requires the local Hunk session daemon",
    );
  });

  const defaultOpenTest = process.platform === "win32" ? test.skip : test;
  defaultOpenTest(
    "default web and session open never print bearer capabilities",
    async () => {
      const port = await reservePort();
      const isolated = createEnvironment(port);
      const patchPath = join(isolated.root, "default-open.patch");
      writeFileSync(patchPath, PATCH);
      const opener = installTestOpener(isolated.root, isolated.env);
      const child = Bun.spawn(["bun", "run", "src/main.tsx", "patch", patchPath, "--web"], {
        cwd: process.cwd(),
        env: opener.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      processes.push(child);

      const confirmation = await readOutputLine(child, (line) => line === "Browser review opened.");
      expect(confirmation).toBe("Browser review opened.");
      expect(confirmation).not.toContain("capability=");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !existsSync(opener.output)) await Bun.sleep(50);
      const url = readFileSync(opener.output, "utf8");
      expect(url).toContain("#capability=");
      const sessionId = new URL(url).pathname.split("/")[2]!;

      rmSync(opener.output, { force: true });
      const opened = Bun.spawnSync(["bun", "run", "src/main.tsx", "session", "open", sessionId], {
        cwd: process.cwd(),
        env: opener.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const openStdout = Buffer.from(opened.stdout).toString("utf8");
      const openStderr = Buffer.from(opened.stderr).toString("utf8");
      expect(opened.exitCode).toBe(0);
      expect(openStdout).toBe("Browser review opened.\n");
      expect(`${openStdout}${openStderr}`).not.toContain("capability=");
      expect(readFileSync(opener.output, "utf8")).toBe(url);

      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      const producerStderr = await new Response(child.stderr).text();
      expect(producerStderr).not.toContain("capability=");
      await stopDaemon(port);
    },
    20_000,
  );

  test.each([
    ["patch file", false],
    ["static stdin patch", true],
  ])(
    "publishes %s without mounting terminal chrome",
    async (_label, stdinPatch) => {
      const port = await reservePort();
      const { root, env } = createEnvironment(port);
      const patchPath = join(root, "change.patch");
      writeFileSync(patchPath, PATCH);
      const args = [
        "bun",
        "run",
        "src/main.tsx",
        "patch",
        stdinPatch ? "-" : patchPath,
        "--web",
        "--no-open",
      ];
      const child = Bun.spawn(args, {
        cwd: process.cwd(),
        env,
        stdin: stdinPatch ? Buffer.from(PATCH) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      processes.push(child);

      const url = await readUrl(child);
      expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/review/[^/]+/#capability=`));
      const shell = await fetch(url);
      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain('<div id="app" aria-live="polite"></div>');

      const sessionId = new URL(url).pathname.split("/")[2]!;
      const listed = Bun.spawnSync(["bun", "run", "src/main.tsx", "session", "list"], {
        cwd: process.cwd(),
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const listText = Buffer.from(listed.stdout).toString("utf8");
      expect(listed.exitCode).toBe(0);
      expect(listText).toContain(sessionId);
      expect(listText).not.toContain("capability=");
      expect(listText).not.toContain("browserReviewCapabilityHash");

      const opened = Bun.spawnSync(
        ["bun", "run", "src/main.tsx", "session", "open", sessionId, "--no-open"],
        { cwd: process.cwd(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      expect(opened.exitCode).toBe(0);
      expect(Buffer.from(opened.stdout).toString("utf8").trim()).toBe(url);

      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      await stopDaemon(port);
    },
    20_000,
  );

  test("keeps a watched web-only owner alive until SIGTERM", async () => {
    const port = await reservePort();
    const { root, env } = createEnvironment(port);
    const patchPath = join(root, "watched.patch");
    writeFileSync(patchPath, PATCH);
    const child = Bun.spawn(
      ["bun", "run", "src/main.tsx", "patch", patchPath, "--watch", "--web", "--no-open"],
      { cwd: process.cwd(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    processes.push(child);

    await readUrl(child);
    await Bun.sleep(100);
    expect(child.exitCode).toBeNull();
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    await stopDaemon(port);
  }, 20_000);
});
