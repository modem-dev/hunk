import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const executable = process.env.HUNK_TEST_EXECUTABLE
  ? resolve(process.env.HUNK_TEST_EXECUTABLE)
  : undefined;
const compiledTest = executable ? test : test.skip;
const compiledLinuxTest = executable && process.platform === "linux" ? test : test.skip;
const compiledUnixTest = executable && process.platform !== "win32" ? test : test.skip;
const BUN_NATIVE_ARTIFACT_PATTERN = /^\.[0-9a-f]{16}-[0-9a-f]{8}\.(?:so|dylib|dll)$/;
const positiveControlBuildRoot = executable
  ? mkdtempSync(resolve(tmpdir(), "hunk-compiled-opentui-control-"))
  : undefined;
const positiveControlExecutable = positiveControlBuildRoot
  ? resolve(
      positiveControlBuildRoot,
      process.platform === "win32" ? "opentui-control.exe" : "opentui-control",
    )
  : undefined;

let rootsToClean: string[] = [];

beforeAll(() => {
  if (!positiveControlExecutable) {
    return;
  }

  const source = resolve(import.meta.dir, "fixtures", "compiled-opentui-positive-control.ts");
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-bunfig",
      source,
      "--outfile",
      positiveControlExecutable,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (build.exitCode !== 0) {
    throw new Error(
      `Failed to build the OpenTUI positive control: ${Buffer.from(build.stderr).toString("utf8")}`,
    );
  }
});

afterAll(() => {
  if (positiveControlBuildRoot) {
    rmSync(positiveControlBuildRoot, { recursive: true, force: true });
  }
});

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
  // Calibrate the platform temp path and filename matcher before trusting negative assertions.
  compiledTest("detects extraction from an eager OpenTUI positive control", () => {
    const { env, temp } = createTestEnvironment();
    const proc = Bun.spawnSync([positiveControlExecutable!], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(nativeArtifacts(temp).length).toBeGreaterThan(0);
  });

  compiledTest(
    "does not extract OpenTUI for short-lived headless commands",
    () => {
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
      // Cold compiled binaries on macOS may need more than Bun's default 5 seconds.
    },
    15_000,
  );

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

  compiledUnixTest(
    "opens compiled web reviews without printing bearer capabilities",
    async () => {
      const port = await reserveFreePort();
      const { env, temp } = createTestEnvironment(port);
      const patchPath = resolve(temp, "default-open.patch");
      const bin = resolve(temp, "bin");
      const openedUrlPath = resolve(temp, "opened-url.txt");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        patchPath,
        "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
      );
      const opener = resolve(bin, process.platform === "darwin" ? "open" : "xdg-open");
      writeFileSync(opener, '#!/bin/sh\nprintf "%s" "$1" > "$HUNK_TEST_BROWSER_OUTPUT"\n');
      chmodSync(opener, 0o755);
      const review = Bun.spawn([executable!, "patch", patchPath, "--web"], {
        env: {
          ...env,
          HUNK_TEST_BROWSER_OUTPUT: openedUrlPath,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline && !existsSync(openedUrlPath)) await Bun.sleep(50);
        const url = readFileSync(openedUrlPath, "utf8");
        expect(url).toContain("#capability=");
        const sessionId = new URL(url).pathname.split("/")[2]!;
        rmSync(openedUrlPath, { force: true });
        const sessionOpen = Bun.spawnSync([executable!, "session", "open", sessionId], {
          env: {
            ...env,
            HUNK_TEST_BROWSER_OUTPUT: openedUrlPath,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const sessionStdout = Buffer.from(sessionOpen.stdout).toString("utf8");
        const sessionStderr = Buffer.from(sessionOpen.stderr).toString("utf8");
        expect(sessionOpen.exitCode).toBe(0);
        expect(sessionStdout).toBe("Browser review opened.\n");
        expect(`${sessionStdout}${sessionStderr}`).not.toContain("capability=");
        expect(readFileSync(openedUrlPath, "utf8")).toBe(url);

        await Bun.sleep(100);
        review.kill("SIGTERM");
        await review.exited;
        const stdout = await new Response(review.stdout).text();
        const stderr = await new Response(review.stderr).text();
        expect(stdout).toBe("Browser review opened.\n");
        expect(`${stdout}${stderr}`).not.toContain("capability=");
        expect(nativeArtifacts(temp)).toEqual([]);
      } finally {
        if (review.exitCode === null) {
          review.kill("SIGTERM");
          await review.exited;
        }
        try {
          const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
            pid?: number;
          };
          if (health.pid) process.kill(health.pid, "SIGTERM");
        } catch {
          // The isolated daemon may already have stopped with its last producer.
        }
      }
    },
    15_000,
  );

  compiledTest(
    "keeps a live web-only review OpenTUI-free",
    async () => {
      const port = await reserveFreePort();
      const { env, temp } = createTestEnvironment(port);
      const patchPath = resolve(temp, "change.patch");
      writeFileSync(
        patchPath,
        "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
      );
      const review = Bun.spawn([executable!, "patch", patchPath, "--web", "--no-open"], {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        await waitForDaemon(port);
        const deadline = Date.now() + 8_000;
        let sessions = 0;
        while (Date.now() < deadline) {
          const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
            sessions?: number;
          };
          sessions = health.sessions ?? 0;
          if (sessions > 0) break;
          await Bun.sleep(50);
        }
        expect(sessions).toBe(1);
        expect(nativeArtifacts(temp)).toEqual([]);
      } finally {
        review.kill("SIGTERM");
        await review.exited;
        try {
          const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
            pid?: number;
          };
          if (health.pid) process.kill(health.pid, "SIGTERM");
        } catch {
          // The isolated daemon may already have stopped with its last producer.
        }
      }
    },
    15_000,
  );

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
