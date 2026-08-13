import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement, useState } from "react";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import type { ExtensionLineHighlight } from "../../extension-api/types";
import type { RegisteredLineHighlighter } from "../../extensions/types";
import { bumpScopedEpoch } from "../lib/scopedEpochs";
import { registeredLineHighlighterKey, type LineHighlightEpochState } from "./state";
import { runLineHighlightRequest, useLineHighlights } from "./useLineHighlights";
import type { ValidatedLineHighlight } from "./validate";

/** Build one registration with a test-controlled highlight callback. */
function createTestHighlighter(
  highlight: RegisteredLineHighlighter["highlighter"]["highlight"],
  id = "test-highlighter",
): RegisteredLineHighlighter {
  return {
    extensionId: "test-extension",
    highlighter: { id, highlight },
  };
}

const file = createTestDiffFile({
  id: "request",
  path: "request.ts",
  before: "old\n",
  after: "new\n",
});
const files = [file];
const ignoreIssue = () => {};

describe("line-highlight request lifetime", () => {
  test("aborts its child signal after successful completion", async () => {
    let signal: AbortSignal | undefined;
    const highlighter = createTestHighlighter((input) => {
      signal = input.signal;
      return null;
    });

    expect(
      await runLineHighlightRequest(highlighter, file, new AbortController().signal, 50),
    ).toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  test("times out a hung highlighter instead of holding the preparation slot", async () => {
    const highlighter = createTestHighlighter(() => new Promise(() => {}));

    let settlements = 0;
    await runLineHighlightRequest(highlighter, file, new AbortController().signal, 5).then(
      () => settlements++,
      () => settlements++,
    );
    expect(settlements).toBe(1);
  });
});

describe("useLineHighlights", () => {
  test("prepares validated marks per file and reuses identity across unrelated renders", async () => {
    let calls = 0;
    const highlighter = createTestHighlighter(() => {
      calls += 1;
      return [{ side: "new", line: 1, range: [0, 3] } satisfies ExtensionLineHighlight];
    });
    let latest: ReadonlyMap<string, readonly ValidatedLineHighlight[]> = new Map();
    let rerender = () => {};
    const highlighters = [highlighter];

    function Harness() {
      const [, setTick] = useState(0);
      rerender = () => setTick((tick) => tick + 1);
      latest = useLineHighlights({
        files,
        highlighters,
        onIssue: ignoreIssue,
      });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    try {
      await act(async () => {
        await Promise.resolve();
        await setup.renderOnce();
        await Promise.resolve();
        await setup.renderOnce();
      });

      expect(calls).toBe(1);
      const first = latest.get(file.id);
      expect(first).toEqual([{ side: "new", line: 1, start: 0, end: 3, tone: "match" }]);

      await act(async () => {
        rerender();
        await setup.renderOnce();
        await Promise.resolve();
        await setup.renderOnce();
      });

      // Unrelated renders neither re-run the highlighter nor change identity.
      expect(calls).toBe(1);
      expect(latest.get(file.id)).toBe(first!);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("re-derives exactly the invalidated file when an epoch bumps", async () => {
    const calls: string[] = [];
    const secondFile = createTestDiffFile({
      id: "second",
      path: "second.ts",
      before: "before\n",
      after: "after\n",
    });
    const highlighter = createTestHighlighter((input) => {
      calls.push(input.file.id);
      return [{ side: "new", line: 1, range: [0, 2] }];
    });
    const key = registeredLineHighlighterKey(highlighter);
    let latest: ReadonlyMap<string, readonly ValidatedLineHighlight[]> = new Map();
    let bump = () => {};
    const bothFiles = [file, secondFile];
    const highlighters = [highlighter];

    function Harness() {
      const [epochs, setEpochs] = useState<LineHighlightEpochState>(() => new Map());
      bump = () => setEpochs((current) => bumpScopedEpoch(current, key, secondFile.id));
      latest = useLineHighlights({
        files: bothFiles,
        highlighters,
        epochs,
        onIssue: ignoreIssue,
      });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    try {
      await act(async () => {
        await Promise.resolve();
        await setup.renderOnce();
        await Promise.resolve();
        await setup.renderOnce();
      });
      expect(calls.sort()).toEqual([file.id, secondFile.id].sort());
      const firstMarks = latest.get(file.id);
      expect(firstMarks).toBeDefined();

      calls.length = 0;
      await act(async () => {
        bump();
        await setup.renderOnce();
        await Promise.resolve();
        await setup.renderOnce();
      });

      expect(calls).toEqual([secondFile.id]);
      // The untouched file keeps its exact identity, so its rows never repaint.
      expect(latest.get(file.id)).toBe(firstMarks!);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("contains one failing highlighter to its own marks and reports it once", async () => {
    const issues: string[] = [];
    const failing = createTestHighlighter(() => {
      throw new Error("boom");
    }, "failing");
    const working = createTestHighlighter(
      () => [{ side: "new", line: 1, range: [0, 2], tone: "info" }],
      "working",
    );
    let latest: ReadonlyMap<string, readonly ValidatedLineHighlight[]> = new Map();
    const highlighters = [failing, working];

    function Harness() {
      latest = useLineHighlights({
        files,
        highlighters,
        onIssue: (message) => issues.push(message),
      });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    try {
      await act(async () => {
        await Promise.resolve();
        await setup.renderOnce();
        await Promise.resolve();
        await setup.renderOnce();
      });

      expect(latest.get(file.id)).toEqual([
        { side: "new", line: 1, start: 0, end: 2, tone: "info" },
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('line highlighter "failing" failed');
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("rejects an over-cap result whole with one warning", async () => {
    const issues: string[] = [];
    const highlighter = createTestHighlighter(() =>
      Array.from({ length: 2_001 }, (_, index) => ({
        side: "new" as const,
        line: index + 1,
        range: [0, 1] as const,
      })),
    );
    let latest: ReadonlyMap<string, readonly ValidatedLineHighlight[]> = new Map();
    const highlighters = [highlighter];

    function Harness() {
      latest = useLineHighlights({
        files,
        highlighters,
        onIssue: (message) => issues.push(message),
      });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    try {
      await act(async () => {
        await Promise.resolve();
        await setup.renderOnce();
        await Promise.resolve();
        await setup.renderOnce();
      });

      expect(latest.get(file.id)).toBeUndefined();
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain("marks dropped");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("skips files with nothing to mark without reaching extension code", async () => {
    const calls: string[] = [];
    const binaryFile = { ...createTestDiffFile({ id: "binary" }), isBinary: true };
    const highlighter = createTestHighlighter((input) => {
      calls.push(input.file.id);
      return null;
    });

    const mixedFiles = [binaryFile, file];
    const highlighters = [highlighter];

    function Harness() {
      useLineHighlights({
        files: mixedFiles,
        highlighters,
        onIssue: ignoreIssue,
      });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    try {
      await act(async () => {
        await Promise.resolve();
        await setup.renderOnce();
        await Promise.resolve();
        await setup.renderOnce();
      });
      expect(calls).toEqual([file.id]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
