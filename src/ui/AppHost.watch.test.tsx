import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { capturedTestColorToHex } from "../../test/helpers/test-color-helpers";
import { createWatchTestRuntime } from "../../test/helpers/watchTest";
import { loadAppBootstrap } from "../core/loaders";
import { AppHost } from "./AppHost";
import { resolveTheme } from "./themes";

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await Promise.resolve();
    await setup.renderOnce();
    await Promise.resolve();
    await setup.renderOnce();
  });
}

/** Yield across render and filesystem turns until an asynchronous view update is visible. */
async function flushUntil(setup: Awaited<ReturnType<typeof testRender>>, predicate: () => boolean) {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt++) {
    await flush(setup);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Advance the injected watch debounce and settle its asynchronous soft reload. */
async function advanceWatch(
  setup: Awaited<ReturnType<typeof testRender>>,
  watch: ReturnType<typeof createWatchTestRuntime>,
  milliseconds: number,
) {
  await act(async () => {
    watch.advanceBy(milliseconds);
    await Promise.resolve();
    await Promise.resolve();
  });
  for (let attempt = 0; attempt < 12; attempt++) {
    await flush(setup);
  }
}

describe("watched input lifecycle", () => {
  test("an observer event reloads after the controlled debounce and preserves the resolved theme", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".hunk-watch-ui-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    writeFileSync(left, "export const answer = 41;\n");
    writeFileSync(right, "export const answer = 42;\n");

    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: { mode: "split", theme: "auto", watch: true },
    });
    bootstrap.initialThemeMode = "light";
    const watch = createWatchTestRuntime();
    const setup = await testRender(<AppHost bootstrap={bootstrap} watchRuntime={watch.runtime} />, {
      width: 220,
      height: 20,
    });

    try {
      await flush(setup);
      expect(watch.sources).toHaveLength(1);
      await act(async () => {
        await setup.mockInput.pressTab();
      });
      await flush(setup);
      await act(async () => {
        await setup.mockInput.typeText("after");
      });
      await flush(setup);
      writeFileSync(right, "export const answer = 42;\nexport const observed = true;\n");
      watch.setSignature("signature:1");
      watch.emit();

      await advanceWatch(setup, watch, 199);
      expect(setup.captureCharFrame()).not.toContain("observed");
      await advanceWatch(setup, watch, 1);
      expect(setup.captureCharFrame()).toContain("observed");
      expect(setup.captureCharFrame()).toContain("filter:");
      expect(setup.captureCharFrame()).toContain("after");
      expect(watch.sources).toHaveLength(2);
      expect(watch.sources[0]?.closeCount).toBe(1);

      const lightTheme = resolveTheme("auto", "light");
      const renderedBackgrounds = setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .map((span) => capturedTestColorToHex(span.bg)?.toLowerCase());
      expect(renderedBackgrounds).toContain(lightTheme.panel.toLowerCase());
    } finally {
      await act(async () => setup.renderer.destroy());
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("a sidecar event refreshes notes through the canonical reload pipeline", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".hunk-watch-sidecar-ui-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    const sidecar = join(dir, "agent.json");
    writeFileSync(left, "export const answer = 41;\n");
    writeFileSync(right, "export const answer = 42;\n");
    writeFileSync(sidecar, JSON.stringify({ version: 1, files: [] }));

    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: {
        agentContext: sidecar,
        agentNotes: true,
        mode: "stack",
        watch: true,
      },
    });
    const watch = createWatchTestRuntime();
    const setup = await testRender(<AppHost bootstrap={bootstrap} watchRuntime={watch.runtime} />, {
      width: 140,
      height: 24,
    });

    try {
      await flush(setup);
      expect(setup.captureCharFrame()).not.toContain("Watch rationale updated");
      writeFileSync(
        sidecar,
        JSON.stringify({
          version: 1,
          files: [
            {
              path: "after.ts",
              annotations: [{ newRange: [1, 1], summary: "Watch rationale updated" }],
            },
          ],
        }),
      );
      watch.setSignature("signature:sidecar");
      watch.emit();
      await advanceWatch(setup, watch, 200);
      await flushUntil(setup, () => setup.captureCharFrame().includes("Watch rationale updated"));
      expect(setup.captureCharFrame()).toContain("Watch rationale updated");
    } finally {
      await act(async () => setup.renderer.destroy());
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("replacement and unmount dispose observers once while late events remain inert", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".hunk-watch-dispose-ui-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    writeFileSync(left, "before\n");
    writeFileSync(right, "first\n");
    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: { mode: "stack", watch: true },
    });
    const watch = createWatchTestRuntime();
    const setup = await testRender(<AppHost bootstrap={bootstrap} watchRuntime={watch.runtime} />, {
      width: 120,
      height: 20,
    });

    try {
      await flush(setup);
      const oldSource = watch.sources[0]!;
      writeFileSync(right, "second\n");
      watch.setSignature("signature:replacement");
      watch.emit(0);
      await advanceWatch(setup, watch, 200);
      expect(watch.sources).toHaveLength(2);
      expect(oldSource.closeCount).toBe(1);

      writeFileSync(right, "late\n");
      watch.setSignature("signature:late");
      oldSource.callbacks.onEvent();
      await advanceWatch(setup, watch, 200);
      expect(setup.captureCharFrame()).not.toContain("late");
      expect(watch.sources).toHaveLength(2);

      await act(async () => setup.renderer.destroy());
      expect(oldSource.closeCount).toBe(1);
      expect(watch.sources[1]?.closeCount).toBe(1);
      oldSource.callbacks.onEvent();
      watch.sources[1]?.callbacks.onEvent();
      watch.advanceBy(10_000);
      expect(watch.sources[1]?.closeCount).toBe(1);
    } finally {
      setup.renderer.destroy();
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
