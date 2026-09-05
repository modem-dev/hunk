import type { AppBootstrap } from "../../packages/hunk/src/core/bootstrap";
import type { DiffFile } from "../../packages/hunk/src/core/changeset/model";
import type {
  VcsDiffCommandInput,
  LayoutMode,
} from "../../packages/hunk/src/core/run/commandInputs";

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
  initialShowMenuBar = !pager,
  sourceLabel = "repo",
  summary,
  title = "repo working tree",
}: {
  agentSummary?: string;
  changesetId?: string;
  files: DiffFile[];
  vcsOptions?: Partial<VcsDiffCommandInput["options"]>;
  initialMode?: LayoutMode;
  initialCopyDecorations?: boolean;
  initialShowAgentNotes?: boolean;
  initialShowHunkHeaders?: boolean;
  initialShowLineNumbers?: boolean;
  initialShowMenuBar?: boolean;
  initialTheme?: string;
  initialWrapLines?: boolean;
  inputMode?: LayoutMode;
  pager?: boolean;
  sourceLabel?: string;
  summary?: string;
  title?: string;
}): AppBootstrap {
  return {
    reloadContext: { cwd: sourceLabel },
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
    initialShowMenuBar,
    initialTheme,
    initialWrapLines,
  };
}
