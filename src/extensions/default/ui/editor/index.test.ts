import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "hunkdiff/extension";
import { getBundledUIRegistry } from "..";
import { BUNDLED_EDITOR_COMMAND_FULL_ID } from ".";

const originalEditor = process.env.EDITOR;
const originalSpawn = Bun.spawn;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalEditor === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = originalEditor;
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Replace Bun's asynchronous process launcher through one narrowly typed test seam. */
function mockSpawn(implementation: (command: string[]) => { exited: Promise<number> }) {
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn =
    implementation as unknown as typeof Bun.spawn;
}

/** Create a promise whose completion one editor test controls. */
function createDeferredExit() {
  let resolve!: (exitCode: number) => void;
  const exited = new Promise<number>((settle) => {
    resolve = settle;
  });
  return { exited, resolve };
}

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

  test("awaits a terminal editor asynchronously inside a generic app handoff", async () => {
    const { context, cwd, execute, notify, openInApp } = createEditorContext();
    process.env.EDITOR = "vim --clean";
    const spawnCalls: string[][] = [];
    const exit = createDeferredExit();
    mockSpawn((command) => {
      spawnCalls.push(command);
      return { exited: exit.exited };
    });

    const pending = getBundledEditorCommand().handler(context);

    expect(openInApp).toHaveBeenCalledTimes(1);
    expect(spawnCalls).toEqual([["vim", "--clean", "+2", join(cwd, "alpha.ts")]]);
    expect(execute).not.toHaveBeenCalled();

    exit.resolve(0);
    await pending;

    expect(execute).toHaveBeenCalledWith("hunk.app.refresh");
    expect(notify).not.toHaveBeenCalled();
  });

  test("reports editor failures after Hunk restores its view", async () => {
    const { context, notify } = createEditorContext();
    process.env.EDITOR = "vim";
    mockSpawn(() => ({ exited: Promise.resolve(2) }));

    await getBundledEditorCommand().handler(context);

    expect(notify).toHaveBeenCalledWith("Editor exited with status 2.", "error");
  });

  test("keeps GUI editors responsive, waits before refreshing, and refuses overlap", async () => {
    const { context, cwd, execute, notify, openInApp } = createEditorContext();
    process.env.EDITOR = "code --reuse-window";
    const spawnCalls: string[][] = [];
    const exit = createDeferredExit();
    mockSpawn((command) => {
      spawnCalls.push(command);
      return { exited: exit.exited };
    });

    const pending = getBundledEditorCommand().handler(context);

    expect(openInApp).not.toHaveBeenCalled();
    expect(spawnCalls).toEqual([
      ["code", "--reuse-window", "--wait", "--goto", `${join(cwd, "alpha.ts")}:2`],
    ]);
    expect(execute).not.toHaveBeenCalled();

    // The first asynchronous child remains pending without blocking a second command dispatch.
    await getBundledEditorCommand().handler(context);
    expect(spawnCalls).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith("An editor is already open.", "warning");

    exit.resolve(0);
    await pending;

    expect(execute).toHaveBeenCalledWith("hunk.app.refresh");
  });

  test("releases bundled editor ownership when asynchronous process launch fails", async () => {
    const { context, notify } = createEditorContext();
    process.env.EDITOR = "code";
    let launches = 0;
    mockSpawn(() => {
      launches += 1;
      throw new Error("missing executable");
    });

    await getBundledEditorCommand().handler(context);
    await getBundledEditorCommand().handler(context);

    expect(launches).toBe(2);
    expect(notify).toHaveBeenCalledWith("Failed to launch editor: missing executable", "error");
  });
});
