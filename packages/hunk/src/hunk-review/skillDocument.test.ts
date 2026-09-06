import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentOptionFlagName,
  AUXILIARY_AGENT_OPTIONS,
  SESSION_AGENT_COMMAND_LIST,
} from "../session/agent/surface";
import { renderHunkReviewSkill } from "./skillDocument";

const SKILL_PATH = join(import.meta.dir, "..", "..", "skills", "hunk-review", "SKILL.md");
const AGENT_WORKFLOWS_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "agent-workflows.md",
);

/** Every flag the agent-facing docs may reference: the session surface plus auxiliary options. */
const DOCUMENTED_AGENT_FLAGS = new Set([
  ...SESSION_AGENT_COMMAND_LIST.flatMap((spec) => spec.options.map(agentOptionFlagName)),
  ...Object.values(AUXILIARY_AGENT_OPTIONS).map(agentOptionFlagName),
]);

/** Flags of non-hunk shell tools that appear inside doc examples (e.g. curl). */
const NON_HUNK_SHELL_FLAGS = new Set(["--data"]);

/** Normalize checkout line endings so the comparison stays portable on Windows. */
function normalizeNewlines(text: string) {
  return text.replaceAll("\r\n", "\n");
}

describe("hunk-review skill document", () => {
  test("checked-in SKILL.md matches the generated document", () => {
    const checkedIn = normalizeNewlines(readFileSync(SKILL_PATH, "utf8"));
    const rendered = renderHunkReviewSkill();

    if (checkedIn !== rendered) {
      throw new Error(
        "packages/hunk/skills/hunk-review/SKILL.md is out of date. Run `bun run generate:skill` and commit the result.",
      );
    }

    expect(checkedIn).toBe(rendered);
  });

  test("only mentions flags that exist on the declared agent surface", () => {
    const mentioned = renderHunkReviewSkill().match(/--[a-z][a-z-]*/g) ?? [];

    expect(mentioned.length).toBeGreaterThan(0);
    for (const flag of mentioned) {
      expect(DOCUMENTED_AGENT_FLAGS).toContain(flag);
    }
  });

  test("docs/agent-workflows.md only references declared agent flags", () => {
    const mentioned = readFileSync(AGENT_WORKFLOWS_PATH, "utf8").match(/--[a-z][a-z-]*/g) ?? [];

    expect(mentioned.length).toBeGreaterThan(0);
    for (const flag of mentioned) {
      if (NON_HUNK_SHELL_FLAGS.has(flag)) {
        continue;
      }
      expect(DOCUMENTED_AGENT_FLAGS).toContain(flag);
    }
  });

  test("documents every session command's synopsis", () => {
    const rendered = renderHunkReviewSkill();
    for (const spec of SESSION_AGENT_COMMAND_LIST) {
      for (const line of spec.synopsis) {
        expect(rendered).toContain(line);
      }
    }
  });
});
