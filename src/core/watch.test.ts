import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeConfigSignature, computeWatchSignature } from "./watch";
import type { CliInput } from "./types";

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);

  git(dir, "init", "--initial-branch", "master");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");

  return dir;
}

function withCwd<T>(cwd: string, callback: () => T) {
  const previousCwd = process.cwd();
  process.chdir(cwd);

  try {
    return callback();
  } finally {
    process.chdir(previousCwd);
  }
}

function createGitInput({
  options,
  ...overrides
}: {
  options?: Partial<Extract<CliInput, { kind: "vcs" }>["options"]>;
} & Partial<Omit<Extract<CliInput, { kind: "vcs" }>, "kind" | "options">> = {}) {
  return {
    kind: "vcs",
    staged: false,
    ...overrides,
    options: {
      mode: "auto",
      ...options,
    },
  } satisfies Extract<CliInput, { kind: "vcs" }>;
}

afterEach(() => {
  cleanupTempDirs();
});

describe("computeWatchSignature", () => {
  test("does not embed full untracked file contents in git watch signatures", () => {
    const dir = createTempRepo("hunk-watch-untracked-");

    writeFileSync(join(dir, "tracked.ts"), "export const tracked = 1;\n");
    git(dir, "add", "tracked.ts");
    git(dir, "commit", "-m", "initial");

    const largeMarker = "UNTRACKED-CONTENT-".repeat(1024);
    const untrackedPath = join(dir, "large-untracked.txt");
    writeFileSync(untrackedPath, largeMarker);

    const initialSignature = withCwd(dir, () => computeWatchSignature(createGitInput()));
    writeFileSync(untrackedPath, `${largeMarker}changed`);
    const changedSignature = withCwd(dir, () => computeWatchSignature(createGitInput()));

    expect(initialSignature).not.toContain(largeMarker);
    expect(changedSignature).not.toContain(largeMarker);
    expect(changedSignature).not.toEqual(initialSignature);
  });

  test("ignores untracked file changes when the git input excludes them", () => {
    const dir = createTempRepo("hunk-watch-exclude-untracked-");

    writeFileSync(join(dir, "tracked.ts"), "export const tracked = 1;\n");
    git(dir, "add", "tracked.ts");
    git(dir, "commit", "-m", "initial");

    const untrackedPath = join(dir, "note.txt");
    writeFileSync(untrackedPath, "first\n");

    const initialSignature = withCwd(dir, () =>
      computeWatchSignature(createGitInput({ options: { excludeUntracked: true } })),
    );
    writeFileSync(untrackedPath, "second\n");
    const changedSignature = withCwd(dir, () =>
      computeWatchSignature(createGitInput({ options: { excludeUntracked: true } })),
    );

    expect(changedSignature).toEqual(initialSignature);
  });

  test("rejects unsupported watch operations before invoking adapter signatures", () => {
    expect(() =>
      computeWatchSignature({
        kind: "stash-show",
        options: { mode: "auto", vcs: "jj" },
      }),
    ).toThrow("`hunk stash show` requires Git VCS mode.");
  });

  test("tracks untracked file changes when diff compares the working tree against one ref", () => {
    const dir = createTempRepo("hunk-watch-ref-untracked-");

    writeFileSync(join(dir, "tracked.ts"), "export const tracked = 1;\n");
    git(dir, "add", "tracked.ts");
    git(dir, "commit", "-m", "initial");
    git(dir, "branch", "main");

    writeFileSync(join(dir, "tracked.ts"), "export const tracked = 2;\n");
    git(dir, "add", "tracked.ts");
    git(dir, "commit", "-m", "second");

    const untrackedPath = join(dir, "note.txt");
    writeFileSync(untrackedPath, "first\n");

    const initialSignature = withCwd(dir, () =>
      computeWatchSignature(createGitInput({ range: "main" })),
    );
    writeFileSync(untrackedPath, "second\n");
    const changedSignature = withCwd(dir, () =>
      computeWatchSignature(createGitInput({ range: "main" })),
    );

    expect(changedSignature).not.toEqual(initialSignature);
  });
});

describe("computeConfigSignature", () => {
  const previousXdg = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (previousXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  test("marks a missing global config without throwing", () => {
    const configHome = realpathSync(mkdtempSync(join(tmpdir(), "hunk-cfg-missing-")));
    tempDirs.push(configHome);
    process.env.XDG_CONFIG_HOME = configHome;

    const nonRepo = realpathSync(mkdtempSync(join(tmpdir(), "hunk-cfg-nonrepo-")));
    tempDirs.push(nonRepo);

    const signature = computeConfigSignature(nonRepo);

    expect(signature).toContain(join(configHome, "hunk", "config.toml"));
    expect(signature).toContain(":missing");
  });

  test("changes when the global config file changes", () => {
    const configHome = realpathSync(mkdtempSync(join(tmpdir(), "hunk-cfg-change-")));
    tempDirs.push(configHome);
    process.env.XDG_CONFIG_HOME = configHome;
    mkdirSync(join(configHome, "hunk"), { recursive: true });
    const configPath = join(configHome, "hunk", "config.toml");

    const nonRepo = realpathSync(mkdtempSync(join(tmpdir(), "hunk-cfg-change-cwd-")));
    tempDirs.push(nonRepo);

    writeFileSync(configPath, 'theme = "custom"\n');
    const initialSignature = computeConfigSignature(nonRepo);

    writeFileSync(configPath, 'theme = "custom"\nborderless = true\n');
    const changedSignature = computeConfigSignature(nonRepo);

    expect(initialSignature).not.toContain(":missing");
    expect(changedSignature).not.toEqual(initialSignature);
  });

  test("includes the repo-local .hunk/config.toml when inside a repo", () => {
    const configHome = realpathSync(mkdtempSync(join(tmpdir(), "hunk-cfg-repo-home-")));
    tempDirs.push(configHome);
    process.env.XDG_CONFIG_HOME = configHome;

    const repo = createTempRepo("hunk-cfg-repo-");
    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(join(repo, ".hunk", "config.toml"), "menu_bar = false\n");

    const signature = computeConfigSignature(repo);

    expect(signature).toContain(join(repo, ".hunk", "config.toml"));
    expect(signature).not.toContain(`${join(repo, ".hunk", "config.toml")}:missing`);
  });
});
