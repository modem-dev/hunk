import { describe, expect, test } from "bun:test";
import { parseCli } from "../src/core/cli";

describe("parseCli", () => {
  test("defaults to git mode when no subcommand is passed", async () => {
    const parsed = await parseCli(["bun", "hunk"]);

    expect(parsed.kind).toBe("git");
    expect(parsed.options.mode).toBe("auto");
    expect(parsed.options.theme).toBeUndefined();
  });

  test("parses diff mode with shared options", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "diff",
      "left.ts",
      "right.ts",
      "--mode",
      "split",
      "--theme",
      "paper",
      "--agent-context",
      "notes.json",
      "--pager",
    ]);

    expect(parsed).toMatchObject({
      kind: "diff",
      left: "left.ts",
      right: "right.ts",
      options: {
        mode: "split",
        theme: "paper",
        agentContext: "notes.json",
        pager: true,
      },
    });
  });
});
