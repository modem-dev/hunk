import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type {
  AppBootstrap,
  ChangesetStreamHandle,
  ChangesetStreamListener,
  DiffFile,
} from "../core/types";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import { AppHost } from "./AppHost";

/** A controllable in-memory ChangesetStreamHandle for driving AppHost append behavior. */
function createMockStream() {
  const listeners = new Set<ChangesetStreamListener>();
  return {
    handle: {
      subscribe(listener: ChangesetStreamListener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setConsumedPosition() {
        // no-op for tests
      },
      abort() {
        // no-op for tests
      },
    } satisfies ChangesetStreamHandle,
    append(files: DiffFile[]) {
      for (const listener of listeners) listener.onAppend(files);
    },
    complete(total: number) {
      for (const listener of listeners) listener.onComplete(total);
    },
  };
}

function createStreamingBootstrap(stream: ChangesetStreamHandle): AppBootstrap {
  return {
    input: {
      kind: "patch",
      file: "-",
      options: { mode: "stack", pager: true },
    },
    changeset: {
      id: "changeset:streaming-test",
      sourceLabel: "git pager",
      title: "streaming",
      files: [],
      isStreaming: true,
    },
    initialMode: "stack",
    initialTheme: "midnight",
    stream,
  };
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

describe("AppHost streaming changeset", () => {
  test("renders empty pager state and grows files as the stream appends", async () => {
    const stream = createMockStream();
    const bootstrap = createStreamingBootstrap(stream.handle);
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 220,
      height: 24,
    });

    try {
      await flush(setup);

      // First append.
      const fileA = createTestDiffFile({ id: "a", path: "alpha.ts" });
      await act(async () => {
        stream.append([fileA]);
        await Bun.sleep(0);
      });
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("alpha.ts");

      // Second append: another file. Both are visible.
      const fileB = createTestDiffFile({ id: "b", path: "beta.ts" });
      await act(async () => {
        stream.append([fileB]);
        await Bun.sleep(0);
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).toContain("alpha.ts");
      expect(frame).toContain("beta.ts");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("preserves user selection when more files arrive after they navigate", async () => {
    const stream = createMockStream();
    const bootstrap = createStreamingBootstrap(stream.handle);
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 220,
      height: 24,
    });

    try {
      await flush(setup);

      // Seed two files; user navigates to the second.
      const fileA = createTestDiffFile({ id: "a", path: "alpha.ts" });
      const fileB = createTestDiffFile({ id: "b", path: "beta.ts" });
      await act(async () => {
        stream.append([fileA, fileB]);
        await Bun.sleep(0);
      });
      await flush(setup);

      // Move selection down to beta.ts.
      await act(async () => {
        await setup.mockInput.pressArrow("down");
        await Bun.sleep(0);
      });
      await flush(setup);

      const frameAfterSelect = setup.captureCharFrame();
      // Sidebar marks the selected entry — exact glyph depends on theme, but the file name
      // should still be visible. The real assertion is that selection survives the next
      // append, so we capture the frame and re-check after.

      // Append a third file; selection should NOT jump back to the first.
      const fileC = createTestDiffFile({ id: "c", path: "gamma.ts" });
      await act(async () => {
        stream.append([fileC]);
        await Bun.sleep(0);
      });
      await flush(setup);

      const frameAfterAppend = setup.captureCharFrame();
      expect(frameAfterAppend).toContain("gamma.ts");
      // Beta should remain the selected file; we use the same selected-row signature as
      // the pre-append frame to confirm it didn't jump.
      const selectedLineBefore = frameAfterSelect
        .split("\n")
        .find((line) => line.includes("beta.ts"));
      const selectedLineAfter = frameAfterAppend
        .split("\n")
        .find((line) => line.includes("beta.ts"));
      expect(selectedLineAfter).toBe(selectedLineBefore);
    } finally {
      setup.renderer.destroy();
    }
  });
});
