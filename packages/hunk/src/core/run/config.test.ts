import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledVcsCatalog } from "../../app/vcsCatalog";
import type { CliInput } from "./commandInputs";
import {
  diffPersistedViewPreferences,
  resolveConfiguredCliInput,
  resolveExtensionBootstrapConfig,
  saveGlobalViewPreferences,
  saveViewPreferencesPromptPreference,
} from "./config";
import { loadAppBootstrap } from "../changeset/loaders";
import {
  LEGACY_CUSTOM_SYNTAX_NOTICE,
  LEGACY_CUSTOM_SYNTAX_NOTICES,
} from "../process/startupNotice";

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
        cursorLine: "row",
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
        'cursor_line = "row"',
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
      cursorLine: "row",
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

  test("keeps fast highlighting launch-only instead of reading it from config", () => {
    const home = createTempDir("hunk-config-fast-home-");
    const repo = createTempDir("hunk-config-fast-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), "fast = true");

    const configured = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });
    const launched = resolveConfiguredCliInput(createPatchPagerInput({ fast: true }), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(configured.input.options.fast).toBe(false);
    expect(launched.input.options.fast).toBe(true);
  });

  test("reads the current-line style from config and lets CLI flags outrank it", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), 'cursor_line = "number"');

    const fromConfig = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });
    expect(fromConfig.input.options.cursorLine).toBe("number");

    const fromFlag = resolveConfiguredCliInput(createPatchPagerInput({ cursorLine: "off" }), {
      cwd: repo,
      env: { HOME: home },
    });
    expect(fromFlag.input.options.cursorLine).toBe("off");
  });

  test("falls back to the built-in current-line style when config names an unknown one", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), 'cursor_line = "sparkles"');

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.input.options.cursorLine).toBe("row");
  });

  test("starts pager mode with the menu bar hidden unless a later layer asks for it", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);
    const env = { HOME: home };

    expect(
      resolveConfiguredCliInput(createPatchPagerInput(), { cwd: repo, env }).input.options.menuBar,
    ).toBe(false);
    expect(
      resolveConfiguredCliInput({ kind: "patch", file: "-", options: {} }, { cwd: repo, env }).input
        .options.menuBar,
    ).toBe(true);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[pager]", "menu_bar = true"].join("\n"),
    );

    expect(
      resolveConfiguredCliInput(createPatchPagerInput(), { cwd: repo, env }).input.options.menuBar,
    ).toBe(true);
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

  test("defaults file and hunk gaps and rejects invalid configured values", () => {
    const home = createTempDir("hunk-config-gap-home-");
    const repo = createTempDir("hunk-config-gap-repo-");
    createRepo(repo);

    const input = createPatchPagerInput();
    const resolved = resolveConfiguredCliInput(input, { cwd: repo, env: { HOME: home } }).input
      .options;
    expect(resolved.fileGap).toBe(1);
    expect(resolved.hunkGap).toBe(0);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["file_gap = 3", "hunk_gap = 1"].join("\n"),
    );
    const configured = resolveConfiguredCliInput(input, { cwd: repo, env: { HOME: home } }).input
      .options;
    expect(configured.fileGap).toBe(3);
    expect(configured.hunkGap).toBe(1);

    for (const [key, invalid] of [
      ["file_gap", "-1"],
      ["file_gap", "9"],
      ["file_gap", '"2"'],
      ["hunk_gap", "9"],
    ] as const) {
      writeFileSync(join(home, ".config", "hunk", "config.toml"), `${key} = ${invalid}\n`);
      expect(() => resolveConfiguredCliInput(input, { cwd: repo, env: { HOME: home } })).toThrow(
        new RegExp(key),
      );
    }
  });

  test("resolves the sidebar preference from config, CLI flags, and the auto default", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    const resolveSidebar = (input: CliInput) =>
      resolveConfiguredCliInput(input, { cwd: repo, env: { HOME: home } }).input.options.sidebar;

    expect(resolveSidebar(createPatchPagerInput())).toBe("auto");

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), "sidebar = false\n");
    expect(resolveSidebar(createPatchPagerInput())).toBe(false);
    // `--sidebar` outranks the config layer.
    expect(resolveSidebar(createPatchPagerInput({ sidebar: true }))).toBe(true);

    // Values outside `true`, `false`, and "auto" fall back to the built-in default.
    writeFileSync(join(home, ".config", "hunk", "config.toml"), 'sidebar = "always"\n');
    expect(resolveSidebar(createPatchPagerInput())).toBe("auto");
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
    expect(resolved.customThemes).toEqual([
      {
        id: "custom",
        base: "github-dark-default",
        label: "Repo Custom",
        accent: "#123456",
        panel: "#654321",
        syntaxScopes: {
          "keyword.control": "#abcdef",
          "string.quoted": "#fedcba",
        },
      },
    ]);
    expect(resolved.startupNotices).toBeUndefined();
  });

  test("reads named [themes.<id>] tables in declaration order after [custom_theme]", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        'theme = "ocean"',
        "",
        "[custom_theme]",
        'base = "github-dark-default"',
        "",
        "[themes.ocean]",
        'base = "nord"',
        'label = "Ocean"',
        'accent = "#123456"',
        "",
        "[themes.ocean.syntax_scopes]",
        '"keyword.control" = "#abcdef"',
        "",
        "[themes.team_theme]",
        'base = "dracula"',
      ].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: createTempDir("hunk-config-cwd-"),
      env: { HOME: home },
    });

    expect(resolved.input.options.theme).toBe("ocean");
    expect(resolved.customThemes).toEqual([
      { id: "custom", base: "github-dark-default" },
      {
        id: "ocean",
        base: "nord",
        label: "Ocean",
        accent: "#123456",
        syntaxScopes: { "keyword.control": "#abcdef" },
      },
      { id: "team_theme", base: "dracula" },
    ]);
    expect(resolved.startupNotices).toBeUndefined();
  });

  test("layers named themes so repo config overrides the user layer per theme id", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        "[themes.ocean]",
        'base = "nord"',
        'label = "Ocean"',
        'accent = "#123456"',
        "",
        "[themes.ocean.syntax_scopes]",
        '"keyword.control" = "#abcdef"',
      ].join("\n"),
    );

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      [
        "[themes.ocean]",
        'label = "Repo Ocean"',
        'panel = "#654321"',
        "",
        "[themes.ocean.syntax_scopes]",
        '"string.quoted" = "#fedcba"',
        "",
        "[themes.repo-only]",
        'base = "dracula"',
      ].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.customThemes).toEqual([
      {
        id: "ocean",
        base: "nord",
        label: "Repo Ocean",
        accent: "#123456",
        panel: "#654321",
        syntaxScopes: {
          "keyword.control": "#abcdef",
          "string.quoted": "#fedcba",
        },
      },
      { id: "repo-only", base: "dracula" },
    ]);
  });

  test("keeps [custom_theme] as the custom id and reports the shadowed [themes.custom] table", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[custom_theme]", 'accent = "#123456"', "", "[themes.custom]", 'accent = "#654321"'].join(
        "\n",
      ),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: createTempDir("hunk-config-cwd-"),
      env: { HOME: home },
    });

    expect(resolved.customThemes).toEqual([{ id: "custom", accent: "#123456" }]);
    expect(resolved.startupNotices).toEqual([
      {
        key: "theme:collision:config:custom",
        message: 'Skipped theme "custom" from config • [custom_theme] already defines it',
      },
    ]);
  });

  test("skips named themes with unusable ids instead of failing startup", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        '[themes."Ocean Dark"]',
        'base = "nord"',
        "",
        "[themes.dracula]",
        'base = "nord"',
        "",
        "[themes.ocean]",
        'base = "nord"',
      ].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: createTempDir("hunk-config-cwd-"),
      env: { HOME: home },
    });

    expect(resolved.customThemes).toEqual([{ id: "ocean", base: "nord" }]);
    expect(resolved.startupNotices?.map((notice) => notice.message)).toEqual([
      'Skipped theme "Ocean Dark" from config • theme ids must be lowercase words separated by - or _',
      'Skipped theme "dracula" from config • that id belongs to a built-in theme',
    ]);
  });

  test("reports named theme validation errors against the key the user wrote", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[themes.ocean]", 'accent = "blue"'].join("\n"),
    );

    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), {
        cwd: createTempDir("hunk-config-cwd-"),
        env: { HOME: home },
      }),
    ).toThrow("Expected themes.ocean.accent to be a hex color like #112233.");
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

      expect(resolved.customThemes).toEqual([{ id: "custom", base }]);
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

    expect(resolved.customThemes).toEqual([{ id: "custom", base: "github-dark-default" }]);
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

    expect(resolved.customThemes[0]?.syntaxScopes).toEqual({
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

  test("carries an unrecognized vcs id through for extensions to claim", () => {
    // Config resolves before user extensions are imported, so it cannot know
    // whether `hg` will exist. Dropping it here discarded the user's explicit
    // choice silently; `resolveSessionVcsId` settles it once adapters are known.
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), 'vcs = "hg"\n');

    const resolved = resolveConfiguredCliInput(
      { kind: "vcs", staged: false, options: {} },
      { cwd: createTempDir("hunk-config-cwd-"), env: { HOME: home } },
    );

    expect(resolved.input.options.vcs).toBe("hg");
  });

  test("reports whether the resolved vcs id was chosen or detected", () => {
    // The merged value cannot answer this: an explicit `vcs = "git"` and a
    // detected Git checkout both resolve to "git", and only the explicit one
    // outranks the detection that runs again once extension backends load.
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), 'vcs = "git"\n');
    const cwd = createTempDir("hunk-config-cwd-");

    const configured = resolveConfiguredCliInput(
      { kind: "vcs", staged: false, options: {} },
      { cwd, env: { HOME: home } },
    );
    const detected = resolveConfiguredCliInput(
      { kind: "vcs", staged: false, options: {} },
      { cwd, env: { HOME: createTempDir("hunk-config-empty-home-") } },
    );

    expect(configured.input.options.vcs).toBe("git");
    expect(configured.explicitVcsId).toBe("git");
    expect(detected.input.options.vcs).toBe("git");
    expect(detected.explicitVcsId).toBeUndefined();
  });

  test("ignores a non-string vcs value", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), "vcs = 7\n");

    const resolved = resolveConfiguredCliInput(
      { kind: "vcs", staged: false, options: {} },
      { cwd: createTempDir("hunk-config-cwd-"), env: { HOME: home } },
    );

    expect(resolved.input.options.vcs).toBe("git");
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
    const resolveIn = (cwd: string) =>
      resolveConfiguredCliInput(input, {
        cwd,
        env: { HOME: home },
        vcsCatalog: getBundledVcsCatalog(),
      }).input.options.vcs;

    expect(resolveIn(jjRepo)).toBe("jj");
    expect(resolveIn(colocatedRepo)).toBe("jj");
    expect(resolveIn(gitRepo)).toBe("git");
    expect(resolveIn(gitRepoInsideParentJj)).toBe("git");
    expect(resolveIn(plainDir)).toBe("git");
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
        "file_gap = 3",
        "hunk_gap = 1",
        "wrap_lines = true",
        "menu_bar = false",
        "sidebar = true",
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
    expect(bootstrap.initialFileGap).toBe(3);
    expect(bootstrap.initialHunkGap).toBe(1);
    expect(bootstrap.initialWrapLines).toBe(true);
    expect(bootstrap.initialShowMenuBar).toBe(false);
    expect(bootstrap.initialSidebar).toBe(true);
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
    const bootstrap = await loadAppBootstrap(resolved.input, {
      customThemes: resolved.customThemes,
    });

    expect(bootstrap.initialTheme).toBe("custom");
    expect(bootstrap.customThemes).toEqual([
      {
        id: "custom",
        base: "catppuccin-mocha",
        accent: "#7755aa",
        syntaxScopes: {
          comment: "#998877",
        },
      },
    ]);
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

