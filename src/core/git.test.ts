import { describe, expect, test } from "bun:test";
import { buildGitStashShowArgs, runGitText } from "./git";

describe("git command helpers", () => {
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
