import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import {
  buildEditorCommand,
  openSelectedFileInEditor,
  resolveEditableFilePath,
  shouldSuspendForEditor,
} from "./openInEditor";

const originalEditor = process.env.EDITOR;
const originalSpawnSync = Bun.spawnSync;
const tempDirs: string[] = [];

function createTempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunk-open-editor-")));
  tempDirs.push(dir);
  return dir;
}

function restoreEditorEnv() {
  if (originalEditor === undefined) {
    delete process.env.EDITOR;
  } else {
    process.env.EDITOR = originalEditor;
  }
}

function mockSpawnSync(
  implementation: (cmds: string[], options?: Parameters<typeof Bun.spawnSync>[1]) => unknown,
) {
  const mutableBun = Bun as unknown as { spawnSync: typeof Bun.spawnSync };
  mutableBun.spawnSync = implementation as typeof Bun.spawnSync;
}

function createRenderer() {
  return {
    isDestroyed: false,
    resume: mock(() => {}),
    suspend: mock(() => {}),
  };
}

afterEach(() => {
  restoreEditorEnv();
  mockSpawnSync(originalSpawnSync);

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

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

  test("resolves repo-relative diff paths from the diff source path", () => {
    expect(resolveEditableFilePath("src/main.tsx", "/tmp/project")).toBe(
      resolve("/tmp/project", "src/main.tsx"),
    );
  });

  test("returns an error when no file is selected", () => {
    const renderer = createRenderer();
    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });

    expect(
      openSelectedFileInEditor({
        file: undefined,
        renderer,
        selectedHunk: undefined,
      }),
    ).toBe("No file selected.");

    expect(spawnCalls).toEqual([]);
    expect(renderer.suspend).not.toHaveBeenCalled();
    expect(renderer.resume).not.toHaveBeenCalled();
  });

  test("returns an error when $EDITOR is unset", () => {
    const renderer = createRenderer();
    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });
    delete process.env.EDITOR;

    expect(
      openSelectedFileInEditor({
        file: createTestDiffFile({ path: "missing-editor.ts" }),
        renderer,
        selectedHunk: undefined,
      }),
    ).toBe("$EDITOR is not set.");

    expect(spawnCalls).toEqual([]);
    expect(renderer.suspend).not.toHaveBeenCalled();
    expect(renderer.resume).not.toHaveBeenCalled();
  });

  test("returns an error when the file does not exist on disk", () => {
    const renderer = createRenderer();
    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });
    process.env.EDITOR = "nvim";

    expect(
      openSelectedFileInEditor({
        basePath: createTempDir(),
        file: createTestDiffFile({ path: "missing-on-disk.ts" }),
        renderer,
        selectedHunk: undefined,
      }),
    ).toBe("Cannot edit missing-on-disk.ts: file does not exist on disk.");

    expect(spawnCalls).toEqual([]);
    expect(renderer.suspend).not.toHaveBeenCalled();
    expect(renderer.resume).not.toHaveBeenCalled();
  });

  test("spawns terminal editors with suspend and resume around a successful edit", () => {
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "const value = 1;\n");
    process.env.EDITOR = "nvim --clean";

    const spawnCalls: Array<{
      cmds: string[];
      options: Parameters<typeof Bun.spawnSync>[1] | undefined;
    }> = [];
    mockSpawnSync((cmds, options) => {
      spawnCalls.push({ cmds, options });
      return { exitCode: 0 };
    });

    const renderer = createRenderer();
    const file = createTestDiffFile({ path: "example.ts" });

    expect(
      openSelectedFileInEditor({
        basePath,
        file,
        renderer,
        selectedHunk: undefined,
      }),
    ).toBeNull();

    expect(spawnCalls).toEqual([
      {
        cmds: ["nvim", "--clean", "+1", join(basePath, "example.ts")],
        options: { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
      },
    ]);
    expect(renderer.suspend).toHaveBeenCalledTimes(1);
    expect(renderer.resume).toHaveBeenCalledTimes(1);
  });

  test("uses deletion line numbers for deleted files", () => {
    const basePath = createTempDir();
    writeFileSync(join(basePath, "deleted.ts"), "const old = true;\n");
    process.env.EDITOR = "vim";

    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });

    const baseFile = createTestDiffFile({ path: "deleted.ts" });
    const file = {
      ...baseFile,
      metadata: {
        ...baseFile.metadata,
        type: "deleted" as const,
      },
    };
    const selectedHunk = {
      ...file.metadata.hunks[0]!,
      additionStart: 2,
      deletionStart: 9,
    };

    expect(
      openSelectedFileInEditor({
        basePath,
        file,
        renderer: createRenderer(),
        selectedHunk,
      }),
    ).toBeNull();

    expect(spawnCalls).toEqual([["vim", "+9", join(basePath, "deleted.ts")]]);
  });

  test("does not suspend GUI editors and reports non-zero exits", () => {
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "const value = 1;\n");
    process.env.EDITOR = "code --wait";

    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 2 };
    });

    const renderer = createRenderer();
    const file = createTestDiffFile({ path: "example.ts" });

    expect(
      openSelectedFileInEditor({
        basePath,
        file,
        renderer,
        selectedHunk: file.metadata.hunks[0],
      }),
    ).toBe("Editor exited with status 2.");

    expect(spawnCalls).toEqual([["code", "--wait", "--goto", `${join(basePath, "example.ts")}:1`]]);
    expect(renderer.suspend).not.toHaveBeenCalled();
    expect(renderer.resume).not.toHaveBeenCalled();
  });

  test("resumes after spawn failures and reports launch errors", () => {
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "const value = 1;\n");
    process.env.EDITOR = "vi";

    mockSpawnSync(() => {
      throw new Error("boom");
    });

    const renderer = createRenderer();
    const file = createTestDiffFile({ path: "example.ts" });

    expect(
      openSelectedFileInEditor({
        basePath,
        file,
        renderer,
        selectedHunk: file.metadata.hunks[0],
      }),
    ).toBe("Failed to launch editor: boom");

    expect(renderer.suspend).toHaveBeenCalledTimes(1);
    expect(renderer.resume).toHaveBeenCalledTimes(1);
  });
});
