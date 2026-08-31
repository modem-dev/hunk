import type { ExtensionFactory } from "hunkdiff/extension";

export const BUNDLED_EDITOR_COMMAND_ID = "review.editSelectedFile";
export const BUNDLED_EDITOR_COMMAND_FULL_ID = `hunk.${BUNDLED_EDITOR_COMMAND_ID}`;

/** Register Hunk's host-mediated editor workflow through the public command contract. */
const registerBundledEditor: ExtensionFactory = (hunk) => {
  hunk.registerCommand(
    {
      id: BUNDLED_EDITOR_COMMAND_ID,
      title: "Open the selected file in your editor",
    },
    async (ctx) => {
      const file = ctx.selection.file;
      if (!file) {
        ctx.notify("No file selected.", "warning");
        return;
      }

      const result = await ctx.workspace.openInEditor({
        fileId: file.id,
        ...(ctx.selection.hunkIndex === null ? {} : { hunkIndex: ctx.selection.hunkIndex }),
        ...(ctx.selection.currentLine === null ? {} : { line: ctx.selection.currentLine }),
      });
      if (!result.ok) {
        ctx.notify(result.detail, result.reason === "failed" ? "error" : "warning");
      }
    },
  );
};

export default registerBundledEditor;
