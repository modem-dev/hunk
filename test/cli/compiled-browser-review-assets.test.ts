import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTestSessionRegistration,
  createTestSessionSnapshot,
} from "../helpers/session-daemon-fixtures";

const sourceExecutable = process.env.HUNK_TEST_EXECUTABLE
  ? path.resolve(process.env.HUNK_TEST_EXECUTABLE)
  : undefined;
const compiledTest = sourceExecutable ? test : test.skip;
let cleanupRoot: string | undefined;
let daemon: ReturnType<typeof Bun.spawn> | undefined;

/** Reserve one loopback port for the standalone daemon smoke test. */
async function reserveLoopbackPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

/** Poll one route until the compiled daemon accepts requests. */
async function waitForDaemon(origin: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Startup races are expected while the standalone executable binds.
    }
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for compiled browser-review daemon.");
}

/** Open and register one producer session against the compiled daemon. */
async function registerSession(origin: string, capability: string) {
  const socket = new WebSocket(origin.replace(/^http/, "ws") + "/session");
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Session socket failed.")), {
      once: true,
    });
  });
  const registration = createTestSessionRegistration({ sessionId: "compiled-session" });
  registration.info.browserReviewCapabilityHash = createHash("sha256")
    .update(capability)
    .digest("hex");
  socket.send(
    JSON.stringify({
      type: "register",
      registration,
      snapshot: createTestSessionSnapshot(),
    }),
  );
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const health = (await (await fetch(`${origin}/health`)).json()) as { sessions: number };
    if (health.sessions === 1) return socket;
    await Bun.sleep(20);
  }
  socket.close();
  throw new Error("Compiled daemon did not register the test session.");
}

afterEach(async () => {
  if (daemon) {
    daemon.kill("SIGTERM");
    await daemon.exited;
    daemon = undefined;
  }
  if (cleanupRoot) {
    rmSync(cleanupRoot, { recursive: true, force: true });
    cleanupRoot = undefined;
  }
});

compiledTest(
  "standalone compiled binary serves embedded browser assets from an empty cwd",
  async () => {
    cleanupRoot = mkdtempSync(path.join(tmpdir(), "hunk-compiled-browser-assets-"));
    const cwd = path.join(cleanupRoot, "empty-cwd");
    const binDir = path.join(cleanupRoot, "isolated-bin");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const executable = path.join(binDir, process.platform === "win32" ? "hunk.exe" : "hunk");
    copyFileSync(sourceExecutable!, executable);
    const port = await reserveLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    daemon = Bun.spawn([executable, "daemon", "serve"], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HUNK_MCP_HOST: "127.0.0.1",
        HUNK_MCP_PORT: String(port),
        HUNK_INTERNAL_ENABLE_BROWSER_REVIEW: "1",
        HOME: path.join(cleanupRoot, "home"),
        USERPROFILE: path.join(cleanupRoot, "home"),
        XDG_CACHE_HOME: path.join(cleanupRoot, "cache"),
      },
    });
    await waitForDaemon(origin);
    const socket = await registerSession(origin, "compiled-capability");
    try {
      for (const [asset, contentType, marker] of [
        ["", "text/html", "./bootstrap.js"],
        ["bootstrap.js", "text/javascript", "history.replaceState"],
        ["review.css", "text/css", "color-scheme"],
      ] as const) {
        const response = await fetch(`${origin}/review/compiled-session/${asset}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toStartWith(contentType);
        const text = await response.text();
        expect(text).toContain(marker);
        if (asset !== "bootstrap.js") expect(text).not.toMatch(/https?:\/\//);
        else expect(text).not.toMatch(/(?:fetch|import)\s*\(\s*["']https?:\/\//);
      }
    } finally {
      socket.close();
    }
  },
);
