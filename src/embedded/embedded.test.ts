import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BoxRenderable, InputRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedHunkSession, mountEmbeddedHunkApp } from "./index";
import { createEmbeddedRendererScope, createScopedKeyInput } from "./mount";
import { embeddedHunkSessionInternals } from "./session";
import type { EmbeddedHunkSession, EmbeddedHunkSnapshot } from "./types";

const testPatchText = [
  "diff --git a/example.ts b/example.ts",
  "--- a/example.ts",
  "+++ b/example.ts",
  "@@ -1 +1 @@",
  "-const value = 1;",
  "+const value = 2;",
  "",
].join("\n");

let previousHunkMcpDisable: string | undefined;

/** Return the loaded patch text for one embedded session. */
function getTestLoadedPatch(session: EmbeddedHunkSession) {
  return embeddedHunkSessionInternals(session)
    .getRenderSnapshot()
    .bootstrap.changeset.files.map((file) => file.patch)
    .join("\n");
}

/** Count non-overlapping occurrences of a text fragment in a rendered frame. */
function countTestFrameOccurrences(frame: string, text: string) {
  return frame.split(text).length - 1;
}

/** Flush enough render cycles for embedded React updates to reach the test frame. */
async function flushTestRenderer(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await Bun.sleep(0);
  await setup.renderOnce();
}

/** Render until an expected frame fragment appears, or return the last captured frame. */
async function captureSettledTestFrame(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  expectedText: string,
) {
  let frame = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await flushTestRenderer(setup);
    frame = setup.captureCharFrame();
    if (frame.includes(expectedText)) break;
  }
  return frame;
}

/** Expect a snapshot to be ready and narrow it for the rest of the test. */
function expectTestReadySnapshot(snapshot: EmbeddedHunkSnapshot) {
  expect(snapshot.status).toBe("ready");
  return snapshot as Extract<EmbeddedHunkSnapshot, { status: "ready" }>;
}

/** Expect a snapshot to be errored and narrow it for the rest of the test. */
function expectTestErrorSnapshot(snapshot: EmbeddedHunkSnapshot) {
  expect(snapshot.status).toBe("error");
  return snapshot as Extract<EmbeddedHunkSnapshot, { status: "error" }>;
}

