import type { AppBootstrap, DiffFile, GitCommandInput, LayoutMode } from "../../src/core/types";

export function createTestGitAppBootstrap({
  agentSummary,
  changesetId = "changeset:test",
  files,
  gitOptions = {},
  initialMode = "split",
  initialShowAgentNotes,
  initialShowHunkHeaders,
  initialShowLineNumbers,
  initialTheme = "midnight",
  initialWrapLines,
  inputMode = initialMode,
  pager = false,
  sourceLabel = "repo",
  summary,
  title = "repo working tree",
}: {
  agentSummary?: string;
  changesetId?: string;
  files: DiffFile[];
  gitOptions?: Partial<GitCommandInput["options"]>;
  initialMode?: LayoutMode;
  initialShowAgentNotes?: boolean;
  initialShowHunkHeaders?: boolean;
  initialShowLineNumbers?: boolean;
  initialTheme?: string;
  initialWrapLines?: boolean;
  inputMode?: LayoutMode;
  pager?: boolean;
  sourceLabel?: string;
  summary?: string;
  title?: string;
}): AppBootstrap {
  return {
    input: {
      kind: "git",
      staged: false,
      options: {
        mode: inputMode,
        pager,
        ...gitOptions,
      },
    },
    changeset: {
      agentSummary,
      files,
      id: changesetId,
      sourceLabel,
      summary,
      title,
    },
    initialMode,
    initialShowAgentNotes,
    initialShowHunkHeaders,
    initialShowLineNumbers,
    initialTheme,
    initialWrapLines,
  };
}
