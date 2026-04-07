import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "tuistory";

const integrationDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(integrationDir, "../..");
const sourceEntrypoint = join(repoRoot, "src/main.tsx");

function resolveBunExecutable() {
  const envCandidate = process.env.BUN_BIN ?? process.env.BUN;
  if (envCandidate) {
    return envCandidate;
  }

  if (process.versions.bun && process.execPath) {
    return process.execPath;
  }

  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const lookup = spawnSync(lookupCommand, ["bun"], {
    encoding: "utf8",
    env: process.env,
  });
  if (lookup.status === 0) {
    const resolvedPath = lookup.stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean);
    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return "bun";
}

const bunExecutable = resolveBunExecutable();

async function loadTuistory() {
  if (!process.versions.bun) {
    throw new Error(
      "Tuistory integration tests must run with Bun so tuistory can use its Bun PTY backend. Run `bun run test:integration`.",
    );
  }

  return import("tuistory");
}

interface ChangedFileSpec {
  path: string;
  before: string;
  after: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeText(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Build numbered export lines so PTY fixtures can assert on stable visible content. */
function createNumberedExportLines(start: number, count: number, valueOffset = 0) {
  return Array.from({ length: count }, (_, index) => {
    const lineNumber = start + index;
    return `export const line${String(lineNumber).padStart(2, "0")} = ${lineNumber + valueOffset};`;
  }).join("\n");
}

function runGit(args: string[], cwd: string, allowExitCodeOne = false) {
  const proc = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });

  const expected = allowExitCodeOne ? [0, 1] : [0];
  if (!expected.includes(proc.status ?? -1)) {
    throw new Error(proc.stderr.trim() || `git ${args.join(" ")} failed with exit ${proc.status}`);
  }

  return proc.stdout;
}

