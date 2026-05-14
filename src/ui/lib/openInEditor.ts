import { existsSync } from "node:fs";
import { basename, resolve, win32 } from "node:path";
import type { CliRenderer } from "@opentui/core";
import type { DiffFile } from "../../core/types";

export interface EditorCommand {
  command: string;
  args: string[];
}

function selectedLine(
  file: DiffFile,
  selectedHunk: DiffFile["metadata"]["hunks"][number] | undefined,
) {
  if (file.metadata.type === "deleted") {
    return selectedHunk?.deletionStart ?? 1;
  }

  return selectedHunk?.additionStart ?? 1;
}

function splitEditorCommand(editor: string) {
  return (
    editor
      .match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g)
      ?.map((token) => token.replace(/^(["'])(.*)\1$/, "$2")) ?? []
  );
}

function editorProgram(editor: string) {
  const [firstToken = ""] = splitEditorCommand(editor);
  return basename(win32.basename(firstToken))
    .replace(/\.(?:cmd|exe)$/i, "")
    .toLowerCase();
}

const VI_STYLE_EDITORS = ["vim", "nvim", "vi"];
const CODE_STYLE_EDITORS = ["code", "code-insiders", "cursor"];

/** Suspend for terminal editors. */
export function shouldSuspendForEditor(editor: string) {
  const program = editorProgram(editor);
  if (CODE_STYLE_EDITORS.includes(program)) {
    return false;
  }

  return true;
}

/** Build an editor process invocation without shell quoting so paths stay cross-platform. */
export function buildEditorCommand({
  editor,
  filePath,
  line,
}: {
  editor: string;
  filePath: string;
  line: number;
}): EditorCommand {
  const [command = "", ...editorArgs] = splitEditorCommand(editor);
  const program = editorProgram(editor);

  if (VI_STYLE_EDITORS.includes(program)) {
    return { command, args: [...editorArgs, `+${line}`, filePath] };
  }

  if (CODE_STYLE_EDITORS.includes(program)) {
    return { command, args: [...editorArgs, "--goto", `${filePath}:${line}`] };
  }

  return { command, args: [...editorArgs, filePath] };
}

/** Open the selected file in $EDITOR, suspending TUI for terminal editors. */
export function openSelectedFileInEditor({
  file,
  renderer,
  selectedHunk,
}: {
  file: DiffFile | undefined;
  renderer: Pick<CliRenderer, "suspend" | "resume" | "isDestroyed">;
  selectedHunk: DiffFile["metadata"]["hunks"][number] | undefined;
}) {
  if (!file) {
    return "No file selected.";
  }

  const editor = process.env.EDITOR?.trim();
  if (!editor) {
    return "$EDITOR is not set.";
  }

  const absolutePath = resolve(process.cwd(), file.path);
  if (!existsSync(absolutePath)) {
    return `Cannot edit ${file.path}: file does not exist on disk.`;
  }

  const line = Math.max(1, selectedLine(file, selectedHunk));
  const command = buildEditorCommand({
    editor,
    filePath: absolutePath,
    line,
  });

  const shouldSuspend = shouldSuspendForEditor(editor);
  if (shouldSuspend) {
    renderer.suspend();
  }

  let exitCode = 0;
  let failureMessage: string | null = null;
  try {
    const result = Bun.spawnSync([command.command, ...command.args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = result.exitCode;
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
  }

  if (shouldSuspend && !renderer.isDestroyed) {
    renderer.resume();
  }

  if (failureMessage) {
    return `Failed to launch editor: ${failureMessage}`;
  }

  if (exitCode !== 0) {
    return `Editor exited with status ${exitCode}.`;
  }

  return null;
}
