import { describe, expect, test } from "bun:test";
import type { CliInput } from "../core/run/commandInputs";
import {
  deriveWorkspaceRefreshRequest,
  withCurrentReviewViewOptions,
  type CurrentReviewViewOptions,
} from "./currentReviewRefresh";

const currentView: CurrentReviewViewOptions = {
  layoutMode: "split",
  themeId: "nord",
  showAgentNotes: false,
  showHunkHeaders: false,
  showLineNumbers: false,
  showMenuBar: false,
  wrapLines: true,
};

describe("current review refresh descriptor", () => {
  test("applies every current view option while retaining unrelated input options", () => {
    const input: CliInput = {
      kind: "diff",
      left: "before.ts",
      right: "after.ts",
      options: { mode: "stack", theme: "dracula", watch: true, tabWidth: 8 },
    };

    expect(withCurrentReviewViewOptions(input, currentView)).toEqual({
      ...input,
      options: {
        ...input.options,
        mode: "split",
        theme: "nord",
        agentNotes: false,
        hunkHeaders: false,
        lineNumbers: false,
        menuBar: false,
        wrapLines: true,
      },
    });
    expect(input.options).toEqual({ mode: "stack", theme: "dracula", watch: true, tabWidth: 8 });
  });

  test("attaches the source path only to VCS inputs", () => {
    const fileRequest = deriveWorkspaceRefreshRequest({
      input: {
        kind: "diff",
        left: "before.ts",
        right: "after.ts",
        options: {},
      },
      sourceLabel: "/repo",
      view: currentView,
    });
    const vcsRequest = deriveWorkspaceRefreshRequest({
      input: { kind: "vcs", staged: false, options: {} },
      sourceLabel: "/repo",
      view: currentView,
    });

    expect(fileRequest?.sourcePath).toBeUndefined();
    expect(vcsRequest?.sourcePath).toBe("/repo");
  });

  test("does not create a descriptor for stdin-backed content or sidecars", () => {
    expect(
      deriveWorkspaceRefreshRequest({
        input: { kind: "patch", text: "diff --git a/a b/a", options: {} },
        sourceLabel: "stdin",
        view: currentView,
      }),
    ).toBeNull();
    expect(
      deriveWorkspaceRefreshRequest({
        input: {
          kind: "diff",
          left: "before.ts",
          right: "after.ts",
          options: { agentContext: "-" },
        },
        sourceLabel: "/repo",
        view: currentView,
      }),
    ).toBeNull();
  });
});
