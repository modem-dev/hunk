import { describe, expect, test } from "bun:test";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import { createReviewSessionRuntime } from "./reviewSessionRuntime";
import { prepareTerminalReviewBroker, type ReviewSessionInput } from "./runReviewSession";

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
});
