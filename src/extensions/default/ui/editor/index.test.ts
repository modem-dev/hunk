import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "hunkdiff/extension";
import { getBundledUIRegistry } from "..";
import { BUNDLED_EDITOR_COMMAND_FULL_ID } from ".";

const originalEditor = process.env.EDITOR;
const originalSpawnSync = Bun.spawnSync;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalEditor === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = originalEditor;
  (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Return the editor registration from the process-static bundled UI registry. */
function getBundledEditorCommand() {
  const registered = getBundledUIRegistry().commands.find(
    ({ extensionId, command }) => `${extensionId}.${command.id}` === BUNDLED_EDITOR_COMMAND_FULL_ID,
  );
  if (!registered) throw new Error("Bundled editor command is missing.");
  return registered;
}

/** Build a frozen public selection for one file that exists in a temporary workspace. */
function createEditorContext() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-bundled-editor-"));
  tempDirs.push(cwd);
  writeFileSync(join(cwd, "alpha.ts"), "one\ntwo\nthree\n");
  const execute = mock(() => true);
  const notify = mock(() => {});
  const openInApp = mock(async <Result>(run: () => Result | PromiseLike<Result>) => await run());
  const context = {
    commands: { execute },
    cwd,
    notify,
    openInApp,
    selection: {
      file: {
        id: "alpha",
        path: "alpha.ts",
        changeType: "change",
        hunks: [{ index: 0, header: "@@", oldRange: [1, 3], newRange: [1, 3] }],
      },
      hunkIndex: 0,
      currentLine: { side: "new", line: 2 },
    },
    workspace: {
      resolveLocation: () => ({ path: join(cwd, "alpha.ts"), line: 2 }),
    },
  } as unknown as ExtensionCommandContext;
  return { context, cwd, execute, notify, openInApp };
}

describe("bundled editor extension", () => {
  test("registers the shared Hunk command identity without owning its host key shell", () => {
    const registered = getBundledEditorCommand();

    expect(registered.extensionId).toBe("hunk");
    expect(registered.command).toEqual({
      id: "review.editSelectedFile",
      title: "Open the selected file in your editor",
    });
  });

  test("runs the configured editor inside a generic app handoff and refreshes", async () => {
    const { context, cwd, execute, notify, openInApp } = createEditorContext();
    process.env.EDITOR = "vim --clean";
    const spawnCalls: string[][] = [];
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((command: string[]) => {
      spawnCalls.push(command);
      return { exitCode: 0 };
    }) as unknown as typeof Bun.spawnSync;

    await getBundledEditorCommand().handler(context);

    expect(openInApp).toHaveBeenCalledTimes(1);
    expect(spawnCalls).toEqual([["vim", "--clean", "+2", join(cwd, "alpha.ts")]]);
    expect(execute).toHaveBeenCalledWith("hunk.app.refresh");
    expect(notify).not.toHaveBeenCalled();
  });

  test("reports editor failures after Hunk restores its view", async () => {
    const { context, notify } = createEditorContext();
    process.env.EDITOR = "vim";
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => ({
      exitCode: 2,
    })) as unknown as typeof Bun.spawnSync;

    await getBundledEditorCommand().handler(context);

    expect(notify).toHaveBeenCalledWith("Editor exited with status 2.", "error");
  });

  test("keeps GUI editors visible and waits for them before refreshing", async () => {
    const { context, cwd, execute, openInApp } = createEditorContext();
    process.env.EDITOR = "code --reuse-window";
    const spawnCalls: string[][] = [];
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((command: string[]) => {
      spawnCalls.push(command);
      return { exitCode: 0 };
    }) as unknown as typeof Bun.spawnSync;

    await getBundledEditorCommand().handler(context);

    expect(openInApp).not.toHaveBeenCalled();
    expect(spawnCalls).toEqual([
      ["code", "--reuse-window", "--wait", "--goto", `${join(cwd, "alpha.ts")}:2`],
    ]);
    expect(execute).toHaveBeenCalledWith("hunk.app.refresh");
  });
});
