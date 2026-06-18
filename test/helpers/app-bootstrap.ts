import type { AppBootstrap, DiffFile, VcsCommandInput, LayoutMode } from "../../src/core/types";

export function createTestVcsAppBootstrap({
  agentSummary,
  changesetId = "changeset:test",
  files,
  vcsOptions = {},
  initialMode = "split",
  initialCopyDecorations,
  initialShowAgentNotes,
  initialShowHunkHeaders,
  initialShowLineNumbers,
  initialTheme = "github-dark-default",
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
  vcsOptions?: Partial<VcsCommandInput["options"]>;
  initialMode?: LayoutMode;
  initialCopyDecorations?: boolean;
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
      kind: "vcs",
      staged: false,
      options: {
        mode: inputMode,
        pager,
        ...vcsOptions,
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
    initialCopyDecorations,
    initialShowAgentNotes,
    initialShowHunkHeaders,
    initialShowLineNumbers,
    initialTheme,
    initialWrapLines,
  };
}