/** Build a fresh PTY test helper that tracks its own temp directories for one integration test file. */
export function createPtyHarness() {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function cleanup() {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  function createLongWrapFilePair() {
    const dir = makeTempDir("hunk-tuistory-wrap-");
    const before = join(dir, "before.ts");
    const after = join(dir, "after.ts");

    writeText(before, "export const message = 'short';\n");
    writeText(
      after,
      "export const message = 'this is a very long wrapped line for tuistory integration coverage';\n",
    );

    return { dir, before, after };
  }

  function createAgentFilePair() {
    const dir = makeTempDir("hunk-tuistory-agent-");
    const before = join(dir, "before.ts");
    const after = join(dir, "after.ts");
    const agentContext = join(dir, "agent.json");

    writeText(before, "export const answer = 41;\n");
    writeText(after, "export const answer = 42;\nexport const added = true;\n");
    writeText(
      agentContext,
      JSON.stringify({
        version: 1,
        files: [
          {
            path: "after.ts",
            annotations: [
              {
                newRange: [2, 2],
                summary: "Adds bonus export.",
                rationale: "Highlights the follow-up addition for review.",
              },
            ],
          },
        ],
      }),
    );

    return { dir, before, after, agentContext };
  }

  function createMultiHunkFilePair() {
    const dir = makeTempDir("hunk-tuistory-hunks-");
    const before = join(dir, "before.ts");
    const after = join(dir, "after.ts");

    const beforeLines = Array.from(
      { length: 80 },
      (_, index) => `export const line${index + 1} = ${index + 1};`,
    );
    const afterLines = [...beforeLines];
    afterLines[0] = "export const line1 = 100;";
    afterLines[59] = "export const line60 = 6000;";
    afterLines[60] = "export const line61 = 6100;";
    afterLines[61] = "export const line62 = 6200;";
    afterLines[62] = "export const line63 = 6300;";
    afterLines[63] = "export const line64 = 6400;";
    afterLines[64] = "export const line65 = 6500;";

    writeText(before, `${beforeLines.join("\n")}\n`);
    writeText(after, `${afterLines.join("\n")}\n`);

    return { dir, before, after };
  }

  function createScrollableFilePair() {
    const dir = makeTempDir("hunk-tuistory-scroll-");
    const before = join(dir, "before.ts");
    const after = join(dir, "after.ts");

    const beforeText =
      Array.from(
        { length: 18 },
        (_, index) => `export const line${String(index + 1).padStart(2, "0")} = ${index + 1};`,
      ).join("\n") + "\n";
    const afterText =
      Array.from(
        { length: 18 },
        (_, index) => `export const line${String(index + 1).padStart(2, "0")} = ${index + 101};`,
      ).join("\n") + "\n";

    writeText(before, beforeText);
    writeText(after, afterText);

    return { dir, before, after };
  }

  function createGitRepoFixture(files: ChangedFileSpec[]) {
    const dir = makeTempDir("hunk-tuistory-repo-");

    runGit(["init"], dir);
    runGit(["config", "user.name", "Pi"], dir);
    runGit(["config", "user.email", "pi@example.com"], dir);

    for (const file of files) {
      writeText(join(dir, file.path), file.before);
    }

    runGit(["add", "."], dir);
    runGit(["commit", "-m", "initial"], dir);

    for (const file of files) {
      writeText(join(dir, file.path), file.after);
    }

    return { dir };
  }

  function createTwoFileRepoFixture() {
    return createGitRepoFixture([
      {
        path: "alpha.ts",
        before: "export const alpha = 1;\n",
        after: "export const alpha = 2;\nexport const add = true;\n",
      },
      {
        path: "beta.ts",
        before: "export const beta = 1;\n",
        after: "export const betaValue = 1;\n",
      },
    ]);
  }

  function createPinnedHeaderRepoFixture() {
    return createGitRepoFixture([
      {
        path: "first.ts",
        before: `${createNumberedExportLines(1, 16)}\n`,
        after: `${createNumberedExportLines(1, 16, 100)}\n`,
      },
      {
        path: "second.ts",
        before: `${createNumberedExportLines(17, 16)}\n`,
        after: `${createNumberedExportLines(17, 16, 100)}\n`,
      },
    ]);
  }

  function createCollapsedTopRepoFixture() {
    const longBefore =
      Array.from(
        { length: 400 },
        (_, index) => `export const line${String(index + 1).padStart(3, "0")} = ${index + 1};`,
      ).join("\n") + "\n";
    const longAfterLines = longBefore.trimEnd().split("\n");
    longAfterLines[365] = "export const line366 = 9999;";
    const longAfter = `${longAfterLines.join("\n")}\n`;

    return createGitRepoFixture([
      {
        path: "aaa-collapsed.ts",
        before: longBefore,
        after: longAfter,
      },
      {
        path: "zzz-other.ts",
        before: "export const other = 1;\n",
        after: "export const other = 2;\n",
      },
    ]);
  }

  function createSidebarJumpRepoFixture() {
    return createGitRepoFixture([
      {
        path: "alpha.ts",
        before: "export const alpha = 1;\n",
        after: "export const alphaValue = 2;\nexport const alphaOnly = true;\n",
      },
      {
        path: "beta.ts",
        before: "export const beta = 1;\n",
        after: "export const betaValue = 2;\nexport const betaOnly = true;\n",
      },
      {
        path: "gamma.ts",
        before: "export const gamma = 1;\n",
        after: "export const gammaValue = 2;\nexport const gammaOnly = true;\n",
      },
      {
        path: "delta.ts",
        before: "export const delta = 1;\n",
        after: "export const deltaValue = 2;\nexport const deltaOnly = true;\n",
      },
      {
        path: "epsilon.ts",
        before: "export const epsilon = 1;\n",
        after: "export const epsilonValue = 2;\nexport const epsilonOnly = true;\n",
      },
    ]);
  }

  function createPagerPatchFixture(lines = 40) {
    const dir = makeTempDir("hunk-tuistory-pager-");
    const beforeDir = join(dir, "before");
    const afterDir = join(dir, "after");
    const patchFile = join(dir, "input.patch");

    const beforeText =
      Array.from(
        { length: lines },
        (_, index) => `export const before_${String(index + 1).padStart(2, "0")} = ${index + 1};`,
      ).join("\n") + "\n";
    const afterText =
      Array.from(
        { length: lines },
        (_, index) => `export const after_${String(index + 1).padStart(2, "0")} = ${index + 101};`,
      ).join("\n") + "\n";

    writeText(join(beforeDir, "scroll.ts"), beforeText);
    writeText(join(afterDir, "scroll.ts"), afterText);

    const patch = runGit(
      ["diff", "--no-index", "--no-color", "--", beforeDir, afterDir],
      dir,
      true,
    );
    writeText(patchFile, patch);

    return { dir, patchFile };
  }

  async function launchHunk(options: {
    args: string[];
    cwd?: string;
    cols?: number;
    rows?: number;
    env?: Record<string, string | undefined>;
  }) {
    const { launchTerminal } = await loadTuistory();

    return launchTerminal({
      command: bunExecutable,
      args: ["run", sourceEntrypoint, "--", ...options.args],
      cwd: options.cwd ?? repoRoot,
      cols: options.cols ?? 140,
      rows: options.rows ?? 24,
      env: {
        ...process.env,
        HUNK_MCP_DISABLE: "1",
        HUNK_DISABLE_UPDATE_NOTICE: "1",
        ...options.env,
      },
    });
  }

  async function waitForSnapshot(
    session: Session,
    predicate: (text: string) => boolean,
    timeoutMs = 5_000,
  ) {
    const start = Date.now();
    let snapshot = await session.text({ immediate: true });

    while (Date.now() - start < timeoutMs) {
      if (predicate(snapshot)) {
        return snapshot;
      }

      await session.waitIdle({ timeout: 50 });
      await sleep(30);
      snapshot = await session.text({ immediate: true });
    }

    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for snapshot. Last snapshot:\n${snapshot}`,
    );
  }

  function countMatches(text: string, pattern: RegExp) {
    return (text.match(pattern) ?? []).length;
  }

  return {
    cleanup,
    countMatches,
    createAgentFilePair,
    createCollapsedTopRepoFixture,
    createLongWrapFilePair,
    createMultiHunkFilePair,
    createPagerPatchFixture,
    createPinnedHeaderRepoFixture,
    createScrollableFilePair,
    createSidebarJumpRepoFixture,
    createTwoFileRepoFixture,
    launchHunk,
    waitForSnapshot,
  };
}
