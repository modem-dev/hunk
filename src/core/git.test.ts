import { describe, expect, test } from "bun:test";
import { runGitText } from "./git";

describe("git command helpers", () => {
  test("reports a friendly error when git is not installed or not on PATH", () => {
    expect(() =>
      runGitText({
        input: {
          kind: "git",
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
