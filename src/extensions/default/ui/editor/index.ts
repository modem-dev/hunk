import type { ExtensionFactory } from "hunkdiff/extension";
import { editorCommandForLocation, editorUsesTerminal } from "./editorApp";

export const BUNDLED_EDITOR_COMMAND_ID = "review.editSelectedFile";
export const BUNDLED_EDITOR_COMMAND_FULL_ID = `hunk.${BUNDLED_EDITOR_COMMAND_ID}`;

/** Register Hunk's editor workflow through the public app-handoff contract. */
const registerBundledEditor: ExtensionFactory = (hunk) => {
  let editorOpen = false;

  hunk.registerCommand(
    {
      id: BUNDLED_EDITOR_COMMAND_ID,
      title: "Open the selected file in your editor",
    },
    async (ctx) => {
      const editor = process.env.EDITOR?.trim();
      if (!editor) {
        ctx.notify("$EDITOR is not set.", "warning");
        return;
      }

      const file = ctx.selection.file;
      if (!file) {
        ctx.notify("No file selected.", "warning");
        return;
      }
      const location = ctx.workspace.resolveLocation({
        fileId: file.id,
        ...(ctx.selection.hunkIndex === null ? {} : { hunkIndex: ctx.selection.hunkIndex }),
        ...(ctx.selection.currentLine === null ? {} : { line: ctx.selection.currentLine }),
      });
      if (!location) {
        ctx.notify(`Cannot resolve ${file.path} on disk.`, "warning");
        return;
      }
      const selected = editorCommandForLocation({
        editor,
        ...location,
        reviewPath: file.path,
      });
      if (!selected.ok) {
        ctx.notify(selected.detail, "warning");
        return;
      }

      if (editorOpen) {
        ctx.notify("An editor is already open.", "warning");
        return;
      }

      editorOpen = true;
      try {
        const runEditor = async () => {
          const child = Bun.spawn([selected.command.command, ...selected.command.args], {
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          });
          return await child.exited;
        };
        const exitCode = editorUsesTerminal(editor)
          ? await ctx.openInApp(runEditor)
          : await runEditor();

        if (exitCode !== 0) {
          ctx.notify(`Editor exited with status ${exitCode}.`, "error");
          return;
        }
        ctx.commands.execute("hunk.app.refresh");
      } catch (error) {
        ctx.notify(
          `Failed to launch editor: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } finally {
        editorOpen = false;
      }
    },
  );
};

export default registerBundledEditor;
