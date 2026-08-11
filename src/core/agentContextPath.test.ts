import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CliInput } from "./types";
import {
  agentContextTargetId,
  canonicalizeAgentContextTarget,
  conventionalAgentContextPath,
  HUNK_DIR_NAME,
  normalizeAgentContextPathspecs,
} from "./paths";

function vcs(overrides: Partial<Extract<CliInput, { kind: "vcs" }>> = {}): CliInput {
  return {
    kind: "vcs",
    staged: false,
    options: {},
    ...overrides,
  };
}

describe("agent-context target identity", () => {
  test("same inputs produce the same target id", () => {
    const left = agentContextTargetId(vcs({ range: "main...HEAD" }));
    const right = agentContextTargetId(vcs({ range: "main...HEAD" }));
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{12}$/);
  });

  test("working-tree id differs from a range id", () => {
    const workingTree = agentContextTargetId(vcs());
    const range = agentContextTargetId(vcs({ range: "main...HEAD" }));
    expect(workingTree).not.toBe(range);
  });

  test("staged differs from working-tree", () => {
    expect(agentContextTargetId(vcs({ staged: true }))).not.toBe(agentContextTargetId(vcs()));
  });

  test("pathspec order does not change the id", () => {
    const a = agentContextTargetId(vcs({ pathspecs: ["src/b.ts", "src/a.ts"] }));
    const b = agentContextTargetId(vcs({ pathspecs: ["src/a.ts", "src/b.ts"] }));
    expect(a).toBe(b);
  });

  test("show and stash-show ids differ from working-tree", () => {
    const show: CliInput = { kind: "show", ref: "HEAD", options: {} };
    const stash: CliInput = { kind: "stash-show", ref: "stash@{0}", options: {} };
    const workingTree = agentContextTargetId(vcs());
    expect(agentContextTargetId(show)).not.toBe(workingTree);
    expect(agentContextTargetId(stash)).not.toBe(workingTree);
    expect(agentContextTargetId(show)).not.toBe(agentContextTargetId(stash));
  });

  test("file and patch inputs have no auto-discovery id", () => {
    expect(
      agentContextTargetId({ kind: "diff", left: "a.ts", right: "b.ts", options: {} }),
    ).toBeNull();
    expect(agentContextTargetId({ kind: "patch", file: "p.patch", options: {} })).toBeNull();
    expect(canonicalizeAgentContextTarget({ kind: "patch", options: {} })).toBeNull();
  });

  test("conventional path embeds the target id under .hunk/", () => {
    const input = vcs({ range: "main...HEAD" });
    const id = agentContextTargetId(input);
    const path = conventionalAgentContextPath("/repo", input);
    expect(path).toBe(join("/repo", HUNK_DIR_NAME, `agent-context.${id}.json`));
    expect(path).not.toContain("agent-context.json");
    expect(path?.endsWith(`agent-context.${id}.json`)).toBe(true);
  });

  test("normalizeAgentContextPathspecs trims empties and sorts", () => {
    expect(normalizeAgentContextPathspecs(["  b ", "", "a"])).toEqual(["a", "b"]);
    expect(normalizeAgentContextPathspecs(undefined)).toEqual([]);
  });
});
