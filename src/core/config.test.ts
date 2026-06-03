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

  test("merges custom theme overrides from global and repo config", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        'theme = "custom"',
        "",
        "[custom_theme]",
        'base = "midnight"',
        'label = "Global Custom"',
        'accent = "#123456"',
        "",
        "[custom_theme.syntax]",
        'keyword = "#abcdef"',
      ].join("\n"),
    );

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      [
        'theme = "custom"',
        "",
        "[custom_theme]",
        'label = "Repo Custom"',
        'panel = "#654321"',
        "",
        "[custom_theme.syntax]",
        'string = "#fedcba"',
      ].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.input.options.theme).toBe("custom");
    expect(resolved.customTheme).toEqual({
      base: "midnight",
      label: "Repo Custom",
      accent: "#123456",
      panel: "#654321",
      syntax: {
        keyword: "#abcdef",
        string: "#fedcba",
      },
    });
  });

  test.each([
    "graphite",
    "midnight",
    "paper",
    "ember",
    "catppuccin-latte",
    "catppuccin-frappe",
    "catppuccin-macchiato",
    "catppuccin-mocha",
    "zenburn",
  ])("accepts custom theme base id: %s", (base) => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[custom_theme]", `base = "${base}"`].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: createTempDir("hunk-config-cwd-"),
      env: { HOME: home },
    });

    expect(resolved.customTheme).toEqual({ base });
  });

  test("rejects invalid custom theme base ids", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[custom_theme]", 'base = "unknown"'].join("\n"),
    );

    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), {
        cwd: createTempDir("hunk-config-cwd-"),
        env: { HOME: home },
      }),
    ).toThrow(
      "Expected custom_theme.base to be one of: graphite, midnight, paper, ember, catppuccin-latte, catppuccin-frappe, catppuccin-macchiato, catppuccin-mocha, zenburn.",
    );
  });

  test("rejects invalid custom theme color values", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[custom_theme]", 'accent = "blue"'].join("\n"),
    );

    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), {
        cwd: createTempDir("hunk-config-cwd-"),
        env: { HOME: home },
      }),
    ).toThrow("Expected custom_theme.accent to be a hex color like #112233.");
  });

  test("rejects theme = custom when no [custom_theme] table is configured", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), 'theme = "custom"\n');

    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), {
        cwd: createTempDir("hunk-config-cwd-"),
        env: { HOME: home },
      }),
    ).toThrow('Expected a [custom_theme] table when config selects theme = "custom".');
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

  test.each([
    {
      name: "enables watch from config",
      config: "watch = true\n",
      cliOptions: {},
      expected: true,
    },
    {
      name: "disables watch from config",
      config: "watch = false\n",
      cliOptions: {},
      expected: false,
    },
    {
      name: "defaults watch to false",
      config: "",
      cliOptions: {},
      expected: false,
    },
    {
      name: "lets CLI enable watch over config",
      config: "watch = false\n",
      cliOptions: { watch: true },
      expected: true,
    },
    {
      name: "lets CLI disable watch over config",
      config: "watch = true\n",
      cliOptions: { watch: false },
      expected: false,
    },
  ] satisfies Array<{
    name: string;
    config: string;
    cliOptions: Partial<CliInput["options"]>;
    expected: boolean;
  }>)("resolves watch: $name", ({ config, cliOptions, expected }) => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), config);

    const resolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: cliOptions,
      },
      { cwd: createTempDir("hunk-config-cwd-"), env: { HOME: home } },
    );

    expect(resolved.input.options.watch).toBe(expected);
  });

  test("defaults to git VCS mode and accepts registered VCS modes from config", () => {
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

  test("auto-detects registered VCS checkouts before falling back to git mode", () => {
    const home = createTempDir("hunk-config-home-");
    const jjRepo = createTempDir("hunk-config-jj-repo-");
    const colocatedRepo = createTempDir("hunk-config-colocated-repo-");
    const gitRepo = createTempDir("hunk-config-git-repo-");
    const parentJjRepo = createTempDir("hunk-config-parent-jj-");
    const gitRepoInsideParentJj = join(parentJjRepo, "git-project");
    const plainDir = createTempDir("hunk-config-no-repo-");

    createJjRepo(jjRepo);
    createRepo(colocatedRepo);
    createJjRepo(colocatedRepo);
    createRepo(gitRepo);
    createJjRepo(parentJjRepo);
    createRepo(gitRepoInsideParentJj);

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
      resolveConfiguredCliInput(input, { cwd: gitRepoInsideParentJj, env: { HOME: home } }).input
        .options.vcs,
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
        "copy_decorations = false",
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
    expect(bootstrap.initialCopyDecorations).toBe(false);
  });

  test("loadAppBootstrap carries the configured custom theme into the UI bootstrap", async () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        'theme = "custom"',
        "",
        "[custom_theme]",
        'base = "paper"',
        'accent = "#7755aa"',
        "",
        "[custom_theme.syntax]",
        'comment = "#998877"',
      ].join("\n"),
    );

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
    const bootstrap = await loadAppBootstrap(resolved.input, { customTheme: resolved.customTheme });

    expect(bootstrap.initialTheme).toBe("custom");
    expect(bootstrap.customTheme).toEqual({
      base: "paper",
      accent: "#7755aa",
      syntax: {
        comment: "#998877",
      },
    });
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
});