describe("extension configuration", () => {
  test("defaults to enabled with no configured paths or per-extension tables", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.extensions).toEqual({
      enabled: true,
      paths: [],
      repoPaths: [],
      extensionConfigs: {},
    });
  });

  test("reads [extensions] and keeps repo paths separate from user paths", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[extensions]", 'paths = ["~/dev/copy-as.ts", 7, ""]', "unknown_key = true"].join("\n"),
    );

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      ["[extensions]", 'paths = ["./tools/policy.ts"]'].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.extensions.enabled).toBe(true);
    expect(resolved.extensions.paths).toEqual(["~/dev/copy-as.ts"]);
    expect(resolved.extensions.repoPaths).toEqual(["./tools/policy.ts"]);
  });

  test("reads [keybindings] from the user layer only", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        "[keybindings]",
        '"hunk.app.quit" = "ctrl+x"',
        '"hunk.review.nextHunk" = ["]", "ctrl+n"]',
        '"hunk.view.toggleMenuBar" = false',
        '"hunk.app.refresh" = 7',
      ].join("\n"),
    );

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      ["[keybindings]", '"hunk.app.quit" = "ctrl+q"'].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });

    // The repo layer is ignored on purpose: keys belong to the reader's machine.
    expect(resolved.keybindings).toEqual({
      "hunk.app.quit": "ctrl+x",
      "hunk.review.nextHunk": ["]", "ctrl+n"],
      "hunk.view.toggleMenuBar": false,
    });
    // The entry with an unusable value is skipped, and said so.
    expect(
      resolved.startupNotices?.some((notice) => notice.message.includes("hunk.app.refresh")),
    ).toBe(true);
  });

  test("lets repo config disable extensions and --no-extensions win over both layers", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[extensions]", "enabled = true"].join("\n"),
    );
    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      ["[extensions]", "enabled = false"].join("\n"),
    );

    expect(
      resolveConfiguredCliInput(createPatchPagerInput(), { cwd: repo, env: { HOME: home } })
        .extensions.enabled,
    ).toBe(false);

    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      ["[extensions]", "enabled = true"].join("\n"),
    );

    expect(
      resolveConfiguredCliInput(createPatchPagerInput(), { cwd: repo, env: { HOME: home } })
        .extensions.enabled,
    ).toBe(true);
    expect(
      resolveConfiguredCliInput(createPatchPagerInput({ extensions: false }), {
        cwd: repo,
        env: { HOME: home },
      }).extensions.enabled,
    ).toBe(false);
  });

  test("passes [extension.<id>] tables through with repo keys overriding user keys", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        "[extension.copy-as]",
        'severity = "nit"',
        "wrap = true",
        "",
        "[extension.blame]",
        "max_age_days = 30",
      ].join("\n"),
    );

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      ["[extension.copy-as]", 'severity = "blocking"'].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.extensions.extensionConfigs).toEqual({
      "copy-as": { severity: "blocking", wrap: true },
      blame: { max_age_days: 30 },
    });
    // The repo steering a globally configured extension stays visible.
    expect(resolved.startupNotices?.map((notice) => notice.message)).toEqual([
      "Repo config overrides settings for extension(s): copy-as",
    ]);
  });

  test("says nothing when the repo config configures no extensions", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[extension.blame]", "max_age_days = 30"].join("\n"),
    );
    mkdirSync(join(repo, ".hunk"), { recursive: true });
    // An empty table sets nothing, so it is not an override worth reporting.
    writeFileSync(join(repo, ".hunk", "config.toml"), ["[extension.blame]"].join("\n"));

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.startupNotices).toBeUndefined();
  });

  test("lists every extension id the repo config sets options for", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      ["[extension.zebra]", 'binary = "/tmp/zebra"', "", "[extension.alpha]", "on = true"].join(
        "\n",
      ),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });

    // Reported even without a user-config table for those ids: a repo can
    // configure a globally installed extension it never declared.
    expect(resolved.startupNotices?.map((notice) => notice.message)).toEqual([
      "Repo config overrides settings for extension(s): alpha, zebra",
    ]);
  });

  test("resolves extension bootstrap config without review-only theme validation", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        'theme = "custom"',
        "",
        "[extensions]",
        'paths = ["/user/tools.ts"]',
        "",
        "[extension.tools]",
        'token = "user"',
      ].join("\n"),
    );
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      [
        "[extensions]",
        "enabled = true",
        'paths = ["./repo-tools.ts"]',
        "",
        "[extension.tools]",
        'token = "repo"',
      ].join("\n"),
    );

    const resolved = resolveExtensionBootstrapConfig({
      cwd: repo,
      env: { HOME: home },
      vcsCatalog: getBundledVcsCatalog(),
    });

    expect(resolved.extensions).toEqual({
      enabled: true,
      paths: ["/user/tools.ts"],
      repoPaths: ["./repo-tools.ts"],
      extensionConfigs: { tools: { token: "repo" } },
    });
    expect(resolved.projectRoot).toBe(repo);
    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), {
        cwd: repo,
        env: { HOME: home },
        vcsCatalog: getBundledVcsCatalog(),
      }),
    ).toThrow('Expected a [custom_theme] table when config selects theme = "custom".');
    expect(
      resolveExtensionBootstrapConfig({
        cwd: repo,
        env: { HOME: home },
        vcsCatalog: getBundledVcsCatalog(),
        extensionsEnabled: false,
      }).extensions.enabled,
    ).toBe(false);
  });

  test("rejects malformed extension sections", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });

    writeFileSync(join(home, ".config", "hunk", "config.toml"), "extensions = true\n");
    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), { cwd: repo, env: { HOME: home } }),
    ).toThrow(/extensions to contain a TOML table/);

    writeFileSync(join(home, ".config", "hunk", "config.toml"), 'extension = "copy-as"\n');
    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), { cwd: repo, env: { HOME: home } }),
    ).toThrow(/per-extension TOML tables/);

    writeFileSync(join(home, ".config", "hunk", "config.toml"), "[extension]\ncopy-as = 1\n");
    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), { cwd: repo, env: { HOME: home } }),
    ).toThrow(/\[extension.copy-as\] to contain a TOML table/);
  });
});
