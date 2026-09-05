import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import type { AppBootstrap } from "../core/bootstrap";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { createTestDiffFile, lines } from "../../../../test/helpers/diff-helpers";

const { AppHost } = await import("./AppHost");

const WIDE = { width: 200, height: 24 };

const BEFORE = lines(
  "const alpha = 1;",
  "const beta = 2;",
  "const gamma = 3;",
  "const delta = 4;",
  "const epsilon = 5;",
);
const AFTER = lines(
  "const alpha = 1;",
  "const beta = 22222;",
  "const gamma = 3;",
  "const delta = 4;",
  "const epsilon = 5;",
);

const originalEditor = process.env.EDITOR;
const originalSpawnSync = Bun.spawnSync;
const tempDirs: string[] = [];

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

function createTempWorkspace() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunk-apphost-editor-")));
  tempDirs.push(dir);
  writeFileSync(join(dir, "sample.ts"), AFTER);
  return dir;
}

function mockSpawnSync(implementation: typeof Bun.spawnSync) {
  const mutableBun = Bun as unknown as { spawnSync: typeof Bun.spawnSync };
  mutableBun.spawnSync = implementation;
}

/** Bootstrap one working-tree review whose file really exists under `sourceLabel`. */
function createEditorBootstrap(sourceLabel: string): AppBootstrap {
  return createTestVcsAppBootstrap({
    changesetId: "changeset:edit-in-editor",
    initialMode: "stack",
    sourceLabel,
    files: [
      createTestDiffFile({
        after: AFTER,
        agent: false,
        before: BEFORE,
        context: 3,
        id: "sample",
        path: "sample.ts",
      }),
    ],
  });
}

async function flush(target: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await target.renderOnce();
    await Bun.sleep(0);
    await target.renderOnce();
  });
}

async function pressKeys(target: Awaited<ReturnType<typeof testRender>>, keys: string) {
  for (const key of keys) {
    await act(async () => {
      await target.mockInput.typeText(key);
    });
    await flush(target);
  }
}

beforeEach(() => {
  delete process.env.EDITOR;
});

afterEach(async () => {
  if (setup) {
    const current = setup;
    setup = undefined;
    await act(async () => {
      current.renderer.destroy();
    });
  }

  if (originalEditor === undefined) {
    delete process.env.EDITOR;
  } else {
    process.env.EDITOR = originalEditor;
  }
  mockSpawnSync(originalSpawnSync);

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("AppHost edit-selected-file shortcut", () => {
  test("pressing e with no $EDITOR surfaces a notice instead of crashing", async () => {
    setup = await testRender(
      <AppHost bootstrap={createEditorBootstrap(createTempWorkspace())} />,
      WIDE,
    );
    await flush(setup);

    await pressKeys(setup, "e");

    // openSelectedFileInEditor returns "$EDITOR is not set." which shows as a session notice.
    expect(setup.captureCharFrame()).toContain("EDITOR is not set");
  });

  test("pressing e opens the editor at the current line, not the hunk start", async () => {
    const workspace = createTempWorkspace();
    process.env.EDITOR = "vim";

    const spawnCalls: string[][] = [];
    mockSpawnSync(((cmds: string[]) => {
      spawnCalls.push(cmds);
      return { exitCode: 1 };
    }) as unknown as typeof Bun.spawnSync);

    setup = await testRender(<AppHost bootstrap={createEditorBootstrap(workspace)} />, WIDE);
    await flush(setup);

    // The hunk starts at line 1; step down onto the changed line, then one line past it.
    await pressKeys(setup, "jje");
    await pressKeys(setup, "je");

    expect(spawnCalls).toEqual([
      ["vim", "+2", join(workspace, "sample.ts")],
      ["vim", "+3", join(workspace, "sample.ts")],
    ]);
  });
});
