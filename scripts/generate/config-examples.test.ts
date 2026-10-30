import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCli } from "../../packages/hunk/src/app/cli";
import { resolveConfiguredCliInput } from "../../packages/hunk/src/core/run/config";
import type { CliInput } from "../../packages/hunk/src/core/run/commandInputs";
import { renderConfigReference } from "./generate-docs";

const directories: string[] = [];

/** Create isolated user and project configs for documentation examples. */
function createTestConfigFiles(userConfig: string, repoConfig?: string) {
  const root = mkdtempSync(join(tmpdir(), "hunk-doc-config-"));
  directories.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(join(home, ".config", "hunk"), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(home, ".config", "hunk", "config.toml"), userConfig);

  if (repoConfig !== undefined) {
    mkdirSync(join(cwd, ".hunk"));
    writeFileSync(join(cwd, ".hunk", "config.toml"), repoConfig);
  }

  return { cwd, env: { HOME: home } };
}

/** Read a documented TOML block by its parsed table shape. */
function findTestTomlBlock(markdown: string, matches: (value: Record<string, unknown>) => boolean) {
  for (const match of markdown.matchAll(/```toml\n([\s\S]*?)```/g)) {
    const text = match[1]!;
    if (matches(Bun.TOML.parse(text) as Record<string, unknown>)) {
      return text;
    }
  }

  throw new Error("Missing documented TOML example.");
}

