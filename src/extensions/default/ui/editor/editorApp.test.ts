import { describe, expect, test } from "bun:test";
import { buildEditorCommand, editorUsesTerminal } from "./editorApp";

describe("bundled editor app", () => {
  test("builds editor-specific line arguments without a shell", () => {
    expect(
      buildEditorCommand({
        editor: '"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" --wait',
        filePath: "C:\\repo\\file with spaces.ts",
        line: 7,
      }),
    ).toEqual({
      command: "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd",
      args: ["--wait", "--goto", "C:\\repo\\file with spaces.ts:7"],
    });
    expect(
      buildEditorCommand({ editor: "nvim --clean", filePath: "/repo/a.ts", line: 12 }),
    ).toEqual({ command: "nvim", args: ["--clean", "+12", "/repo/a.ts"] });
    expect(
      buildEditorCommand({ editor: "code --reuse-window", filePath: "/repo/a.ts", line: 9 }),
    ).toEqual({
      command: "code",
      args: ["--reuse-window", "--wait", "--goto", "/repo/a.ts:9"],
    });
  });

  test("hands terminal editors to Hunk's app lifecycle but leaves GUI editors visible", () => {
    expect(editorUsesTerminal("nvim --clean")).toBe(true);
    expect(editorUsesTerminal('"C:\\Program Files\\Cursor\\cursor.exe" --wait')).toBe(false);
    expect(editorUsesTerminal("code-insiders --wait")).toBe(false);
  });
});
