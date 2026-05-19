import { describe, expect, test } from "bun:test";
import { buildEditorCommand, shouldSuspendForEditor } from "./openInEditor";

describe("open in editor helpers", () => {
  test("builds vi-style editor args without shell quoting", () => {
    expect(
      buildEditorCommand({
        editor: "nvim",
        filePath: "/tmp/project/file with spaces's.ts",
        line: 12,
      }),
    ).toEqual({
      command: "nvim",
      args: ["+12", "/tmp/project/file with spaces's.ts"],
    });
  });

  test("preserves editor flags before appending the target file", () => {
    expect(
      buildEditorCommand({
        editor: "code --reuse-window",
        filePath: "/tmp/project/example.ts",
        line: 4,
      }),
    ).toEqual({
      command: "code",
      args: ["--reuse-window", "--goto", "/tmp/project/example.ts:4"],
    });
  });

  test("handles quoted editor commands and Windows executable paths", () => {
    expect(
      buildEditorCommand({
        editor: '"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" --wait',
        filePath: "C:\\Users\\Duarte\\repo\\file with spaces.ts",
        line: 7,
      }),
    ).toEqual({
      command: "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd",
      args: ["--wait", "--goto", "C:\\Users\\Duarte\\repo\\file with spaces.ts:7"],
    });
  });

  test("defaults unknown editors to opening the file path only", () => {
    expect(
      buildEditorCommand({
        editor: "zed --new-window",
        filePath: "/tmp/project/example.ts",
        line: 4,
      }),
    ).toEqual({
      command: "zed",
      args: ["--new-window", "/tmp/project/example.ts"],
    });
  });

  test("does not suspend for code-style GUI editors", () => {
    expect(shouldSuspendForEditor("code --reuse-window")).toBe(false);
    expect(shouldSuspendForEditor('"C:\\Program Files\\Cursor\\cursor.exe"')).toBe(false);
    expect(shouldSuspendForEditor("nvim")).toBe(true);
  });
});