/** Parse documented invocations through the real CLI before resolving preferences. */
async function resolveTestInvocation(
  args: string[],
  files: ReturnType<typeof createTestConfigFiles>,
) {
  const input = await parseCli(["bun", "hunk", ...args]);
  if (!input || !("options" in input)) {
    throw new Error("Expected a configurable review invocation.");
  }

  return resolveConfiguredCliInput(input as CliInput, files);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const pages = {
  reference: renderConfigReference(),
  guide: readFileSync(
    resolve(import.meta.dir, "../../website/src/content/docs/docs/configure/configuration.md"),
    "utf8",
  ),
};

for (const [name, markdown] of Object.entries(pages)) {
  describe(`${name} configuration examples`, () => {
    test("all TOML snippets parse", () => {
      const snippets = [...markdown.matchAll(/```toml\n([\s\S]*?)```/g)];
      expect(snippets.length).toBeGreaterThan(5);
      for (const snippet of snippets) {
        expect(() => Bun.TOML.parse(snippet[1]!)).not.toThrow();
      }
    });

    test("starter config supplies the documented defaults", async () => {
      const config = findTestTomlBlock(markdown, (value) => value.theme === "terminal");
      const { input } = await resolveTestInvocation(["diff"], createTestConfigFiles(config));
      expect(input.options.theme).toBe("terminal");
      expect(input.options.mode).toBe("auto");
      expect(input.options.lineNumbers).toBe(true);
      expect(input.options.wrapLines).toBe(false);
    });

    test("command overrides produce the documented results and inherit omitted settings", async () => {
      const config = findTestTomlBlock(markdown, (value) =>
        Boolean(value.vcs && value.show && value.diff),
      );
      const files = createTestConfigFiles(config);
      const vcs = await resolveTestInvocation(["diff"], files);
      expect(vcs.input.options.mode).toBe("split");
      expect(vcs.input.options.watch).toBe(true);
      expect(vcs.input.options.wrapLines).toBe(false);

      const show = await resolveTestInvocation(["show"], files);
      expect(show.input.options.mode).toBe("unified");
      expect(show.input.options.watch).toBe(false);

      const pair = await resolveTestInvocation(["diff", "--files", "before.ts", "after.ts"], files);
      expect(pair.input.options.mode).toBe("auto");
      expect(pair.input.options.wrapLines).toBe(true);
      expect(pair.input.options.watch).toBe(false);

      const override = await resolveTestInvocation(["show", "--mode", "split"], files);
      expect(override.input.options.mode).toBe("split");

      const noWrap = await resolveTestInvocation(
        ["diff", "--no-wrap"],
        createTestConfigFiles("wrap_lines = true"),
      );
      expect(noWrap.input.options.wrapLines).toBe(false);
    });

    test("repository shared settings beat user command settings, and flags win last", async () => {
      const user = findTestTomlBlock(markdown, (value) => Boolean(value.show) && !value.vcs);
      const repo = findTestTomlBlock(markdown, (value) => value.mode === "split" && !value.show);
      const files = createTestConfigFiles(user, repo);
      expect((await resolveTestInvocation(["show"], files)).input.options.mode).toBe("split");
      expect(
        (await resolveTestInvocation(["show", "--mode", "unified"], files)).input.options.mode,
      ).toBe("unified");
    });

    test("pager table overrides a command only for pager sessions, and flags still win", () => {
      const pager = findTestTomlBlock(markdown, (value) => Boolean(value.pager));
      const files = createTestConfigFiles(
        `wrap_lines = false\n[patch]\nwrap_lines = false\nmode = "split"\n${pager}`,
      );
      const interactive = resolveConfiguredCliInput(
        { kind: "patch", file: "-", options: {} },
        files,
      );
      expect(interactive.input.options.wrapLines).toBe(false);
      expect(interactive.input.options.mode).toBe("split");

      const paged = resolveConfiguredCliInput(
        { kind: "patch", file: "-", options: { pager: true } },
        files,
      );
      expect(paged.input.options.wrapLines).toBe(true);
      expect(paged.input.options.mode).toBe("unified");

      const explicit = resolveConfiguredCliInput(
        { kind: "patch", file: "-", options: { pager: true, wrapLines: false } },
        files,
      );
      expect(explicit.input.options.wrapLines).toBe(false);
    });

    test("documented keybindings load only from user config", () => {
      const bindings = findTestTomlBlock(markdown, (value) => Boolean(value.keybindings));
      const user = resolveConfiguredCliInput(
        { kind: "vcs", staged: false, options: {} },
        createTestConfigFiles(bindings),
      );
      expect(user.keybindings?.["hunk.review.nextHunk"]).toEqual(["]", "ctrl+n"]);
      expect(user.keybindings?.["hunk.app.quit"]).toBe("ctrl+x");

      const repo = resolveConfiguredCliInput(
        { kind: "vcs", staged: false, options: {} },
        createTestConfigFiles("", bindings),
      );
      expect(repo.keybindings).toEqual({});
    });
  });
}

test("reference theme and extension examples resolve against runtime metadata", () => {
  const custom = findTestTomlBlock(pages.reference, (value) => Boolean(value.custom_theme));
  const syntax = findTestTomlBlock(pages.reference, (value) =>
    Boolean((value.custom_theme as Record<string, unknown> | undefined)?.syntax_scopes),
  );
  const resolved = resolveConfiguredCliInput(
    { kind: "vcs", staged: false, options: {} },
    createTestConfigFiles(`${custom}\n${syntax}`),
  );
  expect(resolved.customThemes).toEqual([
    expect.objectContaining({ id: "custom", base: "catppuccin-mocha", accent: "#7fd1ff" }),
  ]);

  expect(resolved.customThemes[0]?.syntaxScopes).toEqual({
    comment: "#6e85a7",
    "punctuation.definition.comment": "#6e85a7",
  });

  const named = findTestTomlBlock(pages.reference, (value) => Boolean(value.themes));
  const themes = resolveConfiguredCliInput(
    { kind: "vcs", staged: false, options: {} },
    createTestConfigFiles(named),
  );
  expect(themes.input.options.theme).toBe("midnight-ink");
  expect(themes.customThemes.map(({ id }) => id)).toEqual(["midnight-ink", "paper-trail"]);

  const disabled = findTestTomlBlock(pages.reference, (value) => Boolean(value.extensions));
  const extensions = resolveConfiguredCliInput(
    { kind: "vcs", staged: false, options: {} },
    createTestConfigFiles(disabled),
  );
  expect(extensions.extensions.disabled).toContain("hunk.gh");

  const settings = findTestTomlBlock(pages.reference, (value) => Boolean(value.extension));
  const configured = resolveConfiguredCliInput(
    { kind: "vcs", staged: false, options: {} },
    createTestConfigFiles(settings),
  );
  expect(configured.extensions.extensionConfigs["collapse-generated"]).toEqual({
    patterns: ["*.lock", "generated/*"],
  });
});
