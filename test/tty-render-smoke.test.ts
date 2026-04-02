import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const sourceEntrypoint = join(repoRoot, "src/main.tsx");
const tempDirs: string[] = [];
const enableTtySmokeTests = process.env.HUNK_RUN_TTY_SMOKE === "1";
if (enableTtySmokeTests) {
  setDefaultTimeout(15000);
}

const ttyToolsAvailable =
  Bun.spawnSync(["bash", "-lc", "command -v script >/dev/null && command -v timeout >/dev/null"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;

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

async function runTtySmoke(options: {
  mode?: "split" | "stack";
  pager?: boolean;
  agentContext?: boolean;
  inputCommand?: string;
  longWrapFixture?: boolean;
}) {
  const fixture = options.longWrapFixture ? createLongWrapFixtureFiles() : createFixtureFiles();
  const transcript = join(fixture.dir, "transcript.txt");
  const args = ["diff", fixture.before, fixture.after];

  if (options.mode) {
    args.push("--mode", options.mode);
  }

  if (options.pager) {
    args.push("--pager");
  }

  if (options.agentContext && !options.longWrapFixture) {
    args.push("--agent-context", (fixture as ReturnType<typeof createFixtureFiles>).agent);
  }

  const hunkCommand = `bun run ${shellQuote(sourceEntrypoint)} ${args.map(shellQuote).join(" ")}`;
  const scriptCommand = `timeout 7 script -q -f -e -c ${shellQuote(hunkCommand)} ${shellQuote(transcript)}`;
  const inputCommand = options.inputCommand ?? `(sleep 2; printf q)`;
  const proc = Bun.spawnSync(["bash", "-lc", `${inputCommand} | ${scriptCommand}`], {
    cwd: fixture.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TERM: "xterm-256color",
      HUNK_MCP_DISABLE: "1",
    },
  });

  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    throw new Error(stderr.trim() || `tty smoke command failed with exit ${proc.exitCode}`);
  }

  return stripTerminalControl(await Bun.file(transcript).text());
}

async function runStdinPagerSmoke(options?: {
  input?: string;
  inputCommand?: string;
  lines?: number;
  command?: "patch" | "pager";
}) {
  const fixture = createFixtureFiles(options?.lines ?? 1);
  const transcript = join(fixture.dir, "stdin-pager-transcript.txt");
  const subcommand = options?.command === "pager" ? "pager" : "patch -";
  const patchCommand = `cat ${shellQuote(fixture.coloredPatch)} | bun run ${shellQuote(sourceEntrypoint)} ${subcommand}`;
  const scriptCommand = `timeout 7 script -q -f -e -c ${shellQuote(patchCommand)} ${shellQuote(transcript)}`;
  const inputCommand =
    options?.inputCommand ?? `(sleep 2; printf ${shellQuote(options?.input ?? "q")})`;
  const proc = Bun.spawnSync(["bash", "-lc", `${inputCommand} | ${scriptCommand}`], {
    cwd: fixture.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TERM: "xterm-256color",
      HUNK_MCP_DISABLE: "1",
    },
  });

  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    throw new Error(stderr.trim() || `stdin pager smoke command failed with exit ${proc.exitCode}`);
  }

  return stripTerminalControl(await Bun.file(transcript).text());
}

afterEach(() => {
  cleanupTempDirs();
});

describe("TTY render smoke", () => {
  const ttyTest = enableTtySmokeTests ? test : test.skip;

  ttyTest("split mode renders chrome, rails, and AI badges in a terminal transcript", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const output = await runTtySmoke({ mode: "split", agentContext: true });

    expect(output).toContain("View  Navigate  Theme  Agent  Help");
    expect(output).toContain("before.ts ↔ after.ts");
    expect(output).toContain("[AI]");
    expect(output).toContain("▌@@ -1,1 +1,2 @@");
    expect(output).toContain("▌1 - export const answer = 41;");
    expect(output).toContain("▌1 + export const answer = 42;");
  });

  ttyTest("regular mode can toggle wrapped lines from terminal input", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const output = await runTtySmoke({
      mode: "split",
      longWrapFixture: true,
      inputCommand: `(sleep 2; printf w; sleep 1; printf q)`,
    });

    expect(output).toContain("very long wrapped line for tty s");
    expect(output).toContain("moke coverage';");
  });

  ttyTest("regular mode can toggle wrapped lines on, off, and on again", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const output = await runTtySmoke({
      mode: "split",
      longWrapFixture: true,
      inputCommand: `(sleep 2; printf www; sleep 1; printf q)`,
    });

    expect(output).toContain("very long wrapped line for tty s");
    expect(output).toContain("moke coverage';");
  });

  ttyTest(
    "stack mode keeps the terminal-native stacked rows without split separators",
    async () => {
      if (!ttyToolsAvailable) {
        return;
      }

      const output = await runTtySmoke({ mode: "stack" });

      expect(output).toContain("View  Navigate  Theme  Agent  Help");
      expect(output).toContain("▌1   -  export const answer = 41;");
      expect(output).toContain("▌  1 +  export const answer = 42;");
      expect(output).not.toContain("│1 + export const answer = 42;");
    },
  );

  ttyTest("pager mode hides chrome while still rendering the diff transcript", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const output = await runTtySmoke({ pager: true });

    expect(output).not.toContain("View  Navigate  Theme  Agent  Help");
    expect(output).not.toContain("F10 menu");
    expect(output).toContain("before.ts -> after.ts");
    expect(output).toContain("export const answer = 42;");
  });

  ttyTest("pager mode can toggle wrapped lines from terminal input", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const output = await runTtySmoke({
      mode: "split",
      pager: true,
      longWrapFixture: true,
      inputCommand: `(sleep 2; printf w; sleep 1; printf q)`,
    });

    expect(output).toContain("very long wrapped line for tty smo");
    expect(output).toContain("ke coverage';");
  });

  ttyTest("stdin patch mode auto-enters pager mode and can quit from terminal input", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const output = await runStdinPagerSmoke();

    expect(output).not.toContain("View  Navigate  Theme  Agent  Help");
    expect(output).not.toContain("F10 menu");
    expect(output).toContain("after.ts");
    expect(output).toContain("@@ -1 +1,2 @@");
    expect(output).toContain("export const answer = 42;");
  });

  ttyTest("stdin pager mode pages forward by a full viewport on space", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const output = await runStdinPagerSmoke({
      lines: 40,
      inputCommand: `(sleep 2; printf ' '; sleep 2; printf q)`,
    });

    expect(output).toContain("before_23");
    expect(output).toContain("after_05");
  });

  ttyTest("general pager mode opens Hunk pager UI for diff-like stdin", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const output = await runStdinPagerSmoke({ command: "pager" });

    expect(output).not.toContain("View  Navigate  Theme  Agent  Help");
    expect(output).toContain("after.ts");
    expect(output).toContain("@@ -1 +1,2 @@");
    expect(output).toContain("export const answer = 42;");
  });
});
