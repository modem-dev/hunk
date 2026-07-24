import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const executable = process.env.HUNK_TEST_EXECUTABLE
  ? resolve(process.env.HUNK_TEST_EXECUTABLE)
  : undefined;
const compiledTest = executable ? test : test.skip;
const compiledLinuxTest = executable && process.platform === "linux" ? test : test.skip;
const BUN_NATIVE_ARTIFACT_PATTERN = /^\.[0-9a-f]{16}-[0-9a-f]{8}\.(?:so|dylib|dll)$/;

let rootsToClean: string[] = [];

afterEach(() => {
  for (const root of rootsToClean) {
    rmSync(root, { recursive: true, force: true });
  }
  rootsToClean = [];
});

/** Create isolated home, cache, runtime, and temp directories for one compiled-binary test. */
function createTestEnvironment(port?: number) {
  const root = mkdtempSync(resolve(tmpdir(), "hunk-compiled-headless-test-"));
  rootsToClean.push(root);
  const home = resolve(root, "home");
  const cache = resolve(root, "cache");
  const runtime = resolve(root, "runtime");
  const temp = resolve(root, "tmp");
  for (const dir of [home, cache, runtime, temp]) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    temp,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: cache,
      XDG_RUNTIME_DIR: runtime,
      TMPDIR: temp,
      BUN_TMPDIR: temp,
      TEMP: temp,
      TMP: temp,
      ...(port === undefined ? {} : { HUNK_MCP_PORT: String(port) }),
    },
  };
}

/** Return Bun's hidden native-library extraction artifacts from an isolated temp directory. */
function nativeArtifacts(temp: string) {
  return readdirSync(temp).filter((name) => BUN_NATIVE_ARTIFACT_PATTERN.test(name));
}

/** Quote one path for the Bash command used to provide file-backed pager stdin. */
function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Reserve and release one loopback port for the compiled daemon test. */
async function reserveFreePort() {
  const listener = createServer(() => undefined);
  await new Promise<void>((resolveListen, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolveListen);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolveClose) => listener.close(() => resolveClose()));
  return port;
}

/** Wait until the compiled session daemon responds to its health endpoint. */
async function waitForDaemon(port: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // The daemon may still be binding its loopback listener.
    }
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for the compiled Hunk daemon.");
}

describe("compiled headless native-library loading", () => {
  compiledTest("does not extract OpenTUI for short-lived headless commands", () => {
    const { env, temp } = createTestEnvironment();
    const commands: Array<{ args: string[]; stdin?: string }> = [
      { args: ["--help"] },
      { args: ["--version"] },
      { args: ["session", "--help"] },
      { args: ["skill", "path"] },
      { args: ["markup", "guide"] },
      { args: ["markup", "render", "-"], stdin: "<text>Hello</text>\n" },
      { args: ["pager"], stdin: "plain pager text\n" },
      {
        args: ["pager"],
        stdin: "diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
      },
    ];

    for (const command of commands) {
      const proc = Bun.spawnSync([executable!, ...command.args], {
        env,
        stdin: command.stdin === undefined ? "ignore" : Buffer.from(command.stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(0);
      expect(nativeArtifacts(temp)).toEqual([]);
    }
  });

  compiledLinuxTest("keeps captured-host static pager rendering OpenTUI-free", () => {
    const { env, temp } = createTestEnvironment();
    const patch =
      "diff --git a/a.txt b/a.txt\nindex 7898192..6178079 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const proc = Bun.spawnSync(
      ["script", "-qec", `${shellQuote(executable!)} pager`, "/dev/null"],
      {
        env: {
          ...env,
          TERM: "dumb",
          LAZYGIT_CONFIG_DIR: temp,
        },
        stdin: Buffer.from(patch),
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(proc.exitCode).toBe(0);
    expect(Buffer.from(proc.stdout).toString("utf8")).toContain("a.txt");
    expect(nativeArtifacts(temp)).toEqual([]);
  });

  compiledTest("keeps the daemon and session polling paths OpenTUI-free", async () => {
    const port = await reserveFreePort();
    const { env, temp } = createTestEnvironment(port);
    const daemon = Bun.spawn([executable!, "daemon", "serve"], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      await waitForDaemon(port);
      const sessionList = Bun.spawnSync([executable!, "session", "list"], {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(sessionList.exitCode).toBe(0);
      expect(Buffer.from(sessionList.stdout).toString("utf8")).toContain(
        "No active Hunk sessions.",
      );
      expect(nativeArtifacts(temp)).toEqual([]);
    } finally {
      daemon.kill("SIGTERM");
      await daemon.exited;
    }
  });
});
