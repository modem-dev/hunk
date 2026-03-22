import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliInput } from "../src/core/types";
import { resolveConfiguredCliInput } from "../src/core/config";
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

  test("falls back to the global config path outside a repo", () => {
    const home = createTempDir("hunk-config-home-");
    const cwd = createTempDir("hunk-config-cwd-");

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd,
      env: { HOME: home },
    });

    expect(resolved.repoConfigPath).toBeUndefined();
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
});
