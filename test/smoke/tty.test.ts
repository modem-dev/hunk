import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestConfigHomes, createTestConfigHome } from "../helpers/config-home";

const repoRoot = process.cwd();
const sourceEntrypoint = join(repoRoot, "packages/hunk/src/main.tsx");
// Spawned hunk processes must assert built-in defaults, not the developer's ambient user config.
const testConfigHome = createTestConfigHome();

afterAll(cleanupTestConfigHomes);
const tempDirs: string[] = [];
const enableTtySmokeTests = process.env.HUNK_RUN_TTY_SMOKE === "1";
if (enableTtySmokeTests) {
  setDefaultTimeout(40_000);
}

/** Check for the util-linux `script` interface these Unix-only terminal tests require. */
function supportsControllableScript() {
  try {
    return (
      Bun.spawnSync(["script", "-q", "-f", "-e", "-c", "exit 0", "/dev/null"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0
    );
  } catch {
    return false;
  }
}

const ttyToolsAvailable = supportsControllableScript();

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stripTerminalControl(text: string) {
  return text
    .replace(/^Script started.*?\n/s, "")
    .replace(/\nScript done.*$/s, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

function createFixtureFiles(lines = 1) {
  const dir = mkdtempSync(join(tmpdir(), "hunk-tty-smoke-"));
  tempDirs.push(dir);

  const before = join(dir, "before.ts");
  const after = join(dir, "after.ts");
  const agent = join(dir, "agent.json");
  const patch = join(dir, "input.patch");
  const coloredPatch = join(dir, "input-colored.patch");

  if (lines <= 1) {
    writeFileSync(before, "export const answer = 41;\n");
    writeFileSync(after, "export const answer = 42;\nexport const added = true;\n");
  } else {
    writeFileSync(
      before,
      Array.from(
        { length: lines },
        (_, index) => `export const before_${String(index + 1).padStart(2, "0")} = ${index + 1};`,
      ).join("\n") + "\n",
    );
    writeFileSync(
      after,
      Array.from(
        { length: lines },
        (_, index) => `export const after_${String(index + 1).padStart(2, "0")} = ${index + 101};`,
      ).join("\n") + "\n",
    );
  }
  writeFileSync(
    agent,
    JSON.stringify({
      version: 1,
      files: [
        {
          path: "after.ts",
          annotations: [{ newRange: [2, 2], summary: "Adds bonus export." }],
        },
      ],
    }),
  );

  const patchProc = Bun.spawnSync(
    ["git", "diff", "--no-index", "--no-color", "--", before, after],
    {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const coloredPatchProc = Bun.spawnSync(
    ["git", "diff", "--no-index", "--color=always", "--", before, after],
    {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  if (patchProc.exitCode !== 0 && patchProc.exitCode !== 1) {
    const stderr = Buffer.from(patchProc.stderr).toString("utf8");
    throw new Error(stderr.trim() || `failed to build fixture patch: ${patchProc.exitCode}`);
  }

  if (coloredPatchProc.exitCode !== 0 && coloredPatchProc.exitCode !== 1) {
    const stderr = Buffer.from(coloredPatchProc.stderr).toString("utf8");
    throw new Error(
      stderr.trim() || `failed to build colored fixture patch: ${coloredPatchProc.exitCode}`,
    );
  }

  writeFileSync(patch, Buffer.from(patchProc.stdout).toString("utf8"));
  writeFileSync(coloredPatch, Buffer.from(coloredPatchProc.stdout).toString("utf8"));

  return { dir, before, after, agent, patch, coloredPatch };
}

function createLongWrapFixtureFiles() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-tty-smoke-"));
  tempDirs.push(dir);

  const before = join(dir, "before.ts");
  const after = join(dir, "after.ts");

  writeFileSync(before, "export const message = 'short';\n");
  writeFileSync(
    after,
    "export const message = 'this is a very long wrapped line for tty smoke coverage';\n",
  );

  return { dir, before, after };
}

type TtyInteraction = "quit" | "wrap" | "wrap-cycle" | "page";

type TtySmokeProcess = ReturnType<typeof spawnTtySmokeProcess>;

/** Poll observable terminal output until a state appears or the deadline expires. */
async function waitUntil<T>(
  label: string,
  poll: () => T | null | Promise<T | null>,
  timeoutMs = 5_000,
  intervalMs = 25,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await poll();
    if (value !== null) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await Bun.sleep(intervalMs);
  }
}

/** Start a real terminal command whose keyboard input the test controls directly. */
function spawnTtySmokeProcess(command: string, cwd: string, transcript: string) {
  return Bun.spawn(["script", "-q", "-f", "-e", "-c", command, transcript], {
    cwd,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: testConfigHome,
      TERM: "xterm-256color",
      COLUMNS: "80",
      LINES: "24",
      HUNK_MCP_DISABLE: "1",
      HUNK_DISABLE_UPDATE_NOTICE: "1",
    },
  });
}

/** Read a terminal transcript if util-linux `script` has created it. */
async function readTranscript(transcript: string) {
  const file = Bun.file(transcript);
  return (await file.exists()) ? await file.text() : "";
}

/** Wait for cumulative transcript output matching an observable app state. */
async function waitForTranscript(
  proc: TtySmokeProcess,
  transcript: string,
  label: string,
  predicate: (output: string) => boolean,
) {
  return waitUntil(label, async () => {
    const raw = await readTranscript(transcript);
    if (predicate(stripTerminalControl(raw))) {
      return raw;
    }
    if (proc.exitCode !== null) {
      throw new Error(`TTY process exited with ${proc.exitCode} before ${label}.`);
    }
    return null;
  });
}

/** Wait for output appended after one keyboard action. */
async function waitForTranscriptUpdate(
  proc: TtySmokeProcess,
  transcript: string,
  offset: number,
  label: string,
  predicate: (output: string) => boolean,
) {
  try {
    return await waitUntil(label, async () => {
      const raw = await readTranscript(transcript);
      const update = stripTerminalControl(raw.slice(offset));
      if (raw.length > offset && predicate(update)) {
        return raw;
      }
      if (proc.exitCode !== null) {
        throw new Error(`TTY process exited with ${proc.exitCode} before ${label}.`);
      }
      return null;
    });
  } catch (error) {
    const raw = await readTranscript(transcript);
    const update = stripTerminalControl(raw.slice(offset));
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Appended transcript: ${JSON.stringify(update.slice(-1_000))}`,
    );
  }
}

/** Send one keyboard sequence to the controlled terminal. */
async function writeTtyInput(proc: TtySmokeProcess, input: string) {
  proc.stdin.write(input);
  await proc.stdin.flush();
}

/** Retry a readiness key until its observable terminal state appears. */
async function writeTtyInputUntil(
  proc: TtySmokeProcess,
  transcript: string,
  offset: number,
  input: string,
  label: string,
  predicate: (output: string) => boolean,
) {
  let lastAttemptAt = 0;

  try {
    return await waitUntil(
      label,
      async () => {
        const raw = await readTranscript(transcript);
        const update = stripTerminalControl(raw.slice(offset));
        if (raw.length > offset && predicate(update)) {
          return raw;
        }
        if (proc.exitCode !== null) {
          throw new Error(`TTY process exited with ${proc.exitCode} before ${label}.`);
        }

        if (lastAttemptAt === 0 || Date.now() - lastAttemptAt >= 500) {
          await writeTtyInput(proc, input);
          lastAttemptAt = Date.now();
        }
        return null;
      },
      5_000,
      25,
    );
  } catch (error) {
    const raw = await readTranscript(transcript);
    const update = stripTerminalControl(raw.slice(offset));
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Appended transcript: ${JSON.stringify(update.slice(-1_000))}`,
    );
  }
}

/** Require a controlled terminal process to exit cleanly within a bounded deadline. */
async function waitForTtyExit(proc: TtySmokeProcess, timeoutMs = 3_000) {
  const result = await Promise.race([
    proc.exited.then((exitCode) => ({ exitCode })),
    Bun.sleep(timeoutMs).then(() => null),
  ]);
  if (!result) {
    throw new Error(`Timed out waiting ${timeoutMs}ms for the TTY process to exit.`);
  }
  if (result.exitCode !== 0) {
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    throw new Error(stderr.trim() || `TTY smoke command failed with exit ${result.exitCode}.`);
  }
}

/** Drive one terminal interaction from rendered readiness through a clean quit. */
async function driveTtySmoke(options: {
  command: string;
  cwd: string;
  transcript: string;
  initialPredicate: (output: string) => boolean;
  interaction: TtyInteraction;
  pager: boolean;
}) {
  const proc = spawnTtySmokeProcess(options.command, options.cwd, options.transcript);

  try {
    let raw = await waitForTranscript(
      proc,
      options.transcript,
      "initial Hunk terminal render",
      options.initialPredicate,
    );

    let offset = raw.length;
    raw = await writeTtyInputUntil(
      proc,
      options.transcript,
      offset,
      "?",
      "terminal keyboard readiness",
      (output) => output.includes("help") && output.includes("[Esc]"),
    );
    offset = raw.length;
    raw = await writeTtyInputUntil(
      proc,
      options.transcript,
      offset,
      "\x1b",
      "help dialog dismissal",
      options.initialPredicate,
    );

    if (options.interaction === "wrap" || options.interaction === "wrap-cycle") {
      const offset = raw.length;
      await writeTtyInput(proc, "w");
      raw = await waitForTranscriptUpdate(
        proc,
        options.transcript,
        offset,
        "wrapped terminal row",
        (output) => output.includes("smoke coverage';"),
      );
    }

    if (options.interaction === "wrap-cycle") {
      let offset = raw.length;
      await writeTtyInput(proc, "w");
      raw = await waitForTranscriptUpdate(
        proc,
        options.transcript,
        offset,
        "second wrap-toggle repaint",
        (output) => output.trim().length > 0,
      );

      offset = raw.length;
      await writeTtyInput(proc, "w");
      raw = await waitForTranscriptUpdate(
        proc,
        options.transcript,
        offset,
        "rewrapped terminal row",
        (output) => output.includes("smoke coverage';"),
      );
    }

    if (options.interaction === "page") {
      const offset = raw.length;
      await writeTtyInput(proc, " ");
      raw = await waitForTranscriptUpdate(
        proc,
        options.transcript,
        offset,
        "paged terminal viewport",
        (output) => output.includes("before_23") && output.includes("after_05"),
      );
    }

    await writeTtyInput(proc, "q");
    if (!options.pager && options.interaction !== "quit") {
      const outcome = await waitUntil("TTY exit or save-preferences prompt", async () => {
        if (proc.exitCode !== null) {
          return "exited" as const;
        }
        const output = stripTerminalControl(await readTranscript(options.transcript));
        return output.includes("Save view preferences?") ? ("prompt" as const) : null;
      });
      if (outcome === "prompt") {
        await writeTtyInput(proc, "q");
      }
    }

    await waitForTtyExit(proc);
    return stripTerminalControl(await readTranscript(options.transcript));
  } catch (error) {
    proc.kill();
    await proc.exited.catch(() => undefined);
    throw error;
  }
}

async function runTtySmoke(options: {
  mode?: "split" | "stack";
  pager?: boolean;
  agentContext?: boolean;
  interaction?: TtyInteraction;
  longWrapFixture?: boolean;
}) {
  const fixture = options.longWrapFixture ? createLongWrapFixtureFiles() : createFixtureFiles();
  const transcript = join(fixture.dir, "transcript.txt");
  const args = ["diff", "--files", fixture.before, fixture.after];

  if (options.mode) {
    args.push("--mode", options.mode);
  }
  if (options.pager) {
    args.push("--pager");
  }
  if (options.agentContext && !options.longWrapFixture) {
    args.push("--agent-context", (fixture as ReturnType<typeof createFixtureFiles>).agent);
  }

  const command = `bun run ${shellQuote(sourceEntrypoint)} ${args.map(shellQuote).join(" ")}`;
  return driveTtySmoke({
    command,
    cwd: fixture.dir,
    transcript,
    initialPredicate: (output) =>
      options.longWrapFixture
        ? output.includes("export const message")
        : output.includes("export const answer"),
    interaction: options.interaction ?? "quit",
    pager: options.pager ?? false,
  });
}

async function runStdinPagerSmoke(options?: {
  interaction?: TtyInteraction;
  lines?: number;
  command?: "patch" | "pager";
}) {
  const fixture = createFixtureFiles(options?.lines ?? 1);
  const transcript = join(fixture.dir, "stdin-pager-transcript.txt");
  const subcommand = options?.command === "pager" ? "pager" : "patch -";
  const command = `cat ${shellQuote(fixture.coloredPatch)} | bun run ${shellQuote(sourceEntrypoint)} ${subcommand}`;

  return driveTtySmoke({
    command,
    cwd: fixture.dir,
    transcript,
    initialPredicate: (output) =>
      options?.lines && options.lines > 1
        ? output.includes("before_01")
        : output.includes("export const answer"),
    interaction: options?.interaction ?? "quit",
    pager: true,
  });
}

afterEach(() => {
  cleanupTempDirs();
});

describe("TTY render smoke", () => {
  const ttyTest = enableTtySmokeTests && ttyToolsAvailable ? test : test.skip;

  ttyTest("split mode renders chrome and rails in a terminal transcript", async () => {
    const output = await runTtySmoke({ mode: "split", agentContext: true });

    expect(output).toContain("View  Navigate  Agent  Help");
    expect(output).toContain("before.ts ↔ after.ts");
    expect(output).not.toContain("[AI]");
    expect(output).toContain("▌@@ -1,1 +1,2 @@");
    expect(output).toContain("▌1 - export const answer = 41;");
    expect(output).toContain("▌1 + export const answer = 42;");
  });

  ttyTest("regular mode can toggle wrapped lines from terminal input", async () => {
    const output = await runTtySmoke({
      mode: "split",
      longWrapFixture: true,
      interaction: "wrap",
    });

    expect(output).toContain("wrapped line for");
    expect(output).toContain("tty smoke coverage';");
  });

  ttyTest("regular mode accepts repeated wrap toggles and ends wrapped", async () => {
    const output = await runTtySmoke({
      mode: "split",
      longWrapFixture: true,
      interaction: "wrap-cycle",
    });

    expect(output).toContain("wrapped line for");
    expect(output).toContain("tty smoke coverage';");
  });

  ttyTest(
    "stack mode keeps the terminal-native stacked rows without split separators",
    async () => {
      const output = await runTtySmoke({ mode: "stack" });

      expect(output).toContain("View  Navigate  Agent  Help");
      expect(output).toContain("▌1   -  export const answer = 41;");
      expect(output).toContain("▌  1 +  export const answer = 42;");
      expect(output).not.toContain("│1 + export const answer = 42;");
    },
  );

  ttyTest("pager mode hides chrome while still rendering the diff transcript", async () => {
    const output = await runTtySmoke({ pager: true });

    expect(output).not.toContain("View  Navigate  Agent  Help");
    expect(output).not.toContain("F10 menu");
    expect(output).toContain("before.ts -> after.ts");
    expect(output).toContain("export const answer = 42;");
  });

  ttyTest("pager mode can toggle wrapped lines from terminal input", async () => {
    const output = await runTtySmoke({
      mode: "split",
      pager: true,
      longWrapFixture: true,
      interaction: "wrap",
    });

    expect(output).toContain("wrapped line for t");
    expect(output).toContain("ty smoke coverage';");
  });

  ttyTest("stdin patch mode auto-enters pager mode and can quit from terminal input", async () => {
    const output = await runStdinPagerSmoke();

    expect(output).not.toContain("View  Navigate  Agent  Help");
    expect(output).not.toContain("F10 menu");
    expect(output).toContain("after.ts");
    expect(output).toContain("@@ -1 +1,2 @@");
    expect(output).toContain("export const answer = 42;");
  });

  ttyTest("stdin pager mode pages forward by a full viewport on space", async () => {
    const output = await runStdinPagerSmoke({
      lines: 40,
      interaction: "page",
    });

    expect(output).toContain("before_23");
    expect(output).toContain("after_05");
  });

  ttyTest("general pager mode opens Hunk pager UI for diff-like stdin", async () => {
    const output = await runStdinPagerSmoke({ command: "pager" });

    expect(output).not.toContain("View  Navigate  Agent  Help");
    expect(output).toContain("after.ts");
    expect(output).toContain("@@ -1 +1,2 @@");
    expect(output).toContain("export const answer = 42;");
  });
});
