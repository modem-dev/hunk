import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEndpointSourceSpec, readGitFileSource } from "./source";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, ...cmd: string[]) {
  const proc = Bun.spawnSync(["git", ...cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    throw new Error(stderr.trim() || `git ${cmd.join(" ")} failed`);
  }
  return Buffer.from(proc.stdout).toString("utf8");
}

function createTempRepo(prefix: string) {
  const dir = createTempDir(prefix);
  git(dir, "init");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgSign", "false");
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

describe("gitEndpointSourceSpec", () => {
  test("maps every endpoint kind to a source spec", () => {
    expect(gitEndpointSourceSpec({ kind: "none" }, "/repo", "a.ts")).toEqual({ kind: "none" });
    expect(gitEndpointSourceSpec({ kind: "git-ref", ref: "HEAD" }, "/repo", "a.ts")).toEqual({
      kind: "git-blob",
      repoRoot: "/repo",
      ref: "HEAD",
      path: "a.ts",
    });
    expect(gitEndpointSourceSpec({ kind: "index" }, "/repo", "a.ts")).toEqual({
      kind: "git-index",
      repoRoot: "/repo",
      path: "a.ts",
    });
    expect(gitEndpointSourceSpec({ kind: "worktree" }, "/repo", "a.ts")).toEqual({
      kind: "fs",
      absolutePath: join("/repo", "a.ts"),
    });
  });
});

describe("Git source reading", () => {
  test("reads git blob contents for both sides via `git show`", async () => {
    const repoRoot = createTempRepo("hunk-source-git-");
    const filePath = "note.txt";

    writeFileSync(join(repoRoot, filePath), "first revision\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-m", "first");
    writeFileSync(join(repoRoot, filePath), "second revision\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-m", "second");

    expect(
      await readGitFileSource({ kind: "git-blob", repoRoot, ref: "HEAD~1", path: filePath }),
    ).toBe("first revision\n");
    expect(
      await readGitFileSource({ kind: "git-blob", repoRoot, ref: "HEAD", path: filePath }),
    ).toBe("second revision\n");
  });

  test("reads git index contents through an explicit index spec", async () => {
    const repoRoot = createTempRepo("hunk-source-git-index-");
    const filePath = "note.txt";

    writeFileSync(join(repoRoot, filePath), "committed\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-m", "first");
    writeFileSync(join(repoRoot, filePath), "staged\n");
    git(repoRoot, "add", filePath);
    writeFileSync(join(repoRoot, filePath), "working tree\n");

    expect(await readGitFileSource({ kind: "git-index", repoRoot, path: filePath })).toBe(
      "staged\n",
    );
    expect(await readGitFileSource({ kind: "fs", absolutePath: join(repoRoot, filePath) })).toBe(
      "working tree\n",
    );
  });

  test("reports git blob and index source reads that exceed the configured byte cap", async () => {
    const repoRoot = createTempRepo("hunk-source-git-large-");
    const filePath = "note.txt";

    writeFileSync(join(repoRoot, filePath), "committed source\n");
    git(repoRoot, "add", filePath);
    git(repoRoot, "commit", "-m", "first");
    writeFileSync(join(repoRoot, filePath), "staged source\n");
    git(repoRoot, "add", filePath);

    await expect(
      readGitFileSource(
        { kind: "git-blob", repoRoot, ref: "HEAD", path: filePath },
        { maxSourceBytes: 5 },
      ),
    ).resolves.toEqual({ kind: "too-large", maxBytes: 5 });
    await expect(
      readGitFileSource({ kind: "git-index", repoRoot, path: filePath }, { maxSourceBytes: 5 }),
    ).resolves.toEqual({ kind: "too-large", maxBytes: 5 });
  });

  test("force-terminates Git after oversized stderr fails source collection", async () => {
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
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
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
          readGitFileSource({
            kind: "git-blob",
            repoRoot: process.cwd(),
            ref: "HEAD",
            path: "note.txt",
          }),
        ).resolves.toBeNull();
      });

      expect(spawnedProcess).toBeDefined();
      expect(childExited).toBe(true);
      expect(String(loggedErrors[0]?.[0])).toContain("failed to collect Git source");
      expect(String(loggedErrors[0]?.[1])).toContain("diagnostics exceeded");
    } finally {
      mutableBun.spawn = originalSpawn;
      if (spawnedProcess) {
        spawnedProcess.kill("SIGKILL");
        await Promise.race([spawnedProcess.exited.catch(() => undefined), Bun.sleep(2_000)]);
      }
    }
  });

  test("passes custom git executable through async git source reads", async () => {
    const originalSpawn = Bun.spawn;
    const mutableBun = Bun as unknown as { spawn: typeof Bun.spawn };
    const spawnCalls: string[][] = [];

    mutableBun.spawn = ((cmds: string[]) => {
      spawnCalls.push(cmds);
      return originalSpawn(
        [
          process.execPath,
          "--eval",
          `process.stdout.write(${JSON.stringify(`read:${cmds[2]}\n`)})`,
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    }) as typeof Bun.spawn;

    try {
      expect(
        await readGitFileSource(
          { kind: "git-blob", repoRoot: process.cwd(), ref: "HEAD", path: "note.txt" },
          { gitExecutable: "custom-git" },
        ),
      ).toBe("read:HEAD:note.txt\n");
      expect(
        await readGitFileSource(
          { kind: "git-index", repoRoot: process.cwd(), path: "note.txt" },
          { gitExecutable: "custom-git" },
        ),
      ).toBe("read::note.txt\n");
    } finally {
      mutableBun.spawn = originalSpawn;
    }

    expect(spawnCalls).toEqual([
      ["custom-git", "show", "HEAD:note.txt"],
      ["custom-git", "show", ":note.txt"],
    ]);
  });

  test("returns null when a git blob cannot be resolved", async () => {
    const repoRoot = createTempRepo("hunk-source-git-missing-");
    writeFileSync(join(repoRoot, "tracked.txt"), "x\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-m", "first");

    const loggedErrors = await captureConsoleErrors(async () => {
      expect(
        await readGitFileSource({
          kind: "git-blob",
          repoRoot,
          ref: "HEAD",
          path: "missing-from-history.txt",
        }),
      ).toBeNull();
    });
    expect(loggedErrors).toHaveLength(0);
  });

  test("logs unexpected git source failures with object context", async () => {
    const repoRoot = createTempDir("hunk-source-git-not-repo-");

    const loggedErrors = await captureConsoleErrors(async () => {
      expect(
        await readGitFileSource({ kind: "git-blob", repoRoot, ref: "HEAD", path: "note.txt" }),
      ).toBeNull();
    });

    expect(loggedErrors).toHaveLength(1);
    expect(String(loggedErrors[0]?.[0])).toContain("HEAD:note.txt");
    expect(String(loggedErrors[0]?.[0])).toContain(repoRoot);
  });
});
