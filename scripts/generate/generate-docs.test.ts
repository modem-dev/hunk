import { afterEach, describe, expect, test } from "bun:test";
import { GITHUB_CLI_REFERENCE } from "@hunk/gh";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CONFIG_COMMAND_SECTIONS,
  CONFIG_REFERENCE_CUSTOM_THEME,
  CONFIG_REFERENCE_OPTIONS,
} from "../../packages/hunk/src/core/run/config";
import { renderHunkReviewSkill } from "../../packages/hunk/src/hunk-review/skillDocument";
import { SESSION_AGENT_COMMAND_LIST } from "../../packages/hunk/src/session/agent/surface";
import {
  DEFAULT_SESSION_BROKER_HOST,
  DEFAULT_SESSION_BROKER_PORT,
  SESSION_BROKER_HOST_ENV,
  SESSION_BROKER_PORT_ENV,
  UNSAFE_ALLOW_REMOTE_SESSION_BROKER_ENV,
} from "../../packages/hunk/src/session/broker/brokerConfig";
import { LEGACY_THEME_ID_ALIASES } from "../../packages/hunk/src/core/theme/catalog";
import { parseCli } from "../../packages/hunk/src/app/cli";
import {
  CONFIG_REFERENCE_GROUPS,
  CONFIG_THEME_COLOR_DESCRIPTIONS,
  generateDocsArtifacts,
  GENERATED_DOC_PATHS,
  renderCliReference,
  renderConfigReference,
  updateGeneratedDocs,
} from "./generate-docs";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("generated website references", () => {
  test("renders representative review, utility, session, and comment commands", () => {
    const reference = renderCliReference();

    expect(reference).toContain("hunk diff --staged");
    expect(reference).toContain("--no-transparent-bg");
    expect(reference).toContain("hunk markup render");
    expect(reference).toContain("hunk log [target] [-- <pathspec...>]");
    const statusSection = reference.split("## `hunk status`")[1]!.split("\n## ")[0]!;
    expect(statusSection).toContain("`--vcs <id>`");
    expect(statusSection).toContain("Q returns or quits");
    expect(reference.split("## `hunk status`")[0]).not.toContain("`--vcs <id>`");
    expect(reference).toMatch(
      new RegExp(
        `\\| \\x60${SESSION_BROKER_HOST_ENV}\\x60\\s+\\| Bind host; defaults to loopback \\x60${DEFAULT_SESSION_BROKER_HOST}\\x60\\.`,
      ),
    );
    expect(reference).toMatch(
      new RegExp(
        `\\| \\x60${SESSION_BROKER_PORT_ENV}\\x60\\s+\\| Bind port; defaults to \\x60${DEFAULT_SESSION_BROKER_PORT}\\x60\\.`,
      ),
    );
    expect(reference).toContain(`\`${UNSAFE_ALLOW_REMOTE_SESSION_BROKER_ENV}\``);
    for (const command of SESSION_AGENT_COMMAND_LIST) {
      expect(reference).toContain(`hunk ${command.name}`);
      for (const option of command.options) {
        expect(reference).toContain(option.flag);
      }
    }
    expect(reference).toContain("for `--file` navigation, exactly one of");
  });

  test("documents every top-level command listed in `hunk --help`", async () => {
    const help = await parseCli(["bun", "hunk", "--help"]);
    if (help.kind !== "help") throw new Error("Expected top-level help output.");
    const commandBlock = help.text.split("Commands:\n")[1]!.split("\n\n")[0]!;
    const commandPaths = new Set(
      commandBlock.split("\n").map((line) => {
        const usage = line.trim().split(/\s{2,}/)[0]!;
        const words = usage.split(" ").slice(1);
        const argumentIndex = words.findIndex((word) => /^[[<(-]/.test(word));
        return words.slice(0, argumentIndex < 0 ? undefined : argumentIndex).join(" ");
      }),
    );
    const reference = renderCliReference();

    expect(commandPaths).toContain("log");
    expect(commandPaths).toContain("gh");
    for (const path of commandPaths) {
      expect(reference).toMatch(new RegExp(`^## \x60hunk ${path}[\x60 ]`, "m"));
    }
  });

  test("renders the bundled GitHub command from its help metadata", () => {
    const reference = renderCliReference();
    const githubSection = reference.split("## `hunk gh`")[1]!.split("\n## ")[0]!;

    expect(reference.indexOf("## `hunk log`")).toBeLessThan(reference.indexOf("## `hunk gh`"));
    for (const option of GITHUB_CLI_REFERENCE.options) {
      expect(githubSection).toContain(`\`${option.flag}\``);
    }
    for (const subcommand of GITHUB_CLI_REFERENCE.subcommands) {
      expect(githubSection).toContain(`### \`hunk gh ${subcommand.name}\``);
      for (const form of subcommand.forms) {
        expect(githubSection).toContain(`hunk gh ${subcommand.name} ${form.args}`.trimEnd());
      }
    }
    expect(githubSection).toContain("`GH_TOKEN`, then `GITHUB_TOKEN`");
    expect(githubSection).toContain("--disable-extension hunk.gh");
  });

  test("renders every runtime-parsed config key with defaults and compatibility metadata", () => {
    const reference = renderConfigReference();

    for (const option of CONFIG_REFERENCE_OPTIONS) {
      expect(reference).toContain(`\`${option.key}\``);
    }
    expect(reference).toContain("`transparentBackground` (deprecated)");
    expect(reference).toContain("`[custom_theme.syntax_scopes]`");
    expect(reference).toContain("`[vcs]`");
    expect(reference).toContain("`[pager]`");
    expect(reference).toContain("`$HOME/.config/hunk/config.toml`");
    expect(reference).toContain("`%USERPROFILE%/.config/hunk/config.toml`");
    for (const [alias, replacement] of Object.entries(LEGACY_THEME_ID_ALIASES)) {
      expect(reference).toMatch(
        new RegExp(`\\| \\x60${alias}\\x60\\s+\\| \\x60${replacement}\\x60\\s+\\|`),
      );
    }
  });

  test("groups every preference exactly once and gives every theme color a description", () => {
    const keys: string[] = Object.values(CONFIG_REFERENCE_GROUPS).flat();
    expect([...keys].sort()).toEqual(CONFIG_REFERENCE_OPTIONS.map(({ key }) => key).sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(CONFIG_THEME_COLOR_DESCRIPTIONS).sort()).toEqual(
      [...CONFIG_REFERENCE_CUSTOM_THEME.colorKeys].sort(),
    );

    const reference = renderConfigReference();
    for (const key of keys) {
      expect(reference.split(`#### \`${key}\``)).toHaveLength(2);
    }
    for (const section of Object.keys(CONFIG_COMMAND_SECTIONS)) {
      expect(reference).toContain(`\`[${section}]\``);
    }
    expect(reference.indexOf("## Command tables")).toBeLessThan(
      reference.indexOf("## Preference keys"),
    );
    expect(reference.indexOf("### Named themes")).toBeLessThan(
      reference.indexOf("### Built-in theme ids"),
    );
    expect(reference).toContain("/docs/configure/configuration/");
    expect(reference).toContain("/docs/configure/keybindings/");
    expect(reference).not.toContain("Override the panelAlt semantic color");
    expect(reference).not.toContain("**Built-in default:** —");
  });

  test("publishes the agent skill directly from its authoritative renderer", () => {
    const artifacts = generateDocsArtifacts();

    expect(artifacts[GENERATED_DOC_PATHS.agentSkill]).toBe(renderHunkReviewSkill());
    expect(artifacts[GENERATED_DOC_PATHS.agentSkill]).toContain(
      "hunk session review --repo . --json",
    );
  });

  test("check mode detects stale output without modifying it", () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-generated-docs-"));
    tempDirectories.push(directory);
    const path = join(directory, "reference.md");
    writeFileSync(path, "stale\n");

    const stalePaths = updateGeneratedDocs({
      check: true,
      artifacts: { [path]: "current\n" },
    });

    expect(stalePaths).toEqual([path]);
    expect(readFileSync(path, "utf8")).toBe("stale\n");
  });

  test("generation updates stale output and a second check is clean", () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-generated-docs-"));
    tempDirectories.push(directory);
    const path = join(directory, "reference.md");
    const artifacts = { [path]: "current\n" };

    expect(updateGeneratedDocs({ artifacts })).toEqual([path]);
    expect(readFileSync(path, "utf8")).toBe("current\n");
    expect(updateGeneratedDocs({ check: true, artifacts })).toEqual([]);
  });
});
