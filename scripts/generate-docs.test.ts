import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_REFERENCE_OPTIONS } from "../packages/hunk/src/core/run/config";
import { renderHunkReviewSkill } from "../packages/hunk/src/hunk-review/skillDocument";
import { SESSION_AGENT_COMMAND_LIST } from "../packages/hunk/src/session/agent/surface";
import {
  DEFAULT_SESSION_BROKER_HOST,
  DEFAULT_SESSION_BROKER_PORT,
  SESSION_BROKER_HOST_ENV,
  SESSION_BROKER_PORT_ENV,
  UNSAFE_ALLOW_REMOTE_SESSION_BROKER_ENV,
} from "../packages/hunk/src/session/broker/brokerConfig";
import { LEGACY_THEME_ID_ALIASES } from "../packages/hunk/src/core/theme/catalog";
import {
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
    expect(reference).not.toContain("## `hunk log`");
    expect(reference).not.toContain("`--vcs <id>`");
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
