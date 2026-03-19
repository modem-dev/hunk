import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliInput } from "../src/core/types";
import { persistViewPreferences, resolveConfiguredCliInput } from "../src/core/config";
import { loadAppBootstrap } from "../src/core/loaders";

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
      [
        'theme = "paper"',
        "wrap_lines = true",
        "",
        "[pager]",
        "hunk_headers = false",
      ].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput({ agentNotes: true }), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.repoConfigPath).toBe(join(repo, ".hunk", "config.toml"));
    expect(resolved.persistencePath).toBe(join(repo, ".hunk", "config.toml"));
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

  test("falls back to the global config path outside a repo", () => {
    const home = createTempDir("hunk-config-home-");
    const cwd = createTempDir("hunk-config-cwd-");

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd,
      env: { HOME: home },
    });

    expect(resolved.repoConfigPath).toBeUndefined();
    expect(resolved.persistencePath).toBe(join(home, ".config", "hunk", "config.toml"));
  });

  test("persists top-level preferences without discarding profile sections", () => {
    const repo = createTempDir("hunk-config-repo-");
    const configPath = join(repo, ".hunk", "config.toml");

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      configPath,
      [
        'recent_themes = ["paper", "midnight"]',
        '',
        '[pager]',
        'mode = "stack"',
        '',
        '[git]',
        'wrap_lines = true',
      ].join('\n'),
    );

    persistViewPreferences(configPath, {
      mode: "split",
      theme: "midnight",
      showLineNumbers: false,
      wrapLines: true,
      showHunkHeaders: false,
      showAgentNotes: true,
    });

    const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(parsed.mode).toBe("split");
    expect(parsed.theme).toBe("midnight");
    expect(parsed.line_numbers).toBe(false);
    expect(parsed.wrap_lines).toBe(true);
    expect(parsed.hunk_headers).toBe(false);
    expect(parsed.agent_notes).toBe(true);
    expect(parsed.recent_themes).toEqual(["paper", "midnight"]);
    expect((parsed.pager as Record<string, unknown>).mode).toBe("stack");
    expect((parsed.git as Record<string, unknown>).wrap_lines).toBe(true);
  });

  test("preserves TOML array-of-table sections when persisting view preferences", () => {
    const repo = createTempDir("hunk-config-repo-");
    const configPath = join(repo, ".hunk", "config.toml");

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      configPath,
      [
        'theme = "paper"',
        '',
        '[[bookmarks]]',
        'path = "src/a.ts"',
        'hunk = 0',
        '',
        '[[bookmarks]]',
        'path = "src/b.ts"',
        'hunk = 2',
      ].join('\n'),
    );

    persistViewPreferences(configPath, {
      mode: "split",
      theme: "paper",
      showLineNumbers: true,
      wrapLines: false,
      showHunkHeaders: true,
      showAgentNotes: false,
    });

    const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(parsed.bookmarks).toEqual([
      { path: "src/a.ts", hunk: 0 },
      { path: "src/b.ts", hunk: 2 },
    ]);
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
        'line_numbers = false',
        'wrap_lines = true',
        'hunk_headers = false',
        'agent_notes = true',
      ].join('\n'),
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
});
