import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const fixture = resolve(
  import.meta.dir,
  "../../../test/session-broker-runtime/bun-connection-fixture.ts",
);
const buildFixture = resolve(
  import.meta.dir,
  "../../../test/session-broker-runtime/bun-build-fixture.ts",
);
const pendingModes = [
  "pending-handshake",
  "pending-heartbeat",
  "pending-reconnect",
  "pending-client-startup-retry",
] as const;

interface FixtureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CapturedFixtureStream {
  readonly completed: Promise<void>;
  text(): string;
  cancel(): void;
}

interface BuildResult {
  success: boolean;
  rejected: string[];
  error?: string;
  logs?: string[];
}

/** Format one subprocess result with enough context to diagnose runtime exit failures. */
function formatFixtureFailure(
  runtime: string,
  mode: string,
  exit: number | "timeout" | "spawn-error",
  stdout: string,
  stderr: string,
) {
  return [
    `runtime=${runtime} mode=${mode} exit=${exit}`,
    `stdout:\n${stdout || "<empty>"}`,
    `stderr:\n${stderr || "<empty>"}`,
  ].join("\n");
}

/** Capture one child stream incrementally so hard-timeout failures retain partial output. */
function captureFixtureStream(stream: ReadableStream<Uint8Array>): CapturedFixtureStream {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let cancelled = false;
  const completed = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value, { stream: true });
      }
      output += decoder.decode();
    } catch (error) {
      if (!cancelled) throw error;
    }
  })();

  return {
    completed,
    text: () => output,
    cancel() {
      cancelled = true;
      void reader.cancel().catch(() => undefined);
    },
  };
}

/** Run one Bun subprocess with bounded soft/forced termination and retained transcript. */
async function runFixture(
  executable: string,
  mode: string,
  args: readonly string[],
): Promise<FixtureResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, executable, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = captureFixtureStream(child.stdout);
  const stderr = captureFixtureStream(child.stderr);
  let timedOut = false;
  let softKill = "not-requested";
  let forceKill = "not-requested";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let forceTimeout: ReturnType<typeof setTimeout> | undefined;
  let hardTimeout: ReturnType<typeof setTimeout> | undefined;

  const requestKill = (signal?: number) => {
    try {
      child.kill(signal);
      return "requested";
    } catch (error) {
      return `failed:${String(error)}`;
    }
  };
  const hardFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      softKill = requestKill();
      forceTimeout = setTimeout(() => {
        forceKill = requestKill(9);
        hardTimeout = setTimeout(() => {
          stdout.cancel();
          stderr.cancel();
          child.unref();
          reject(
            new Error(
              formatFixtureFailure("bun", mode, "timeout", stdout.text(), stderr.text()) +
                `\nsoftKill=${softKill} forceKill=${forceKill} child=unreaped`,
            ),
          );
        }, 500);
      }, 500);
    }, 3_000);
  });
  const completion = Promise.all([stdout.completed, stderr.completed, child.exited]).then(
    ([, , exitCode]) => ({ exitCode, stdout: stdout.text(), stderr: stderr.text() }),
  );

  try {
    const result = await Promise.race([completion, hardFailure]);
    if (timedOut) {
      throw new Error(
        formatFixtureFailure("bun", mode, "timeout", result.stdout, result.stderr) +
          `\nsoftKill=${softKill} forceKill=${forceKill}`,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("runtime=")) throw error;
    throw new Error(
      formatFixtureFailure("bun", mode, "spawn-error", stdout.text(), stderr.text()),
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceTimeout);
    clearTimeout(hardTimeout);
  }
}

/** Require one fixture mode to exit naturally with exactly its readiness marker. */
function expectFixtureSuccess(mode: string, result: FixtureResult, marker: string) {
  if (result.exitCode !== 0 || result.stdout !== marker || result.stderr !== "") {
    throw new Error(
      formatFixtureFailure("bun", mode, result.exitCode, result.stdout, result.stderr),
    );
  }
}

/** Build one entry in an isolated Bun process so a deliberately thrown canary cannot taint it. */
async function buildWithWsRejection(
  entrypoint: string,
  outdir: string,
  naming: string,
  target: "bun" | "node",
  mode: string,
) {
  const result = await runFixture(buildFixture, mode, [entrypoint, outdir, naming, target]);
  try {
    const report = JSON.parse(result.stdout) as BuildResult;
    return { result, report };
  } catch (error) {
    throw new Error(
      formatFixtureFailure("bun", mode, result.exitCode, result.stdout, result.stderr),
      { cause: error },
    );
  }
}

test("Bun authenticates, registers, and naturally exits with every production timer pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hunk-bun-connection-fixture-"));
  try {
    const probe = join(directory, "ws-probe.ts");
    await writeFile(probe, 'import WebSocket from "ws"; console.log(WebSocket);\n');
    const canary = await buildWithWsRejection(
      probe,
      join(directory, "probe"),
      "ws-probe.js",
      "node",
      "ws-canary-build",
    );
    if (
      canary.result.exitCode === 0 ||
      canary.result.stderr !== "" ||
      canary.report.success ||
      canary.report.rejected.join("\0") !== "ws"
    ) {
      throw new Error(
        formatFixtureFailure(
          "bun",
          "ws-canary-build",
          canary.result.exitCode,
          canary.result.stdout,
          canary.result.stderr,
        ),
      );
    }

    // Bun treats `ws` as a target-bun builtin before plugin resolution. Audit the exact fixture
    // graph under the canary-proven Node target first, then build a separate Bun bundle to execute.
    const audited = await buildWithWsRejection(
      fixture,
      join(directory, "graph-audit"),
      "bun-connection-fixture-audit.js",
      "node",
      "fixture-graph-audit",
    );
    if (
      audited.result.exitCode !== 0 ||
      audited.result.stderr !== "" ||
      !audited.report.success ||
      audited.report.rejected.length !== 0
    ) {
      throw new Error(
        formatFixtureFailure(
          "bun",
          "fixture-graph-audit",
          audited.result.exitCode,
          audited.result.stdout,
          audited.result.stderr,
        ),
      );
    }

    const bundle = join(directory, "bun-connection-fixture.js");
    const built = await buildWithWsRejection(
      fixture,
      directory,
      "bun-connection-fixture.js",
      "bun",
      "fixture-build",
    );
    if (
      built.result.exitCode !== 0 ||
      built.result.stderr !== "" ||
      !built.report.success ||
      built.report.rejected.length !== 0
    ) {
      throw new Error(
        formatFixtureFailure(
          "bun",
          "fixture-build",
          built.result.exitCode,
          built.result.stdout,
          built.result.stderr,
        ),
      );
    }
    const real = await runFixture(bundle, "real", ["real"]);
    expectFixtureSuccess("real", real, "signed-producer-register-observed\n");

    for (const mode of pendingModes) {
      const result = await runFixture(bundle, mode, [mode]);
      expectFixtureSuccess(mode, result, `${mode}\n`);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
