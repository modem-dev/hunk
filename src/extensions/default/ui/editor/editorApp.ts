import { existsSync } from "node:fs";
import { basename, win32 } from "node:path";

export interface EditorCommand {
  command: string;
  args: string[];
}

/** Split the user's editor command without involving a shell. */
function splitEditorCommand(editor: string) {
  return (
    editor
      .match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g)
      ?.map((token) => token.replace(/^(["'])(.*)\1$/, "$2")) ?? []
  );
}

/** Return the executable basename used to select an editor's line-address syntax. */
function editorProgram(editor: string) {
  const [firstToken = ""] = splitEditorCommand(editor);
  return basename(win32.basename(firstToken))
    .replace(/\.(?:cmd|exe)$/i, "")
    .toLowerCase();
}

const VI_STYLE_EDITORS = ["vim", "nvim", "vi"];
const CODE_STYLE_EDITORS = ["code", "code-insiders", "cursor"];

/** Report whether this editor expects to own the current terminal. */
export function editorUsesTerminal(editor: string) {
  return !CODE_STYLE_EDITORS.includes(editorProgram(editor));
}

/** Build an editor process invocation without shell quoting. */
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
    const waitArgs = editorArgs.includes("--wait") || editorArgs.includes("-w") ? [] : ["--wait"];
    return {
      command,
      args: [...editorArgs, ...waitArgs, "--goto", `${filePath}:${line}`],
    };
  }
  if (program === "hx") {
    return { command, args: [...editorArgs, `${filePath}:${line}`] };
  }
  return { command, args: [...editorArgs, filePath] };
}

/** Validate one resolved location and turn it into an editor invocation. */
export function editorCommandForLocation({
  editor,
  line,
  path,
  reviewPath,
}: {
  editor: string;
  line: number;
  path: string;
  reviewPath: string;
}): { ok: true; command: EditorCommand } | { ok: false; detail: string } {
  if (!existsSync(path)) {
    return { ok: false, detail: `Cannot edit ${reviewPath}: file does not exist on disk.` };
  }

  return {
    ok: true,
    command: buildEditorCommand({
      editor,
      filePath: path,
      line,
    }),
  };
}
