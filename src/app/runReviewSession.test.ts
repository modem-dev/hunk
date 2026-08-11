import { describe, expect, mock, test } from "bun:test";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import { createReviewSessionRuntime } from "./reviewSessionRuntime";
import {
  closeReviewSessionOwners,
  prepareTerminalReviewBroker,
  type ReviewSessionInput,
} from "./runReviewSession";

/** Build a locally renderable review whose broker manifest exceeds its metadata budget. */
function createOversizedInput(): ReviewSessionInput {
  const file = createTestDiffFile({
    id: "oversized",
    path: "oversized.ts",
    agent: {
      path: "oversized.ts",
      summary: "x".repeat(4 * 1024 * 1024),
      annotations: [],
    },
  });
  const bootstrap = createTestVcsAppBootstrap({ files: [file] });
  return { bootstrap, rawInput: bootstrap.input, controllingTerminal: null };
}

/** Build a review whose static notes overflow both registration and mutable snapshot metadata. */
function createOversizedNoteInput(): ReviewSessionInput {
  const file = createTestDiffFile({
    id: "oversized-notes",
    path: "oversized-notes.ts",
    agent: {
      path: "oversized-notes.ts",
      annotations: Array.from({ length: 40 }, (_, index) => ({
        newRange: [1, 1] as [number, number],
        summary: `${index}:${"x".repeat(180 * 1024)}`,
      })),
    },
  });
  const bootstrap = createTestVcsAppBootstrap({ files: [file] });
  return { bootstrap, rawInput: bootstrap.input, controllingTerminal: null };
}

describe("review session outer cleanup", () => {
  test("attempts every owner while preserving an arbitrary first thrown value", async () => {
    const events: string[] = [];
    const stop = mock(() => {
      events.push("host");
      throw undefined;
    });
    const close = mock(() => {
      events.push("terminal");
      throw new Error("terminal failed");
    });
    const shutdown = mock(async () => {
      events.push("runtime");
      throw new Error("runtime failed");
    });
    let rejected = false;
    let rejection: unknown = "not-called";

    try {
      await closeReviewSessionOwners({
        hostClient: { stop },
        controllingTerminal: { close },
        runtime: { shutdown },
      });
    } catch (error) {
      rejected = true;
      rejection = error;
    }

    expect(rejected).toBe(true);
    expect(rejection).toBeUndefined();
    expect(events).toEqual(["host", "terminal", "runtime"]);
  });
});

describe("terminal review broker preparation", () => {
  test("skips producer construction entirely when session brokering is disabled", () => {
    const input = createOversizedInput();
    const runtime = createReviewSessionRuntime(input.bootstrap, { rawInput: input.rawInput });
    expect(prepareTerminalReviewBroker(input, runtime, true)).toEqual({});
    runtime.dispose();
  });

  test("degrades producer capacity failures without blocking the local terminal review", () => {
    const input = createOversizedInput();
    const runtime = createReviewSessionRuntime(input.bootstrap, { rawInput: input.rawInput });
    expect(prepareTerminalReviewBroker(input, runtime, false)).toEqual({
      sessionNotice: "Session brokering is unavailable for this large review; reviewing locally.",
    });
    runtime.dispose();
  });

  test("keeps note-heavy local fallback mutations outside producer bounds", () => {
    const input = createOversizedNoteInput();
    const runtime = createReviewSessionRuntime(input.bootstrap, { rawInput: input.rawInput });
    expect(prepareTerminalReviewBroker(input, runtime, false)).toEqual({
      sessionNotice: "Session brokering is unavailable for this large review; reviewing locally.",
    });

    const store = runtime.getSnapshot().store;
    const before = store.getSnapshot();
    expect(() => store.dispatch({ type: "notes/set-visibility", visible: true })).not.toThrow();
    expect(store.getSnapshot()).toMatchObject({ showAgentNotes: true, stateRevision: 1 });
    expect(store.getSnapshot()).not.toBe(before);
    runtime.dispose();
  });

  test("keeps disabled note-heavy sessions fully local", () => {
    const input = createOversizedNoteInput();
    const runtime = createReviewSessionRuntime(input.bootstrap, { rawInput: input.rawInput });
    expect(prepareTerminalReviewBroker(input, runtime, true)).toEqual({});

    const store = runtime.getSnapshot().store;
    expect(() => store.dispatch({ type: "filter/set", filter: "oversized" })).not.toThrow();
    expect(store.getSnapshot()).toMatchObject({ filter: "oversized", stateRevision: 1 });
    runtime.dispose();
  });
});
