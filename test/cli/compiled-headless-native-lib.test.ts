import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const executable = process.env.HUNK_TEST_EXECUTABLE
  ? resolve(process.env.HUNK_TEST_EXECUTABLE)
  : undefined;
const compiledTest = executable ? test : test.skip;
const compiledLinuxTest = executable && process.platform === "linux" ? test : test.skip;
const BUN_NATIVE_ARTIFACT_PATTERN =
  /^(?:\.[0-9a-f]{16}-[0-9a-f]{8}|\.bun-\d+-[0-9a-f]{16})\.(?:so|dylib|dll)$/;
const positiveControlBuildRoot = executable
  ? mkdtempSync(resolve(tmpdir(), "hunk-compiled-opentui-control-"))
  : undefined;
const positiveControlExecutable = positiveControlBuildRoot
  ? resolve(
      positiveControlBuildRoot,
      process.platform === "win32" ? "opentui-control.exe" : "opentui-control",
    )
  : undefined;
const highlightWorkerControlExecutable = positiveControlBuildRoot
  ? resolve(
      positiveControlBuildRoot,
      process.platform === "win32" ? "highlight-worker-control.exe" : "highlight-worker-control",
    )
  : undefined;

let rootsToClean: string[] = [];

/** Builds the compiled controls that calibrate native-library assertions. */
function buildCompiledControls() {
  if (!positiveControlExecutable || !highlightWorkerControlExecutable) {
    return;
  }

  const controls = [
    {
      name: "OpenTUI positive control",
      entries: [resolve(import.meta.dir, "fixtures", "compiled-opentui-positive-control.ts")],
      executable: positiveControlExecutable,
      root: undefined,
    },
    {
      name: "highlight worker control",
      entries: [
        resolve(import.meta.dir, "fixtures", "compiled-highlight-worker-control.ts"),
        resolve(import.meta.dir, "..", "..", "packages", "hunk", "src", "highlightWorkerEntry.ts"),
      ],
      executable: highlightWorkerControlExecutable,
      root: resolve(import.meta.dir, "..", "..", "packages", "hunk", "src"),
    },
  ];

  for (const control of controls) {
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-bunfig",
        ...(control.root ? ["--root", control.root] : []),
        ...control.entries,
        "--outfile",
        control.executable,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (build.exitCode !== 0) {
      throw new Error(
        `Failed to build the ${control.name}: ${Buffer.from(build.stderr).toString("utf8")}`,
      );
    }
  }
}

// Two cold Bun compilations can exceed the default 5s hook deadline on hosted Windows runners.
beforeAll(buildCompiledControls, { timeout: 15_000 });

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
  const config = resolve(root, "config");
  const runtime = resolve(root, "runtime");
  const temp = resolve(root, "tmp");
  for (const dir of [home, cache, config, runtime, temp]) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    config,
    home,
    temp,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: config,
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

  compiledTest("starts its embedded highlight worker entrypoint", () => {
    const { env } = createTestEnvironment();
    const proc = Bun.spawnSync([highlightWorkerControlExecutable!], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(Buffer.from(proc.stderr).toString("utf8")).toBe("");
    expect(proc.exitCode).toBe(0);
    expect(Buffer.from(proc.stdout).toString("utf8")).toContain(
      process.platform === "win32"
        ? "compiled highlight worker disabled"
        : "compiled highlight worker ready",
    );
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

  compiledTest("keeps a non-UI extension CLI command OpenTUI-free", () => {
    const { env, temp } = createTestEnvironment();
    const extensionPath = resolve(temp, "headless-cli.ts");
    writeFileSync(
      extensionPath,
      `export default function (hunk) {
  hunk.registerCliCommand({ name: "headless-probe", summary: "Probe" }, async (_args, ctx) => {
    await ctx.stdout.write("ok\\n");
    return { kind: "exit" };
  });
}\n`,
    );

    const proc = Bun.spawnSync([executable!, "--extension", extensionPath, "headless-probe"], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(Buffer.from(proc.stdout).toString("utf8")).toBe("ok\n");
    expect(Buffer.from(proc.stderr).toString("utf8")).toBe("");
    expect(nativeArtifacts(temp)).toEqual([]);
  });

  compiledTest("discovers the installed-shape GitHub extension for literal hunk gh", () => {
    const { config, env, temp } = createTestEnvironment();
    const installedPath = resolve(config, "hunk", "extensions", "github-pr");
    mkdirSync(resolve(config, "hunk", "extensions"), { recursive: true });
    cpSync(resolve(import.meta.dir, "../../examples/extensions/github-pr"), installedPath, {
      recursive: true,
    });

    const proc = Bun.spawnSync([executable!, "gh", "--help"], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(Buffer.from(proc.stderr).toString("utf8")).toBe("");
    expect(Buffer.from(proc.stdout).toString("utf8")).toContain("Usage: hunk gh");
    expect(nativeArtifacts(temp)).toEqual([]);
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
