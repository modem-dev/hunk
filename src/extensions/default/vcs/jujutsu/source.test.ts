import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJjFileSource } from "./source";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function jj(cwd: string, ...cmd: string[]) {
  const proc = Bun.spawnSync(
    [
      "jj",
      "--config",
      "signing.behavior=drop",
      "--config",
      'user.name="Test User"',
      "--config",
      "user.email=test@example.com",
      ...cmd,
    ],
    { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    throw new Error(stderr.trim() || `jj ${cmd.join(" ")} failed`);
  }
  return Buffer.from(proc.stdout).toString("utf8");
}

function createTempJjRepo(prefix: string) {
  const dir = createTempDir(prefix);
  jj(tmpdir(), "git", "init", "--colocate", dir);
  return dir;
}

/** Capture console.error calls while exercising diagnostic paths. */
async function captureConsoleErrors(fn: () => Promise<void>) {
  const originalConsoleError = console.error;
  const loggedErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => loggedErrors.push(args);
  try {
    await fn();
  } finally {
    console.error = originalConsoleError;
  }
  return loggedErrors;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const jjTest = Bun.which("jj") ? test : test.skip;
const unixJjTest = Bun.which("jj") && process.platform !== "win32" ? test : test.skip;

describe("Jujutsu source reading", () => {
  jjTest("reads exact commit contents through `jj file show`", async () => {
    const repoRoot = createTempJjRepo("hunk-source-jj-");
    const filePath = "-note [exact] file.txt";
    writeFileSync(join(repoRoot, filePath), "first revision\n");
    writeFileSync(join(repoRoot, "-note e file.txt"), "glob decoy\n");
    jj(repoRoot, "commit", "-m", "first");
    const firstCommitId = jj(repoRoot, "log", "--no-graph", "-r", "@-", "-T", "commit_id");

    writeFileSync(join(repoRoot, filePath), "second revision\n");
    jj(repoRoot, "commit", "-m", "second");
    const secondCommitId = jj(repoRoot, "log", "--no-graph", "-r", "@-", "-T", "commit_id");

    await expect(
      readJjFileSource({ repoRoot, commitId: firstCommitId, path: filePath }),
    ).resolves.toBe("first revision\n");
    await expect(
      readJjFileSource({ repoRoot, commitId: secondCommitId, path: filePath }),
    ).resolves.toBe("second revision\n");
  });

  unixJjTest("reads Unix filenames containing backslashes", async () => {
    const repoRoot = createTempJjRepo("hunk-source-jj-backslash-");
    const filePath = "a\\b.txt";
    writeFileSync(join(repoRoot, filePath), "backslash source\n");
    jj(repoRoot, "commit", "-m", "backslash");
    const commitId = jj(repoRoot, "log", "--no-graph", "-r", "@-", "-T", "self.commit_id()");

    await expect(readJjFileSource({ repoRoot, commitId, path: filePath })).resolves.toBe(
      "backslash source\n",
    );
  });

  jjTest("ignores fileset aliases and file-show templates", async () => {
    const repoRoot = createTempJjRepo("hunk-source-jj-user-config-");
    writeFileSync(join(repoRoot, "a.txt"), "one\n");
    writeFileSync(join(repoRoot, "b.txt"), "bee\n");
    jj(repoRoot, "commit", "-m", "first");
    const commitId = jj(repoRoot, "log", "--no-graph", "-r", "@-", "-T", "self.commit_id()");

    jj(repoRoot, "config", "set", "--repo", 'fileset-aliases."root-file:x"', "'all()'");
    jj(repoRoot, "config", "set", "--repo", "templates.file_show", `'"PREFIX:" ++ path ++ "\\n"'`);

    await expect(readJjFileSource({ repoRoot, commitId, path: "a.txt" })).resolves.toBe("one\n");
  });

  jjTest("reports source reads that exceed the configured byte cap", async () => {
    const repoRoot = createTempJjRepo("hunk-source-jj-large-");
    writeFileSync(join(repoRoot, "note.txt"), "committed source\n");
    jj(repoRoot, "commit", "-m", "first");
    const commitId = jj(repoRoot, "log", "--no-graph", "-r", "@-", "-T", "commit_id");

    await expect(
      readJjFileSource({ repoRoot, commitId, path: "note.txt" }, { maxSourceBytes: 5 }),
    ).resolves.toEqual({ kind: "too-large", maxBytes: 5 });
  });

  jjTest("returns null without diagnostics when a path is absent", async () => {
    const repoRoot = createTempJjRepo("hunk-source-jj-missing-");
    writeFileSync(join(repoRoot, "tracked.txt"), "x\n");
    jj(repoRoot, "commit", "-m", "first");
    const commitId = jj(repoRoot, "log", "--no-graph", "-r", "@-", "-T", "commit_id");

    const loggedErrors = await captureConsoleErrors(async () => {
      await expect(
        readJjFileSource({ repoRoot, commitId, path: "missing-from-history.txt" }),
      ).resolves.toBeNull();
    });
    expect(loggedErrors).toHaveLength(0);
  });

  test("force-terminates Jujutsu after oversized stderr fails source collection", async () => {
    const originalSpawn = Bun.spawn;
    const mutableBun = Bun as unknown as { spawn: typeof Bun.spawn };
    let spawnedProcess: Bun.ReadableSubprocess | undefined;
    let childExited = false;

    mutableBun.spawn = (() => {
      const proc = originalSpawn(
        [
          process.execPath,
          "--eval",
          "process.on('SIGTERM', () => {}); process.stdout.write('small source\\n'); process.stderr.write('x'.repeat(70000)); setInterval(() => {}, 1000);",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      spawnedProcess = proc;
      void proc.exited.then(() => {
        childExited = true;
      });
      return proc;
    }) as typeof Bun.spawn;

    try {
      const loggedErrors = await captureConsoleErrors(async () => {
        await expect(
          readJjFileSource({
            repoRoot: process.cwd(),
            commitId: "0123456789abcdef",
            path: "note.txt",
          }),
        ).resolves.toBeNull();
      });

      expect(spawnedProcess).toBeDefined();
      expect(childExited).toBe(true);
      expect(String(loggedErrors[0]?.[0])).toContain("failed to collect Jujutsu source");
      expect(String(loggedErrors[0]?.[1])).toContain("diagnostics exceeded");
    } finally {
      mutableBun.spawn = originalSpawn;
      if (spawnedProcess) {
        spawnedProcess.kill("SIGKILL");
        await Promise.race([spawnedProcess.exited.catch(() => undefined), Bun.sleep(2_000)]);
      }
    }
  });

  test("passes revisions and files as separate argv entries to a custom executable", async () => {
    const originalSpawn = Bun.spawn;
    const mutableBun = Bun as unknown as { spawn: typeof Bun.spawn };
    const spawnCalls: string[][] = [];

    mutableBun.spawn = ((command: string[]) => {
      spawnCalls.push(command);
      return originalSpawn([process.execPath, "--eval", "process.stdout.write('safe source\\n')"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    }) as typeof Bun.spawn;

    try {
      await expect(
        readJjFileSource(
          {
            repoRoot: process.cwd(),
            commitId: "0123456789abcdef",
            path: '-leading *?[fileset]{path} "file".txt',
          },
          { jjExecutable: "custom-jj" },
        ),
      ).resolves.toBe("safe source\n");
    } finally {
      mutableBun.spawn = originalSpawn;
    }

    expect(spawnCalls).toEqual([
      [
        "custom-jj",
        "--no-pager",
        "--color",
        "never",
        "file",
        "show",
        "--ignore-working-copy",
        "-r",
        "0123456789abcdef",
        "-T",
        '""',
        "--",
        '"-leading [*][?][[]fileset[]][{]path[}] \\"file\\".txt"',
      ],
    ]);
  });

  test("logs unexpected source failures with revision and path context", async () => {
    const repoRoot = createTempDir("hunk-source-jj-not-repo-");
    const loggedErrors = await captureConsoleErrors(async () => {
      await expect(
        readJjFileSource({ repoRoot, commitId: "0123456789abcdef", path: "note.txt" }),
      ).resolves.toBeNull();
    });

    expect(loggedErrors).toHaveLength(1);
    expect(String(loggedErrors[0]?.[0])).toContain("0123456789abcdef:note.txt");
    expect(String(loggedErrors[0]?.[0])).toContain(repoRoot);
  });
});
