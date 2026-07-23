import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliInput } from "./types";
import {
  diffPersistedViewPreferences,
  resolveConfiguredCliInput,
  saveGlobalViewPreferences,
  saveViewPreferencesPromptPreference,
} from "./config";
import { loadAppBootstrap } from "./loaders";
import { LEGACY_CUSTOM_SYNTAX_NOTICE, LEGACY_CUSTOM_SYNTAX_NOTICES } from "./startupNotice";

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

describe("config persistence", () => {
  test("writes accepted view preferences to user config without disturbing tables", () => {
    const home = createTempDir("hunk-save-config-home-");
    const configPath = join(home, ".config", "hunk", "config.toml");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "# personal defaults",
        'theme = "github-dark-default"',
        "wrap_lines = false",
        "",
        "[custom_theme]",
        'label = "Keep me"',
      ].join("\n"),
    );

    const savedPath = saveGlobalViewPreferences(
      {
        mode: "split",
        theme: "dracula",
        showLineNumbers: false,
        wrapLines: true,
        showHunkHeaders: false,
        showMenuBar: false,
        showAgentNotes: true,
        copyDecorations: true,
      },
      { env: { HOME: home } },
    );

    expect(savedPath).toBe(configPath);
    expect(readFileSync(configPath, "utf8")).toBe(
      [
        "# personal defaults",
        'theme = "dracula"',
        "wrap_lines = true",
        'mode = "split"',
        "line_numbers = false",
        "hunk_headers = false",
        "menu_bar = false",
        "agent_notes = true",
        "copy_decorations = true",
        "",
        "[custom_theme]",
        'label = "Keep me"',
        "",
      ].join("\n"),
    );
  });

  test("writes the view preferences prompt setting without disturbing tables", () => {
    const home = createTempDir("hunk-save-config-home-");
    const configPath = join(home, ".config", "hunk", "config.toml");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(configPath, ["# personal defaults", "", "[custom_theme]"].join("\n"));

    const savedPath = saveViewPreferencesPromptPreference(false, { env: { HOME: home } });

    expect(savedPath).toBe(configPath);
    expect(readFileSync(configPath, "utf8")).toBe(
      [
        "# personal defaults",
        "prompt_save_view_preferences = false",
        "",
        "[custom_theme]",
        "",
      ].join("\n"),
    );
  });

  test("diffs view preference snapshots as the TOML assignments a save would rewrite", () => {
    const initial = {
      mode: "auto",
      theme: "github-dark-default",
      showLineNumbers: false,
      wrapLines: false,
      showHunkHeaders: false,
      showMenuBar: true,
      showAgentNotes: true,
      copyDecorations: false,
    } as const;

    expect(diffPersistedViewPreferences(initial, { ...initial })).toEqual([]);
    expect(
      diffPersistedViewPreferences(initial, {
        ...initial,
        mode: "split",
        theme: "github-dark-dimmed",
        showLineNumbers: true,
      }),
    ).toEqual([
      {
        configKey: "theme",
        previousValue: '"github-dark-default"',
        nextValue: '"github-dark-dimmed"',
      },
      { configKey: "mode", previousValue: '"auto"', nextValue: '"split"' },
      { configKey: "line_numbers", previousValue: "false", nextValue: "true" },
    ]);
  });
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
        'theme = "github-dark-default"',
        "line_numbers = false",
        "tab_width = 8",
        "transparentBackground = true",
        "color_moved = true",
        "prompt_save_view_preferences = false",
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
      [
        'theme = "github-light-default"',
        "wrap_lines = true",
        "menu_bar = false",
        "",
        "[pager]",
        "hunk_headers = false",
      ].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(
      createPatchPagerInput({ agentNotes: true, tabWidth: 6 }),
      {
        cwd: repo,
        env: { HOME: home },
      },
    );

    expect(resolved.repoConfigPath).toBe(join(repo, ".hunk", "config.toml"));
    expect(resolved.viewPreferencesConfigPath).toBe(join(repo, ".hunk", "config.toml"));
    expect(resolved.input.options).toMatchObject({
      pager: true,
      mode: "stack",
      theme: "github-light-default",
      lineNumbers: false,
      tabWidth: 6,
      wrapLines: true,
      menuBar: false,
      hunkHeaders: false,
      agentNotes: true,
      promptSaveViewPreferences: false,
      transparentBackground: true,
      colorMoved: true,
    });
  });

  test("defaults tab width to 4 and rejects invalid configured widths", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    const input = createPatchPagerInput();
    expect(
      resolveConfiguredCliInput(input, { cwd: repo, env: { HOME: home } }).input.options.tabWidth,
    ).toBe(4);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    for (const invalid of ["0", "17", '"4"']) {
      writeFileSync(join(home, ".config", "hunk", "config.toml"), `tab_width = ${invalid}\n`);
      expect(() => resolveConfiguredCliInput(input, { cwd: repo, env: { HOME: home } })).toThrow(
        /tab_width/,
      );
    }
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
        'base = "github-dark-default"',
        'label = "Global Custom"',
        'accent = "#123456"',
        "",
        "[custom_theme.syntax_scopes]",
        '"keyword.control" = "#abcdef"',
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
        "[custom_theme.syntax_scopes]",
        '"string.quoted" = "#fedcba"',
      ].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.input.options.theme).toBe("custom");
    expect(resolved.customTheme).toEqual({
      base: "github-dark-default",
      label: "Repo Custom",
      accent: "#123456",
      panel: "#654321",
      syntaxScopes: {
        "keyword.control": "#abcdef",
        "string.quoted": "#fedcba",
      },
    });
    expect(resolved.startupNotices).toBeUndefined();
  });

  test.each(["github-dark-default", "github-light-default", "dracula", "catppuccin-mocha"])(
    "accepts custom theme base id: %s",
    (base) => {
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
    },
  );

  test("normalizes legacy custom theme base ids", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[custom_theme]", 'base = "graphite"'].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: createTempDir("hunk-config-cwd-"),
      env: { HOME: home },
    });

    expect(resolved.customTheme).toEqual({ base: "github-dark-default" });
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
    ).toThrow("Expected custom_theme.base to be a built-in theme id.");
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

  test("rejects invalid Shiki scope colors", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[custom_theme.syntax_scopes]", '"comment.line" = "white"'].join("\n"),
    );

    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), {
        cwd: createTempDir("hunk-config-cwd-"),
        env: { HOME: home },
      }),
    ).toThrow("Expected custom_theme.syntax_scopes.comment.line to be a hex color like #112233.");
  });

  test("temporarily translates the deprecated semantic syntax table into exact scopes", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        "[custom_theme.syntax]",
        'comment = "#ffffff"',
        "",
        "[custom_theme.syntax_scopes]",
        '"comment" = "#eeeeee"',
      ].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: createTempDir("hunk-config-cwd-"),
      env: { HOME: home },
    });

    expect(resolved.customTheme?.syntaxScopes).toEqual({
      comment: "#eeeeee",
      "punctuation.definition.comment": "#ffffff",
    });
    expect(resolved.startupNotices).toBe(LEGACY_CUSTOM_SYNTAX_NOTICES);
    expect(resolved.startupNotices).toEqual([LEGACY_CUSTOM_SYNTAX_NOTICE]);
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

  test("requires experimental features to be enabled by the launch CLI", () => {
    const home = createTempDir("hunk-config-experimental-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), "experimental = true\n");

    const normal = resolveConfiguredCliInput(createPatchPagerInput(), {
      env: { HOME: home },
    });
    const optedIn = resolveConfiguredCliInput(createPatchPagerInput({ experimental: true }), {
      env: { HOME: home },
    });

    expect(normal.input.options.experimental).toBe(false);
    expect(optedIn.input.options.experimental).toBe(true);
  });

  test("accepts transparent background config and CLI overrides", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), "transparent_background = true\n");

    const cwd = createTempDir("hunk-config-cwd-");
    const configured = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: {},
      },
      { cwd, env: { HOME: home } },
    );
    const overridden = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: { transparentBackground: false },
      },
      { cwd, env: { HOME: home } },
    );

    expect(configured.input.options.transparentBackground).toBe(true);
    expect(overridden.input.options.transparentBackground).toBe(false);
  });

  test("loads global config from USERPROFILE when HOME is unavailable", () => {
    const profile = createTempDir("hunk-config-profile-");
    mkdirSync(join(profile, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(profile, ".config", "hunk", "config.toml"),
      "transparent_background = true\n",
    );

    const configured = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: {},
      },
      {
        cwd: createTempDir("hunk-config-cwd-"),
        env: { USERPROFILE: profile },
      },
    );

    expect(configured.input.options.transparentBackground).toBe(true);
  });

  test("defaults unspecified themes to github-dark-default, including piped pager-style patch input", () => {
    const home = createTempDir("hunk-config-home-");
    const cwd = createTempDir("hunk-config-cwd-");

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd,
      env: { HOME: home },
    });

    expect(resolved.repoConfigPath).toBeUndefined();
    expect(resolved.viewPreferencesConfigPath).toBe(join(home, ".config", "hunk", "config.toml"));
    expect(resolved.input.options.theme).toBe("github-dark-default");
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
        'theme = "github-light-default"',
        "line_numbers = false",
        "tab_width = 8",
        "wrap_lines = true",
        "menu_bar = false",
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
    expect(bootstrap.initialTheme).toBe("github-light-default");
    expect(bootstrap.initialShowLineNumbers).toBe(false);
    expect(bootstrap.initialTabWidth).toBe(8);
    expect(bootstrap.initialWrapLines).toBe(true);
    expect(bootstrap.initialShowMenuBar).toBe(false);
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
        'base = "catppuccin-mocha"',
        'accent = "#7755aa"',
        "",
        "[custom_theme.syntax_scopes]",
        '"comment" = "#998877"',
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
      base: "catppuccin-mocha",
      accent: "#7755aa",
      syntaxScopes: {
        comment: "#998877",
      },
    });
  });

  test("loadAppBootstrap exposes github-dark-default when no theme is configured", async () => {
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

    expect(bootstrap.initialTheme).toBe("github-dark-default");
  });
});
