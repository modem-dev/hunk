import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement, useState } from "react";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import type { ExtensionLineHighlight } from "../../extension-api/types";
import type { RegisteredLineHighlighter } from "../../extensions/types";
import { bumpScopedEpoch } from "../lib/scopedEpochs";
import { registeredLineHighlighterKey, type LineHighlightEpochState } from "./state";
import { runLineHighlightRequest, useLineHighlights } from "./useLineHighlights";
import {
  MAX_LINE_HIGHLIGHTS_PER_FILE,
  MAX_MERGED_LINE_HIGHLIGHTS_PER_FILE,
  type ValidatedLineHighlight,
} from "./validate";

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

  test("publishes each file as it lands instead of behind one slow highlighter", async () => {
    const quickFile = createTestDiffFile({
      id: "quick",
      path: "quick.ts",
      before: "old\n",
      after: "new\n",
    });
    const slowFile = createTestDiffFile({
      id: "slow",
      path: "slow.ts",
      before: "old\n",
      after: "new\n",
    });
    // The slow file never settles, exactly like a highlighter running into its
    // timeout on every file of a large changeset.
    const highlighter = createTestHighlighter((input) =>
      input.file.id === slowFile.id
        ? new Promise(() => {})
        : [{ side: "new", line: 1, range: [0, 3] } satisfies ExtensionLineHighlight],
    );
    let latest: ReadonlyMap<string, readonly ValidatedLineHighlight[]> = new Map();
    const bothFiles = [slowFile, quickFile];
    const highlighters = [highlighter];

    function Harness() {
      latest = useLineHighlights({
        files: bothFiles,
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

      expect(latest.get(quickFile.id)).toEqual([
        { side: "new", line: 1, start: 0, end: 3, tone: "match" },
      ]);
      expect(latest.get(slowFile.id)).toBeUndefined();
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("stops publishing a file's marks once the review replaces that file", async () => {
    // Reloads usually reuse file ids, so marks addressed at the previous text
    // would otherwise keep painting at their old offsets on new content for as
    // long as the replacement takes to prepare.
    const reloaded = createTestDiffFile({
      id: file.id,
      path: file.path,
      before: "old\n",
      after: "a completely different line\n",
    });
    // The replacement's marks never settle, so anything the map still exposes
    // for that id is the previous review's.
    let requests = 0;
    const highlighter = createTestHighlighter(() =>
      requests++ === 0
        ? [{ side: "new", line: 1, range: [0, 3] } satisfies ExtensionLineHighlight]
        : new Promise(() => {}),
    );
    let latest: ReadonlyMap<string, readonly ValidatedLineHighlight[]> = new Map();
    let reload = () => {};
    const highlighters = [highlighter];

    function Harness() {
      const [current, setCurrent] = useState(files);
      reload = () => setCurrent([reloaded]);
      latest = useLineHighlights({
        files: current,
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
      expect(latest.get(file.id)).toBeDefined();

      await act(async () => {
        reload();
        await setup.renderOnce();
        await Promise.resolve();
        await setup.renderOnce();
      });

      expect(latest.get(reloaded.id)).toBeUndefined();
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("keeps every active file's result retained, however many files the review has", async () => {
    // Retention used to stop at a fixed entry ceiling, so a review with more
    // active (file, highlighter) pairs than the ceiling evicted live results
    // and refreshing one file reran unrelated ones.
    const manyFiles = Array.from({ length: 600 }, (_, index) =>
      createTestDiffFile({
        id: `file-${index}`,
        path: `file-${index}.ts`,
        before: "old\n",
        after: "new\n",
      }),
    );
    const calls: string[] = [];
    const highlighter = createTestHighlighter((input) => {
      calls.push(input.file.id);
      return [{ side: "new", line: 1, range: [0, 3] }];
    });
    const key = registeredLineHighlighterKey(highlighter);
    const highlighters = [highlighter];
    let bump = () => {};

    function Harness() {
      const [epochs, setEpochs] = useState<LineHighlightEpochState>(() => new Map());
      bump = () => setEpochs((current) => bumpScopedEpoch(current, key, "file-0"));
      useLineHighlights({ files: manyFiles, highlighters, epochs, onIssue: ignoreIssue });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    try {
      await act(async () => {
        for (let turn = 0; turn < 20_000 && calls.length < manyFiles.length; turn += 1) {
          await Promise.resolve();
        }
        await setup.renderOnce();
      });
      expect(calls).toHaveLength(manyFiles.length);

      calls.length = 0;
      await act(async () => {
        bump();
        await setup.renderOnce();
        for (let turn = 0; turn < 20_000 && calls.length === 0; turn += 1) {
          await Promise.resolve();
        }
        await setup.renderOnce();
      });

      expect(calls).toEqual(["file-0"]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("drops the highlighter that pushes one file past the merged cap", async () => {
    // Each highlighter stays under its own per-file cap; only the merge exceeds
    // what paint should have to carry.
    const issues: string[] = [];
    const fullResult = Array.from({ length: MAX_LINE_HIGHLIGHTS_PER_FILE }, (_, index) => ({
      side: "new" as const,
      line: Math.floor(index / 50) + 1,
      range: [index, index + 1] as const,
    }));
    const highlighters = [
      createTestHighlighter(() => fullResult, "first"),
      createTestHighlighter(() => fullResult, "second"),
      createTestHighlighter(
        () => [{ side: "new" as const, line: 1, range: [0, 1] as const }],
        "third",
      ),
    ];
    let latest: ReadonlyMap<string, readonly ValidatedLineHighlight[]> = new Map();

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

      expect(latest.get(file.id)).toHaveLength(MAX_MERGED_LINE_HIGHLIGHTS_PER_FILE);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('line highlighter "third"');
      expect(issues[0]).toContain("merged ranges");
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