describe("embedded Hunk sessions", () => {
  beforeEach(() => {
    previousHunkMcpDisable = process.env.HUNK_MCP_DISABLE;
    process.env.HUNK_MCP_DISABLE = "1";
  });

  afterEach(() => {
    if (previousHunkMcpDisable === undefined) {
      delete process.env.HUNK_MCP_DISABLE;
    } else {
      process.env.HUNK_MCP_DISABLE = previousHunkMcpDisable;
    }
  });

  test("loads embedded sessions through Hunk config resolution", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-embedded-config-"));
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;

    try {
      const configHome = join(root, "config");
      mkdirSync(join(configHome, "hunk"), { recursive: true });
      writeFileSync(
        join(configHome, "hunk", "config.toml"),
        ['theme = "midnight"', 'mode = "stack"', "line_numbers = false"].join("\n"),
      );
      process.env.XDG_CONFIG_HOME = configHome;

      const session = await createEmbeddedHunkSession({
        cwd: root,
        source: { kind: "patch", text: testPatchText, options: { theme: "paper" } },
      });
      const snapshot = expectTestReadySnapshot(session.getSnapshot());

      expect("bootstrap" in snapshot).toBe(false);
      expect(snapshot.title).toBe("Patch review: stdin patch");
      expect(snapshot.fileCount).toBe(1);

      const bootstrap = embeddedHunkSessionInternals(session).getRenderSnapshot().bootstrap;
      expect(bootstrap.initialMode).toBe("stack");
      expect(bootstrap.initialShowLineNumbers).toBe(false);
      expect(bootstrap.initialTheme).toBe("paper");

      session.dispose();
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("open reuses the loaded review when source identity is equivalent", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-embedded-open-same-source-"));
    const left = join(root, "before.ts");
    const right = join(root, "after.ts");

    try {
      writeFileSync(left, "export const value = 1;\n");
      writeFileSync(right, "export const value = 2;\nexport const first = true;\n");

      const source = {
        kind: "diff",
        left,
        right,
        options: { wrapLines: undefined },
      } as const;
      const session = await createEmbeddedHunkSession({ cwd: root, source });
      expect(getTestLoadedPatch(session)).toContain("first");

      writeFileSync(right, "export const value = 2;\nexport const second = true;\n");
      const reusedSnapshot = expectTestReadySnapshot(
        await session.open({ kind: "diff", left, right }),
      );

      expect(reusedSnapshot.source).toEqual(session.source);
      expect(getTestLoadedPatch(session)).toContain("first");
      expect(getTestLoadedPatch(session)).not.toContain("second");

      const reloadedSnapshot = expectTestReadySnapshot(await session.reload());

      expect(reloadedSnapshot.source).toEqual(session.source);
      expect(getTestLoadedPatch(session)).toContain("second");
      expect(getTestLoadedPatch(session)).not.toContain("first");

      session.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("keeps the previous source and reports errors when open fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-embedded-reload-error-"));

    try {
      const initialSource = { kind: "patch", text: testPatchText, label: "initial patch" } as const;
      const session = await createEmbeddedHunkSession({
        cwd: root,
        source: initialSource,
      });

      await expect(session.open({ kind: "patch", file: "missing.patch" })).rejects.toThrow();

      expect(session.source).toMatchObject(initialSource);
      const snapshot = expectTestErrorSnapshot(session.getSnapshot());
      expect(snapshot.error).toContain("missing.patch");
      expect(snapshot.title).toBe("Patch review: initial patch");
      expect("bootstrap" in snapshot).toBe(false);

      session.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("preserves headless agent notes for the next embedded mount", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-embedded-headless-notes-"));
    const noteSummary = "Persisted agent note from hidden Hunk";

    try {
      const session = await createEmbeddedHunkSession({
        cwd: root,
        source: { kind: "patch", text: testPatchText },
      });
      const internals = embeddedHunkSessionInternals(session);

      await internals.dispatchCommand({
        type: "command",
        requestId: "comment-batch-1",
        command: "comment_batch",
        input: {
          comments: [
            {
              filePath: "example.ts",
              hunkIndex: 0,
              summary: noteSummary,
            },
          ],
          revealMode: "first",
        },
      });

      expect(internals.getSessionSnapshot().state.showAgentNotes).toBe(true);
      expect(internals.getSessionSnapshot().state.liveCommentCount).toBe(1);

      const setup = await createTestRenderer({ width: 120, height: 24 });
      const container = new BoxRenderable(setup.renderer, {
        height: 18,
        id: "embedded-hunk",
        width: 100,
      });
      setup.renderer.root.add(container);

      const mount = mountEmbeddedHunkApp({
        active: true,
        container,
        onQuit: () => undefined,
        renderer: setup.renderer,
        session,
      });

      try {
        let frame = "";
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await setup.renderOnce();
          frame = setup.captureCharFrame();
          if (frame.includes(noteSummary)) break;
          await Bun.sleep(0);
        }
        expect(frame).toContain(noteSummary);
      } finally {
        mount.unmount();
        setup.renderer.destroy();
        session.dispose();
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("updates an embedded mount without stacking app roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-embedded-mount-update-"));
    const labels = ["alpha embedded source", "beta embedded source", "gamma embedded source"];

    try {
      const session = await createEmbeddedHunkSession({
        cwd: root,
        source: { kind: "patch", text: testPatchText, label: labels[0] },
      });
      const setup = await createTestRenderer({ width: 140, height: 24 });
      const container = new BoxRenderable(setup.renderer, {
        height: 20,
        id: "embedded-hunk",
        width: 120,
      });
      setup.renderer.root.add(container);

      const mount = mountEmbeddedHunkApp({
        active: true,
        container,
        onQuit: () => undefined,
        renderer: setup.renderer,
        session,
      });

      try {
        let frame = await captureSettledTestFrame(setup, labels[0]!);
        expect(countTestFrameOccurrences(frame, labels[0]!)).toBe(1);

        for (const label of [labels[1]!, labels[2]!, labels[0]!, labels[1]!]) {
          mount.update({ active: false, onQuit: () => undefined });
          await session.open({ kind: "patch", text: testPatchText, label });
          mount.update({ active: true, onQuit: () => undefined });

          frame = await captureSettledTestFrame(setup, label);
          expect(countTestFrameOccurrences(frame, label)).toBe(1);
          for (const otherLabel of labels.filter((candidate) => candidate !== label)) {
            expect(countTestFrameOccurrences(frame, otherLabel)).toBe(0);
          }
        }
      } finally {
        mount.unmount();
        setup.renderer.destroy();
        session.dispose();
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("scopes embedded key input to the active mount", () => {
    const sourceListeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const source = {
      on(event: string, listener: (...args: unknown[]) => void) {
        const listeners = sourceListeners.get(event) ?? new Set();
        listeners.add(listener);
        sourceListeners.set(event, listeners);
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        sourceListeners.get(event)?.delete(listener);
      },
    };
    let active = false;
    const scoped = createScopedKeyInput(source, () => active);
    const received: unknown[] = [];

    scoped.keyInput.on("keypress", (event: unknown) => {
      received.push(event);
    });

    sourceListeners.get("keypress")?.forEach((listener) => listener("hidden"));
    active = true;
    sourceListeners.get("keypress")?.forEach((listener) => listener("visible"));

    expect(received).toEqual(["visible"]);

    scoped.dispose();
    expect(sourceListeners.get("keypress")?.size).toBe(0);
  });

  test("sizes embedded renderer reads and resize events from the host container", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 });

    try {
      const container = new BoxRenderable(setup.renderer, {
        height: 12,
        id: "embedded-container",
        width: 60,
      });
      setup.renderer.root.add(container);
      await setup.renderOnce();

      const scope = createEmbeddedRendererScope(setup.renderer, container, setup.renderer.keyInput);
      const resizes: Array<{ height: number; width: number }> = [];
      const onResize = (width: unknown, height: unknown) => {
        resizes.push({ height: Number(height), width: Number(width) });
      };

      try {
        scope.renderer.on("resize", onResize);

        expect(scope.renderer.width).toBe(60);
        expect(scope.renderer.height).toBe(12);
        expect(scope.renderer.terminalWidth).toBe(60);
        expect(scope.renderer.terminalHeight).toBe(12);

        container.width = 48;
        container.height = 9;
        await setup.renderOnce();

        expect(scope.renderer.width).toBe(48);
        expect(scope.renderer.height).toBe(9);
        expect(resizes).toEqual([{ height: 9, width: 48 }]);

        scope.renderer.off("resize", onResize);
        container.width = 36;
        await setup.renderOnce();

        expect(resizes).toEqual([{ height: 9, width: 48 }]);
      } finally {
        scope.dispose();
      }
    } finally {
      setup.renderer.destroy();
    }
  });

  test("hides host cursor only while the embedded scope is active", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });

    try {
      const hostInput = new InputRenderable(setup.renderer, {
        id: "host-input",
        left: 4,
        position: "absolute",
        top: 2,
        value: "host",
        width: 20,
      });
      const container = new BoxRenderable(setup.renderer, {
        height: 10,
        id: "embedded-container",
        width: 40,
      });
      setup.renderer.root.add(hostInput);
      setup.renderer.root.add(container);
      hostInput.focus();
      await setup.renderOnce();
      expect(setup.renderer.getCursorState().visible).toBe(true);

      let active = false;
      const scope = createEmbeddedRendererScope(
        setup.renderer,
        container,
        setup.renderer.keyInput,
        () => active,
      );

      try {
        await setup.renderOnce();
        expect(setup.renderer.getCursorState().visible).toBe(true);

        active = true;
        await setup.renderOnce();
        expect(setup.renderer.getCursorState().visible).toBe(false);

        scope.renderer.setCursorPosition(11, 12, true);
        setup.renderer.setCursorPosition(2, 3, true);
        await setup.renderOnce();
        expect(setup.renderer.getCursorState()).toMatchObject({ x: 11, y: 12, visible: true });
      } finally {
        scope.dispose();
      }
    } finally {
      setup.renderer.destroy();
    }
  });
});
