import { describe, expect, test } from "bun:test";
import { buildGitDiffArgs, buildGitStashShowArgs, runGitText } from "./git";

describe("git command helpers", () => {
  test("enables deterministic color-moved output for patch parsing", () => {
    const args = buildGitDiffArgs(
      {
        kind: "vcs",
        staged: false,
        options: { mode: "auto" },
      },
      [],
      { mode: "zebra", whitespaceMode: "allow-indentation-change" },
    );

    expect(args).toContain("--color=always");
    expect(args).toContain("--color-moved=zebra");
    expect(args).toContain("--color-moved-ws=allow-indentation-change");
    expect(args).not.toContain("--no-color");
    expect(args).toContain("color.diff.oldMoved=magenta bold");
    expect(args).toContain("color.diff.newMoved=cyan bold");
  });

  test("disables external diff tools for stash patches", () => {
    const args = buildGitStashShowArgs({
      kind: "stash-show",
      options: { mode: "auto" },
    });

    expect(args).toContain("--no-ext-diff");
  });

  test("reports a friendly error when git is not installed or not on PATH", () => {
    expect(() =>
      runGitText({
        input: {
          kind: "vcs",
          staged: false,
          options: { mode: "auto" },
        },
        args: ["status"],
        gitExecutable: "definitely-not-a-real-git-binary",
      }),
    ).toThrow(
      "Git is required for `hunk diff`, but `definitely-not-a-real-git-binary` was not found in PATH.",
    );
  });
});
