import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppBootstrap } from "../src/core/loaders";
import type { CliInput } from "../src/core/types";

const tempDirs: string[] = [];

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
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
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);

  git(dir, "init");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");

  return dir;
}

async function loadFromCwd(cwd: string, input: CliInput) {
  const previousCwd = process.cwd();
  process.chdir(cwd);

  try {
    return await loadAppBootstrap(input);
  } finally {
    process.chdir(previousCwd);
  }
}

async function loadFromRepo(dir: string, input: CliInput) {
  return loadFromCwd(dir, input);
}

afterEach(() => {
  cleanupTempDirs();
});

describe("loadAppBootstrap", () => {
  test("loads file-pair diffs and agent context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-diff-"));
    tempDirs.push(dir);

    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    const agent = join(dir, "agent.json");

    writeFileSync(left, "export const answer = 41;\n");
    writeFileSync(right, "export const answer = 42;\nexport const bonus = true;\n");
    writeFileSync(
      agent,
      JSON.stringify({
        version: 1,
        summary: "Agent added the bonus export.",
        files: [
          {
            path: "after.ts",
            annotations: [{ newRange: [2, 2], summary: "Introduces the bonus flag." }],
          },
        ],
      }),
    );

    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: {
        mode: "auto",
        agentContext: agent,
      },
    });

    expect(bootstrap.changeset.files).toHaveLength(1);
    expect(bootstrap.changeset.agentSummary).toBe("Agent added the bonus export.");
    expect(bootstrap.changeset.files[0]?.stats.additions).toBeGreaterThan(0);
    expect(bootstrap.changeset.files[0]?.agent?.annotations).toHaveLength(1);
  });

  test("loads git changes and relative agent context from an explicit cwd override", async () => {
    const dir = createTempRepo("hunk-git-cwd-");
    const nested = join(dir, "nested");
    writeFileSync(join(dir, "example.ts"), "export const value = 1;\n");
    git(dir, "add", "example.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "example.ts"), "export const value = 2;\n");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, "agent.json"),
      JSON.stringify({
        files: [{ path: "example.ts", annotations: [{ newRange: [1, 1], summary: "updated" }] }],
      }),
    );

    const bootstrap = await loadAppBootstrap(
      {
        kind: "git",
        staged: false,
        options: {
          mode: "auto",
          agentContext: "agent.json",
        },
      },
      { cwd: nested },
    );

    expect(bootstrap.changeset.sourceLabel).toBe(dir);
    expect(bootstrap.changeset.files[0]?.path).toBe("example.ts");
    expect(bootstrap.changeset.files[0]?.agent?.annotations).toHaveLength(1);
  });

  test("loads git working tree changes from a temporary repo", async () => {
    const dir = createTempRepo("hunk-git-");

    writeFileSync(join(dir, "example.ts"), "export const value = 1;\n");
    git(dir, "add", "example.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "example.ts"), "export const value = 2;\nexport const extra = true;\n");

    const bootstrap = await loadFromRepo(dir, {
      kind: "git",
      staged: false,
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files).toHaveLength(1);
    expect(bootstrap.changeset.files[0]?.path).toBe("example.ts");
    expect(bootstrap.changeset.files[0]?.stats.additions).toBeGreaterThan(0);
  });

  test("includes untracked files in working tree reviews by default", async () => {
    const dir = createTempRepo("hunk-git-untracked-");

    writeFileSync(join(dir, "example.ts"), "export const value = 1;\n");
    git(dir, "add", "example.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "example.ts"), "export const value = 2;\n");
    writeFileSync(join(dir, "new-file.ts"), "export const added = true;\n");

    const bootstrap = await loadFromRepo(dir, {
      kind: "git",
      staged: false,
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual([
      "example.ts",
      "new-file.ts",
    ]);
    expect(bootstrap.changeset.files[1]?.patch).toContain("new file mode");
  });

  test("can exclude untracked files from working tree reviews", async () => {
    const dir = createTempRepo("hunk-git-no-untracked-");

    writeFileSync(join(dir, "example.ts"), "export const value = 1;\n");
    git(dir, "add", "example.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "example.ts"), "export const value = 2;\n");
    writeFileSync(join(dir, "new-file.ts"), "export const added = true;\n");

    const bootstrap = await loadFromRepo(dir, {
      kind: "git",
      staged: false,
      options: { mode: "auto", excludeUntracked: true },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual(["example.ts"]);
  });

  test("loads untracked files whose names need parser-safe diff headers", async () => {
    const dir = createTempRepo("hunk-git-quoted-untracked-");

    writeFileSync(join(dir, "tracked.ts"), "export const tracked = 1;\n");
    git(dir, "add", "tracked.ts");
    git(dir, "commit", "-m", "initial");

    const quoteFile = 'quote"name.txt';
    const tabFile = "tab\tname.txt";
    const backslashFile = "back\\slash.txt";
    writeFileSync(join(dir, quoteFile), "quote\n");
    writeFileSync(join(dir, tabFile), "tab\n");
    writeFileSync(join(dir, backslashFile), "backslash\n");

    const bootstrap = await loadFromRepo(dir, {
      kind: "git",
      staged: false,
      options: { mode: "auto" },
    });
    const paths = bootstrap.changeset.files.map((file) => file.path);

    expect(paths).toContain(quoteFile);
    expect(paths).toContain(tabFile);
    expect(paths).toContain(backslashFile);
    expect(paths).toHaveLength(3);
  });

  test("still shows an untracked agent sidecar when it lives inside the repo", async () => {
    const dir = createTempRepo("hunk-git-agent-sidecar-");

    writeFileSync(join(dir, "example.ts"), "export const value = 1;\n");
    git(dir, "add", "example.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "example.ts"), "export const value = 2;\n");
    const agent = join(dir, "agent.json");
    writeFileSync(agent, JSON.stringify({ version: 1, files: [] }));

    const bootstrap = await loadFromRepo(dir, {
      kind: "git",
      staged: false,
      options: { mode: "auto", agentContext: agent },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual([
      "example.ts",
      "agent.json",
    ]);
  });

  test("includes repo-wide untracked files even when launched from a subdirectory", async () => {
    const dir = createTempRepo("hunk-git-subdir-untracked-");

    writeFileSync(join(dir, "tracked.ts"), "export const tracked = 1;\n");
    git(dir, "add", "tracked.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "new-root.ts"), "export const root = true;\n");
    const subdir = join(dir, "nested");
    mkdirSync(subdir, { recursive: true });

    const bootstrap = await loadFromCwd(subdir, {
      kind: "git",
      staged: false,
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toContain("new-root.ts");
  });

  test("loads git working tree changes when diff.noprefix is enabled", async () => {
    const dir = createTempRepo("hunk-git-noprefix-");

    writeFileSync(join(dir, "example.ts"), "export const value = 1;\n");
    git(dir, "add", "example.ts");
    git(dir, "commit", "-m", "initial");

    git(dir, "config", "--local", "diff.noprefix", "true");
    writeFileSync(join(dir, "example.ts"), "export const value = 2;\nexport const extra = true;\n");
    writeFileSync(join(dir, "new-file.ts"), "export const added = true;\n");

    const bootstrap = await loadFromRepo(dir, {
      kind: "git",
      staged: false,
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual([
      "example.ts",
      "new-file.ts",
    ]);
  });

  test("loads git working tree changes when diff.mnemonicPrefix is enabled", async () => {
    const dir = createTempRepo("hunk-git-mnemonic-");

    writeFileSync(join(dir, "example.ts"), "export const value = 1;\n");
    git(dir, "add", "example.ts");
    git(dir, "commit", "-m", "initial");

    git(dir, "config", "--local", "diff.mnemonicPrefix", "true");
    writeFileSync(join(dir, "example.ts"), "export const value = 2;\nexport const extra = true;\n");
    writeFileSync(join(dir, "new-file.ts"), "export const added = true;\n");

    const bootstrap = await loadFromRepo(dir, {
      kind: "git",
      staged: false,
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual([
      "example.ts",
      "new-file.ts",
    ]);
  });

  test("reports a friendly error when git review runs outside a repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-nonrepo-"));
    tempDirs.push(dir);

    await expect(
      loadFromRepo(dir, {
        kind: "git",
        staged: false,
        options: { mode: "auto" },
      }),
    ).rejects.toThrow("`hunk diff` must be run inside a Git repository.");
  });

  test("reports a friendly error when diff cannot resolve a range", async () => {
    const dir = createTempRepo("hunk-git-missing-range-");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
    git(dir, "add", "alpha.ts");
    git(dir, "commit", "-m", "initial");

    await expect(
      loadFromRepo(dir, {
        kind: "git",
        range: "HEAD~999",
        staged: false,
        options: { mode: "auto" },
      }),
    ).rejects.toThrow("`hunk diff HEAD~999` could not resolve Git revision or range `HEAD~999`.");
  });

  test("uses agent sidecar file order for the review stream", async () => {
    const dir = createTempRepo("hunk-git-");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
    writeFileSync(join(dir, "beta.ts"), "export const beta = 1;\n");
    git(dir, "add", "alpha.ts", "beta.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 2;\n");
    writeFileSync(join(dir, "beta.ts"), "export const beta = 2;\n");

    const agentDir = mkdtempSync(join(tmpdir(), "hunk-agent-"));
    tempDirs.push(agentDir);
    const agent = join(agentDir, "agent.json");
    writeFileSync(
      agent,
      JSON.stringify({
        version: 1,
        summary: "Tell the story in beta-first order.",
        files: [
          {
            path: "beta.ts",
            summary: "Explains the behavioral change first.",
            annotations: [{ newRange: [1, 1], summary: "Updates beta." }],
          },
          {
            path: "alpha.ts",
            summary: "Covers the supporting change second.",
            annotations: [{ newRange: [1, 1], summary: "Updates alpha." }],
          },
        ],
      }),
    );

    const bootstrap = await loadFromRepo(dir, {
      kind: "git",
      staged: false,
      options: {
        mode: "auto",
        agentContext: agent,
      },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual(["beta.ts", "alpha.ts"]);
  });

  test("loads staged-only git diffs from the full UI command path", async () => {
    const dir = createTempRepo("hunk-git-staged-");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
    writeFileSync(join(dir, "beta.ts"), "export const beta = 1;\n");
    git(dir, "add", "alpha.ts", "beta.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 2;\n");
    git(dir, "add", "alpha.ts");
    writeFileSync(join(dir, "beta.ts"), "export const beta = 2;\n");

    const bootstrap = await loadFromRepo(dir, {
      kind: "git",
      staged: true,
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual(["alpha.ts"]);
  });

  test("loads staged-only git diffs when diff.noprefix is enabled", async () => {
    const dir = createTempRepo("hunk-git-staged-noprefix-");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
    writeFileSync(join(dir, "beta.ts"), "export const beta = 1;\n");
    git(dir, "add", "alpha.ts", "beta.ts");
    git(dir, "commit", "-m", "initial");

    git(dir, "config", "--local", "diff.noprefix", "true");
    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 2;\n");
    git(dir, "add", "alpha.ts");
    writeFileSync(join(dir, "beta.ts"), "export const beta = 2;\n");

    const bootstrap = await loadFromRepo(dir, {
      kind: "git",
      staged: true,
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual(["alpha.ts"]);
  });

  test("loads pathspec-limited git diffs from the full UI command path", async () => {
    const dir = createTempRepo("hunk-git-pathspec-");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
    writeFileSync(join(dir, "beta.ts"), "export const beta = 1;\n");
    git(dir, "add", "alpha.ts", "beta.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 2;\n");
    writeFileSync(join(dir, "beta.ts"), "export const beta = 2;\n");

    const bootstrap = await loadFromRepo(dir, {
      kind: "git",
      staged: false,
      pathspecs: ["beta.ts"],
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual(["beta.ts"]);
  });

  test("applies pathspec filtering to untracked files in working tree reviews", async () => {
    const dir = createTempRepo("hunk-git-untracked-pathspec-");

    writeFileSync(join(dir, "tracked.ts"), "export const tracked = 1;\n");
    git(dir, "add", "tracked.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = true;\n");
    writeFileSync(join(dir, "beta.ts"), "export const beta = true;\n");

    const bootstrap = await loadFromRepo(dir, {
      kind: "git",
      staged: false,
      pathspecs: ["beta.ts"],
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual(["beta.ts"]);
  });

  test("loads show output for the latest commit and an explicit ref", async () => {
    const dir = createTempRepo("hunk-show-");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
    writeFileSync(join(dir, "beta.ts"), "export const beta = 1;\n");
    git(dir, "add", "alpha.ts", "beta.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 2;\n");
    git(dir, "add", "alpha.ts");
    git(dir, "commit", "-m", "update alpha");

    writeFileSync(join(dir, "beta.ts"), "export const beta = 2;\n");
    git(dir, "add", "beta.ts");
    git(dir, "commit", "-m", "update beta");

    const latest = await loadFromRepo(dir, {
      kind: "show",
      options: { mode: "auto" },
    });
    const previous = await loadFromRepo(dir, {
      kind: "show",
      ref: "HEAD~1",
      options: { mode: "auto" },
    });

    expect(latest.changeset.files.map((file) => file.path)).toEqual(["beta.ts"]);
    expect(previous.changeset.files.map((file) => file.path)).toEqual(["alpha.ts"]);
  });

  test("reports a friendly error when show cannot resolve a ref", async () => {
    const dir = createTempRepo("hunk-show-missing-ref-");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
    git(dir, "add", "alpha.ts");
    git(dir, "commit", "-m", "initial");

    await expect(
      loadFromRepo(dir, {
        kind: "show",
        ref: "HEAD~999",
        options: { mode: "auto" },
      }),
    ).rejects.toThrow("`hunk show HEAD~999` could not resolve Git ref `HEAD~999`.");
  });

  test("loads show output limited by pathspec", async () => {
    const dir = createTempRepo("hunk-show-pathspec-");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
    writeFileSync(join(dir, "beta.ts"), "export const beta = 1;\n");
    git(dir, "add", "alpha.ts", "beta.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 2;\n");
    writeFileSync(join(dir, "beta.ts"), "export const beta = 2;\n");
    git(dir, "add", "alpha.ts", "beta.ts");
    git(dir, "commit", "-m", "update both");

    const bootstrap = await loadFromRepo(dir, {
      kind: "show",
      ref: "HEAD",
      pathspecs: ["alpha.ts"],
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual(["alpha.ts"]);
  });

  test("loads show output when diff.noprefix is enabled", async () => {
    const dir = createTempRepo("hunk-show-noprefix-");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
    git(dir, "add", "alpha.ts");
    git(dir, "commit", "-m", "initial");

    git(dir, "config", "--local", "diff.noprefix", "true");
    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 2;\n");
    git(dir, "add", "alpha.ts");
    git(dir, "commit", "-m", "update alpha");

    const bootstrap = await loadFromRepo(dir, {
      kind: "show",
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual(["alpha.ts"]);
  });

  test("loads stash show output as a full review changeset", async () => {
    const dir = createTempRepo("hunk-stash-");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
    git(dir, "add", "alpha.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 2;\n");
    git(dir, "stash", "push", "-m", "update alpha");

    const bootstrap = await loadFromRepo(dir, {
      kind: "stash-show",
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual(["alpha.ts"]);
    expect(bootstrap.changeset.title).toContain("stash");
  });

  test("loads stash show output when diff.noprefix is enabled", async () => {
    const dir = createTempRepo("hunk-stash-noprefix-");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
    git(dir, "add", "alpha.ts");
    git(dir, "commit", "-m", "initial");

    git(dir, "config", "--local", "diff.noprefix", "true");
    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 2;\n");
    git(dir, "stash", "push", "-m", "update alpha");

    const bootstrap = await loadFromRepo(dir, {
      kind: "stash-show",
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files.map((file) => file.path)).toEqual(["alpha.ts"]);
  });

  test("reports a friendly error when no stash entries exist", async () => {
    const dir = createTempRepo("hunk-stash-empty-");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
    git(dir, "add", "alpha.ts");
    git(dir, "commit", "-m", "initial");

    await expect(
      loadFromRepo(dir, {
        kind: "stash-show",
        options: { mode: "auto" },
      }),
    ).rejects.toThrow("`hunk stash show` could not find a stash entry to show.");
  });

  test("reports a friendly error when a stash ref does not exist", async () => {
    const dir = createTempRepo("hunk-stash-missing-ref-");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
    git(dir, "add", "alpha.ts");
    git(dir, "commit", "-m", "initial");

    writeFileSync(join(dir, "alpha.ts"), "export const alpha = 2;\n");
    git(dir, "stash", "push", "-m", "update alpha");

    await expect(
      loadFromRepo(dir, {
        kind: "stash-show",
        ref: "stash@{99}",
        options: { mode: "auto" },
      }),
    ).rejects.toThrow("`hunk stash show stash@{99}` could not resolve stash entry `stash@{99}`.");
  });

  test("treats malformed inline patch text as an empty review instead of throwing", async () => {
    const bootstrap = await loadAppBootstrap({
      kind: "patch",
      text: [
        "\u001b]0;title\u0007not really a patch",
        "--- separator only",
        "@@ section heading",
        "still plain text",
      ].join("\n"),
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files).toHaveLength(0);
    expect(bootstrap.changeset.title).toContain("Patch review");
    expect(bootstrap.changeset.summary).toContain("not really a patch");
  });

  test("loads colorized git patch files like the real pager stdin stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-patch-"));
    tempDirs.push(dir);

    const before = join(dir, "before.ts");
    const after = join(dir, "after.ts");
    const patch = join(dir, "input.patch");

    writeFileSync(before, "export const answer = 41;\n");
    writeFileSync(after, "export const answer = 42;\nexport const added = true;\n");

    const diffProc = Bun.spawnSync(
      ["git", "diff", "--no-index", "--color=always", "--", before, after],
      {
        cwd: dir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (diffProc.exitCode !== 0 && diffProc.exitCode !== 1) {
      const stderr = Buffer.from(diffProc.stderr).toString("utf8");
      throw new Error(stderr.trim() || `git diff --color=always failed`);
    }

    writeFileSync(patch, Buffer.from(diffProc.stdout).toString("utf8"));

    const bootstrap = await loadAppBootstrap({
      kind: "patch",
      file: patch,
      options: { mode: "auto" },
    });

    expect(bootstrap.changeset.files).toHaveLength(1);
    expect(bootstrap.changeset.files[0]?.path.endsWith("after.ts")).toBe(true);
    expect(bootstrap.changeset.files[0]?.stats.additions).toBeGreaterThan(0);
  });
});
