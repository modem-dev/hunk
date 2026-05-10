import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliInput } from "./types";
import { resolveConfiguredCliInput } from "./config";
import { loadAppBootstrap } from "./loaders";

const tempDirs: string[] = [];

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createRepo(dir: string) {
  mkdirSync(join(dir, ".git"), { recursive: true });
}

function createJjRepo(dir: string) {
  mkdirSync(join(dir, ".jj"), { recursive: true });
}

function createPatchPagerInput(overrides: Partial<CliInput["options"]> = {}): CliInput {
  return {
    kind: "patch",
    file: "-",
    options: {
      pager: true,
      ...overrides,
    },
  };
}

afterEach(() => {
  cleanupTempDirs();
});

describe("config resolution", () => {
  test("merges global, repo, pager, command, and CLI overrides in the right order", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        'theme = "graphite"',
        "line_numbers = false",
        "",
        "[patch]",
        'mode = "split"',
        "",
        "[pager]",
        'mode = "stack"',
      ].join("\n"),
    );

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      ['theme = "paper"', "wrap_lines = true", "", "[pager]", "hunk_headers = false"].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput({ agentNotes: true }), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.repoConfigPath).toBe(join(repo, ".hunk", "config.toml"));
    expect(resolved.input.options).toMatchObject({
      pager: true,
      mode: "stack",
      theme: "paper",
      lineNumbers: false,
      wrapLines: true,
      hunkHeaders: false,
      agentNotes: true,
    });
  });

  test("defaults unspecified themes to graphite, including piped pager-style patch input", () => {
    const home = createTempDir("hunk-config-home-");
    const cwd = createTempDir("hunk-config-cwd-");

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd,
      env: { HOME: home },
    });

    expect(resolved.repoConfigPath).toBeUndefined();
    expect(resolved.input.options.theme).toBe("graphite");
  });

  test("command-specific config sections also apply to show mode", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[show]", 'mode = "stack"', "line_numbers = false"].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(
      {
        kind: "show",
        ref: "HEAD~1",
        options: {},
      },
      { cwd: createTempDir("hunk-config-cwd-"), env: { HOME: home } },
    );

    expect(resolved.input.options.mode).toBe("stack");
    expect(resolved.input.options.lineNumbers).toBe(false);
  });

  test("defaults git diff to include untracked files and honors config plus CLI overrides", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), "exclude_untracked = true\n");

    const cwd = createTempDir("hunk-config-cwd-");
    const defaultResolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: {},
      },
      { cwd, env: { HOME: home } },
    );
    const overriddenResolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: { excludeUntracked: false },
      },
      { cwd, env: { HOME: home } },
    );
    const noConfigHome = createTempDir("hunk-config-home-");
    const fallbackResolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: {},
      },
      { cwd, env: { HOME: noConfigHome } },
    );

    expect(defaultResolved.input.options.excludeUntracked).toBe(true);
    expect(overriddenResolved.input.options.excludeUntracked).toBe(false);
    expect(fallbackResolved.input.options.excludeUntracked).toBe(false);
  });

  test("defaults to git VCS mode and accepts jj from config", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), 'vcs = "jj"\n');

    const cwd = createTempDir("hunk-config-cwd-");
    const defaultResolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: {},
      },
      { cwd, env: { HOME: createTempDir("hunk-config-empty-home-") } },
    );
    const configuredResolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: {},
      },
      { cwd, env: { HOME: home } },
    );

    expect(defaultResolved.input.options.vcs).toBe("git");
    expect(configuredResolved.input.options.vcs).toBe("jj");
  });

  test("auto-detects jj checkouts before falling back to git mode", () => {
    const home = createTempDir("hunk-config-home-");
    const jjRepo = createTempDir("hunk-config-jj-repo-");
    const colocatedRepo = createTempDir("hunk-config-colocated-repo-");
    const gitRepo = createTempDir("hunk-config-git-repo-");
    const plainDir = createTempDir("hunk-config-no-repo-");

    createJjRepo(jjRepo);
    createRepo(colocatedRepo);
    createJjRepo(colocatedRepo);
    createRepo(gitRepo);

    const input = {
      kind: "vcs",
      staged: false,
      options: {},
    } satisfies CliInput;

    expect(
      resolveConfiguredCliInput(input, { cwd: jjRepo, env: { HOME: home } }).input.options.vcs,
    ).toBe("jj");
    expect(
      resolveConfiguredCliInput(input, { cwd: colocatedRepo, env: { HOME: home } }).input.options
        .vcs,
    ).toBe("jj");
    expect(
      resolveConfiguredCliInput(input, { cwd: gitRepo, env: { HOME: home } }).input.options.vcs,
    ).toBe("git");
    expect(
      resolveConfiguredCliInput(input, { cwd: plainDir, env: { HOME: home } }).input.options.vcs,
    ).toBe("git");
  });

  test("explicit config overrides auto-detected jj mode", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-jj-repo-");
    createJjRepo(repo);

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(join(repo, ".hunk", "config.toml"), 'vcs = "git"\n');

    const resolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: {},
      },
      { cwd: repo, env: { HOME: home } },
    );

    expect(resolved.input.options.vcs).toBe("git");
  });

  test("loadAppBootstrap exposes resolved initial preferences to the UI", async () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        'theme = "paper"',
        "line_numbers = false",
        "wrap_lines = true",
        "hunk_headers = false",
        "agent_notes = true",
      ].join("\n"),
    );

    const before = join(repo, "before.ts");
    const after = join(repo, "after.ts");
    writeFileSync(before, "export const alpha = 1;\n");
    writeFileSync(after, "export const alpha = 2;\nexport const beta = true;\n");

    const resolved = resolveConfiguredCliInput(
      {
        kind: "diff",
        left: before,
        right: after,
        options: {},
      },
      { cwd: repo, env: { HOME: home } },
    );
    const bootstrap = await loadAppBootstrap(resolved.input);

    expect(bootstrap.initialMode).toBe("auto");
    expect(bootstrap.initialTheme).toBe("paper");
    expect(bootstrap.initialShowLineNumbers).toBe(false);
    expect(bootstrap.initialWrapLines).toBe(true);
    expect(bootstrap.initialShowHunkHeaders).toBe(false);
    expect(bootstrap.initialShowAgentNotes).toBe(true);
  });

  test("loadAppBootstrap exposes graphite when no theme is configured", async () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    const before = join(repo, "before.ts");
    const after = join(repo, "after.ts");
    writeFileSync(before, "export const alpha = 1;\n");
    writeFileSync(after, "export const alpha = 2;\n");

    const resolved = resolveConfiguredCliInput(
      {
        kind: "diff",
        left: before,
        right: after,
        options: {},
      },
      { cwd: repo, env: { HOME: home } },
    );
    const bootstrap = await loadAppBootstrap(resolved.input);

    expect(bootstrap.initialTheme).toBe("graphite");
  });

  test("repo keybindings.global override surfaces on the resolved keymap", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      [
        "[keybindings.global]",
        'quit = ["<c-c>", "x"]',
        '"sidebar.toggle" = "<disabled>"',
        "",
      ].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(
      {
        kind: "patch",
        file: "-",
        options: { pager: false },
      },
      { cwd: repo, env: { HOME: home } },
    );
    const keymap = resolved.input.options.keymap;
    expect(keymap).toBeDefined();
    if (!keymap) return;

    const quit = keymap.global.quit ?? [];
    expect(quit).toHaveLength(2);
    // disabled action should be present but empty.
    expect(keymap.global["sidebar.toggle"]).toEqual([]);
    // unrelated defaults still present.
    expect(keymap.global["help.toggle"]?.length ?? 0).toBeGreaterThan(0);
  });

  test("repo keybindings override user-level keybindings", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[keybindings.global]", 'quit = "x"', ""].join("\n"),
    );

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      ["[keybindings.global]", 'quit = "y"', ""].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(
      {
        kind: "patch",
        file: "-",
        options: { pager: false },
      },
      { cwd: repo, env: { HOME: home } },
    );
    const keymap = resolved.input.options.keymap;
    expect(keymap).toBeDefined();
    if (!keymap) return;

    const quit = keymap.global.quit ?? [];
    expect(quit).toHaveLength(1);
    expect(quit[0]?.sequence).toBe("y");
  });

  test("warns when a config file's root is not a TOML object", () => {
    const home = createTempDir("hunk-config-home-");
    const cwd = createTempDir("hunk-config-cwd-");

    // The defensive branch at config.ts:147 catches a non-record root from
    // Bun.TOML.parse. Real TOML files always parse to a table, so this is
    // exercised by stubbing the parser to return an array — which is the
    // shape `isRecord` rejects via its `Array.isArray` guard.
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), "foo = 1\n");

    const originalParse = Bun.TOML.parse;
    Bun.TOML.parse = ((_input: string) => [1, 2, 3]) as typeof Bun.TOML.parse;

    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const resolved = resolveConfiguredCliInput(
        {
          kind: "patch",
          file: "-",
          options: { pager: false },
        },
        { cwd, env: { HOME: home } },
      );

      expect(captured.some((line) => line.includes("not a TOML object"))).toBe(true);
      // Defaults still apply despite the bad root shape.
      expect(resolved.input.options.theme).toBe("graphite");
      expect(resolved.input.options.keymap?.global.quit?.[0]?.sequence).toBe("q");
    } finally {
      process.stderr.write = originalWrite;
      Bun.TOML.parse = originalParse;
    }
  });

  test("malformed TOML config does not abort startup", async () => {
    const home = createTempDir("hunk-config-home-");
    const cwd = createTempDir("hunk-config-cwd-");

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      'theme = "graphite\n[keybindings.global\nquit = "y"\n',
    );

    // Silence the expected stderr warning so the test runner stays clean.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const resolved = resolveConfiguredCliInput(
        {
          kind: "patch",
          file: "-",
          options: { pager: false },
        },
        { cwd, env: { HOME: home } },
      );

      // Defaults preserved despite the malformed file.
      expect(resolved.input.options.theme).toBe("graphite");
      expect(resolved.input.options.keymap?.global.quit?.[0]?.sequence).toBe("q");
      expect(captured.some((line) => line.includes("parse error"))).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
