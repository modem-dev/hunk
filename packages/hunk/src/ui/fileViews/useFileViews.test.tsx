import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement, useState } from "react";
import {
  createTestDiffFile,
  createTestSourceFetcher,
} from "../../../../../test/helpers/diff-helpers";
import type { RegisteredFileView } from "../../extensions/types";
import { bumpFileViewEpoch, registeredFileViewKey, type FileViewEpochState } from "./state";
import {
  FILE_VIEW_LAYOUT_CACHE_MAX_ENTRIES,
  FILE_VIEW_LAYOUT_RESIZE_DEBOUNCE_MS,
  runFileViewLayoutRequest,
  useFileViewLayouts,
  type ResolvedFileViewLayout,
} from "./useFileViews";

/** Build one registration with a test-controlled layout callback. */
function createTestView(layout: RegisteredFileView["view"]["layout"]): RegisteredFileView {
  return {
    extensionId: "test-extension",
    view: {
      id: "test-view",
      title: "Test view",
      matches: () => true,
      layout,
    },
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

describe("file-view layout request lifetime", () => {
  test("aborts its child signal after successful completion", async () => {
    let signal: AbortSignal | undefined;
    const view = createTestView((input) => {
      signal = input.signal;
      return null;
    });

    expect(
      await runFileViewLayoutRequest(view, file, 80, new AbortController().signal, 50),
    ).toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  test("reads only bound exact-source sides before accepting a layout", async () => {
    const sourceFetcher = createTestSourceFetcher(async (side) =>
      side === "new" ? "new\n" : "old\n",
    );
    const sourceFile = createTestDiffFile({
      id: "bound",
      path: "bound.ts",
      before: "old\n",
      after: "new\n",
      sourceFetcher,
    });
    const view = createTestView(({ file: inputFile }) => ({
      rows: [
        {
          id: "bound-row",
          spans: [{ text: "bound" }],
          sourceRanges: [{ side: "new", range: [1, 1] }],
        },
      ],
      hunkRows: (inputFile.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }));

    await expect(
      runFileViewLayoutRequest(view, sourceFile, 80, new AbortController().signal, 50),
    ).resolves.toMatchObject({ layout: { rows: [{ id: "bound-row" }] } });
    expect(sourceFetcher.calls).toEqual(["new"]);
  });

  test("times out a hung binding read instead of holding the preparation slot", async () => {
    let resolveRead: ((value: string | null) => void) | undefined;
    const sourceFetcher = createTestSourceFetcher(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const sourceFile = createTestDiffFile({
      id: "hung",
      path: "hung.ts",
      before: "old\n",
      after: "new\n",
      sourceFetcher,
    });
    // The extension itself returns immediately; only the host read its bindings require hangs.
    const view = createTestView(({ file: inputFile }) => ({
      rows: [
        {
          id: "bound-row",
          spans: [{ text: "bound" }],
          sourceRanges: [{ side: "new", range: [1, 1] }],
        },
      ],
      hunkRows: (inputFile.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }));

    let settlements = 0;
    await runFileViewLayoutRequest(view, sourceFile, 80, new AbortController().signal, 5).then(
      () => settlements++,
      () => settlements++,
    );
    expect(settlements).toBe(1);
    // The read was issued and is still pending, so the budget — not the read — released the slot.
    expect(sourceFetcher.calls).toEqual(["new"]);
    expect(resolveRead).toBeDefined();

    resolveRead?.("new\n");
    await Promise.resolve();
    expect(settlements).toBe(1);
  });

  test("aborts on timeout and ignores a late extension result", async () => {
    let signal: AbortSignal | undefined;
    let resolveLate: ((value: null) => void) | undefined;
    const late = new Promise<null>((resolve) => {
      resolveLate = resolve;
    });
    const view = createTestView((input) => {
      signal = input.signal;
      return late;
    });

    let settlements = 0;
    const request = runFileViewLayoutRequest(view, file, 80, new AbortController().signal, 5).then(
      () => settlements++,
      () => settlements++,
    );
    await request;
    expect(signal?.aborted).toBe(true);
    expect(settlements).toBe(1);

    resolveLate?.(null);
    await Promise.resolve();
    expect(settlements).toBe(1);
  });

  test("links parent supersession into the child request signal", async () => {
    let signal: AbortSignal | undefined;
    const parent = new AbortController();
    const view = createTestView((input) => {
      signal = input.signal;
      return new Promise<null>(() => {});
    });
    const request = runFileViewLayoutRequest(view, file, 80, parent.signal, 50).catch(() => null);

    await Promise.resolve();
    parent.abort();
    expect(signal?.aborted).toBe(true);
    await request;
  });
});

describe("inactive file-view preparation", () => {
  test("does not schedule empty-map renders while every file uses raw diff", async () => {
    let renderCount = 0;
    let replaceFiles = () => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [visibleFiles, setVisibleFiles] = useState(files);
      replaceFiles = () => setVisibleFiles([...files]);
      renderCount += 1;
      latest = useFileViewLayouts({
        files: visibleFiles,
        selections: {},
        views: [],
        width: 80,
        onIssue: ignoreIssue,
      });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    try {
      await act(async () => {
        await Promise.resolve();
        await setup.renderOnce();
      });
      expect(renderCount).toBe(1);
      expect(latest.size).toBe(0);

      await act(async () => {
        replaceFiles();
        await setup.renderOnce();
        await Promise.resolve();
      });
      expect(renderCount).toBe(2);
      expect(latest.size).toBe(0);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});

describe("file-view layout cache identity", () => {
  test("retains exact unaffected files while suppressing another file's changed selection", async () => {
    const secondFile = createTestDiffFile({
      id: "second-request",
      path: "second-request.ts",
      before: "before\n",
      after: "after\n",
    });
    const primary = createTestView(({ file: inputFile }) => ({
      rows: [{ id: "row", spans: [{ text: inputFile.id }] }],
      hunkRows: (inputFile.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }));
    const delayed = createTestView(() => new Promise(() => {}));
    delayed.view.id = "delayed-view";
    const primaryKey = registeredFileViewKey(primary);
    const delayedKey = registeredFileViewKey(delayed);
    const allFiles = [file, secondFile];
    const views = [primary, delayed];
    let selectDelayed = () => {};
    let filterSecond = () => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [visibleFiles, setVisibleFiles] = useState(allFiles);
      const [selections, setSelections] = useState<Record<string, string>>({
        [file.id]: primaryKey,
        [secondFile.id]: primaryKey,
      });
      selectDelayed = () =>
        setSelections((current) => ({ ...current, [secondFile.id]: delayedKey }));
      filterSecond = () => setVisibleFiles([file]);
      latest = useFileViewLayouts({
        files: visibleFiles,
        selections,
        views,
        width: 80,
        onIssue: ignoreIssue,
      });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    try {
      for (let attempt = 0; attempt < 20 && latest.size !== 2; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
      }
      expect([...latest.keys()]).toEqual([file.id, secondFile.id]);

      await act(async () => {
        selectDelayed();
        await setup.renderOnce();
      });
      expect([...latest.keys()]).toEqual([file.id]);

      await act(async () => {
        filterSecond();
        await setup.renderOnce();
      });
      expect([...latest.keys()]).toEqual([file.id]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("synchronously hides a stale width generation before effects clean it up", async () => {
    const renderedWidths: [number, string][] = [];
    const view = createTestView(({ width }) => ({
      rows: [{ id: "row", spans: [{ text: String(width) }] }],
      hunkRows: file.metadata.hunks.map(() => ({ startRow: 0, endRow: 0 })),
    }));
    const selections = { [file.id]: registeredFileViewKey(view) };
    const views = [view];
    let changeWidth = (_width: number) => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [width, setWidth] = useState(80);
      changeWidth = setWidth;
      latest = useFileViewLayouts({ files, selections, views, width, onIssue: ignoreIssue });
      const text = latest.get(file.id)?.layout.rows[0]?.spans[0]?.text;
      if (text) renderedWidths.push([width, text]);
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    const settleAt = async (expectedWidth: string) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
        if (latest.get(file.id)?.layout.rows[0]?.spans[0]?.text === expectedWidth) return;
      }
      throw new Error(`layout did not settle at width ${expectedWidth}`);
    };

    try {
      await settleAt("80");
      renderedWidths.length = 0;
      await act(async () => {
        changeWidth(40);
        await setup.renderOnce();
      });
      expect(renderedWidths).not.toContainEqual([40, "80"]);
      await act(async () => {
        await Bun.sleep(FILE_VIEW_LAYOUT_RESIZE_DEBOUNCE_MS + 10);
        await setup.renderOnce();
      });
      await settleAt("40");
      expect(renderedWidths).toContainEqual([40, "40"]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("coalesces rapid width changes without exposing stale geometry", async () => {
    const layoutWidths: number[] = [];
    const view = createTestView(({ width }) => {
      layoutWidths.push(width);
      return {
        rows: [{ id: "row", spans: [{ text: String(width) }] }],
        hunkRows: file.metadata.hunks.map(() => ({ startRow: 0, endRow: 0 })),
      };
    });
    const selections = { [file.id]: registeredFileViewKey(view) };
    const views = [view];
    let changeWidth = (_width: number) => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [width, setWidth] = useState(80);
      changeWidth = setWidth;
      latest = useFileViewLayouts({ files, selections, views, width, onIssue: ignoreIssue });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    try {
      for (let attempt = 0; attempt < 20 && latest.size === 0; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
      }
      expect(layoutWidths).toEqual([80]);

      for (const width of [79, 78, 77]) {
        await act(async () => {
          changeWidth(width);
          await setup.renderOnce();
        });
        expect(latest.size).toBe(0);
      }
      await act(async () => {
        await Bun.sleep(FILE_VIEW_LAYOUT_RESIZE_DEBOUNCE_MS + 10);
        await setup.renderOnce();
      });
      for (let attempt = 0; attempt < 20 && latest.size === 0; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
      }

      expect(layoutWidths).toEqual([80, 77]);
      expect(latest.get(file.id)?.layout.rows[0]?.spans[0]?.text).toBe("77");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("replaces stale width variants for one file/view/registration", async () => {
    const layoutWidths: number[] = [];
    const view = createTestView(({ width }) => {
      layoutWidths.push(width);
      return {
        rows: [{ id: "row", spans: [{ text: String(width) }] }],
        hunkRows: file.metadata.hunks.map(() => ({ startRow: 0, endRow: 0 })),
      };
    });
    const selections = { [file.id]: registeredFileViewKey(view) };
    const views = [view];
    let changeWidth = (_width: number) => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [width, setWidth] = useState(80);
      changeWidth = setWidth;
      latest = useFileViewLayouts({ files, selections, views, width, onIssue: ignoreIssue });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    const settleAt = async (expectedWidth: string) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
        if (latest.get(file.id)?.layout.rows[0]?.spans[0]?.text === expectedWidth) return;
      }
      throw new Error(`layout did not settle at width ${expectedWidth}`);
    };

    try {
      await settleAt("80");
      await act(async () => {
        changeWidth(40);
        await setup.renderOnce();
      });
      await act(async () => {
        await Bun.sleep(FILE_VIEW_LAYOUT_RESIZE_DEBOUNCE_MS + 10);
        await setup.renderOnce();
      });
      await settleAt("40");
      await act(async () => {
        changeWidth(80);
        await setup.renderOnce();
      });
      await act(async () => {
        await Bun.sleep(FILE_VIEW_LAYOUT_RESIZE_DEBOUNCE_MS + 10);
        await setup.renderOnce();
      });
      await settleAt("80");
      expect(layoutWidths).toEqual([80, 40, 80]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("evicts the oldest prepared tree after the cache limit", async () => {
    const candidates = Array.from({ length: FILE_VIEW_LAYOUT_CACHE_MAX_ENTRIES + 1 }, (_, index) =>
      createTestDiffFile({
        id: `cache-${index}`,
        path: `cache-${index}.ts`,
        before: "old\n",
        after: "new\n",
      }),
    );
    const layoutCalls = new Map<string, number>();
    const view = createTestView(({ file: inputFile }) => {
      layoutCalls.set(inputFile.id, (layoutCalls.get(inputFile.id) ?? 0) + 1);
      return {
        rows: [{ id: "row", spans: [{ text: inputFile.id }] }],
        hunkRows: (inputFile.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
      };
    });
    const key = registeredFileViewKey(view);
    const candidateFiles = candidates.map((candidate) => [candidate] as const);
    const candidateSelections = candidates.map((candidate) => ({ [candidate.id]: key }));
    const views = [view];
    let choose = (_index: number) => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [index, setIndex] = useState(0);
      choose = setIndex;
      latest = useFileViewLayouts({
        files: candidateFiles[index]!,
        selections: candidateSelections[index]!,
        views,
        width: 80,
        onIssue: ignoreIssue,
      });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    const settleAt = async (index: number) => {
      const expectedId = candidates[index]!.id;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
        if (latest.has(expectedId)) return;
      }
      throw new Error(`layout did not settle for ${expectedId}`);
    };

    try {
      await settleAt(0);
      for (let index = 1; index < candidates.length; index += 1) {
        await act(async () => {
          choose(index);
          await setup.renderOnce();
        });
        await settleAt(index);
      }
      await act(async () => {
        choose(0);
        await setup.renderOnce();
      });
      await settleAt(0);
      expect(layoutCalls.get(candidates[0]!.id)).toBe(2);
      expect(layoutCalls.get(candidates.at(-1)!.id)).toBe(1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("deduplicates deterministic failures across widths but reports a replacement registration", async () => {
    const issues: string[] = [];
    let layoutCalls = 0;
    const buildBrokenRegistration = () =>
      createTestView(() => {
        layoutCalls += 1;
        throw new Error("deterministic failure");
      });
    const first = buildBrokenRegistration();
    const selections = { [file.id]: registeredFileViewKey(first) };
    const reportIssue = (message: string) => issues.push(message);
    let resize = (_width: number) => {};
    let reload = () => {};

    function Harness() {
      const [width, setWidth] = useState(80);
      const [views, setViews] = useState<RegisteredFileView[]>([first]);
      resize = setWidth;
      reload = () => setViews([buildBrokenRegistration()]);
      useFileViewLayouts({ files, selections, views, width, onIssue: reportIssue });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    const settleCalls = async (expected: number, expectedIssues: number) => {
      for (
        let attempt = 0;
        attempt < 20 && (layoutCalls < expected || issues.length < expectedIssues);
        attempt += 1
      ) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
      }
      expect(layoutCalls).toBe(expected);
      expect(issues).toHaveLength(expectedIssues);
    };

    try {
      await settleCalls(1, 1);
      expect(issues).toHaveLength(1);
      for (const [index, width] of [79, 78, 77].entries()) {
        await act(async () => {
          resize(width);
          await setup.renderOnce();
        });
        await act(async () => {
          await Bun.sleep(FILE_VIEW_LAYOUT_RESIZE_DEBOUNCE_MS + 10);
          await setup.renderOnce();
        });
        await settleCalls(index + 2, 1);
      }
      expect(issues).toHaveLength(1);

      await act(async () => {
        reload();
        await setup.renderOnce();
      });
      await settleCalls(5, 2);
      expect(issues).toHaveLength(2);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("synchronously suppresses a stale concrete registration", async () => {
    const first = createTestView(() => ({
      rows: [{ id: "first", spans: [{ text: "first" }] }],
      hunkRows: file.metadata.hunks.map(() => ({ startRow: 0, endRow: 0 })),
    }));
    let resolveReplacement:
      | ((layout: ReturnType<RegisteredFileView["view"]["layout"]>) => void)
      | undefined;
    const replacement = createTestView(
      () =>
        new Promise((resolve) => {
          resolveReplacement = resolve;
        }),
    );
    const selections = { [file.id]: registeredFileViewKey(first) };
    let reload = () => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [views, setViews] = useState<RegisteredFileView[]>([first]);
      reload = () => setViews([replacement]);
      latest = useFileViewLayouts({ files, selections, views, width: 80, onIssue: ignoreIssue });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    try {
      for (let attempt = 0; attempt < 20 && latest.size === 0; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
      }
      expect(latest.get(file.id)?.layout.rows[0]?.id).toBe("first");

      await act(async () => {
        reload();
        await setup.renderOnce();
      });
      expect(latest.size).toBe(0);

      resolveReplacement?.({
        rows: [{ id: "replacement", spans: [{ text: "replacement" }] }],
        hunkRows: file.metadata.hunks.map(() => ({ startRow: 0, endRow: 0 })),
      });
      for (let attempt = 0; attempt < 20 && latest.size === 0; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
      }
      expect(latest.get(file.id)?.layout.rows[0]?.id).toBe("replacement");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("uses a valid cache before matches and invalidates a replaced registration", async () => {
    let matchesCalls = 0;
    let layoutCalls = 0;
    const buildRegistration = () =>
      createTestView(() => {
        layoutCalls += 1;
        return {
          rows: [{ id: "row", spans: [{ text: "row" }] }],
          hunkRows: file.metadata.hunks.map(() => ({ startRow: 0, endRow: 0 })),
        };
      });
    const firstRegistration = buildRegistration();
    firstRegistration.view.matches = () => {
      matchesCalls += 1;
      return true;
    };
    let refreshSelection = () => {};
    let replaceRegistration = () => {};
    let latest = new Map<string, ResolvedFileViewLayout>() as ReadonlyMap<
      string,
      ResolvedFileViewLayout
    >;
    const issue = () => {};

    function Harness() {
      const [selections, setSelections] = useState<Record<string, string>>({
        [file.id]: registeredFileViewKey(firstRegistration),
      });
      const [views, setViews] = useState<RegisteredFileView[]>([firstRegistration]);
      refreshSelection = () => setSelections((current) => ({ ...current }));
      replaceRegistration = () => {
        const replacement = buildRegistration();
        replacement.view.matches = () => {
          matchesCalls += 1;
          return true;
        };
        setViews([replacement]);
      };
      latest = useFileViewLayouts({ files, selections, views, width: 80, onIssue: issue });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    const settle = async () => {
      for (let attempt = 0; attempt < 20 && latest.size === 0; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
      }
    };

    try {
      await settle();
      const first = latest.get(file.id);
      expect(first).toBeDefined();
      expect([matchesCalls, layoutCalls]).toEqual([1, 1]);

      await act(async () => {
        refreshSelection();
        await setup.renderOnce();
      });
      await settle();
      expect([matchesCalls, layoutCalls]).toEqual([1, 1]);
      expect(latest.get(file.id)).toBe(first);

      await act(async () => {
        replaceRegistration();
        await setup.renderOnce();
      });
      await settle();
      expect([matchesCalls, layoutCalls]).toEqual([2, 2]);
      expect(latest.get(file.id)?.registrationIdentity).not.toBe(first?.registrationIdentity);
      expect(latest.get(file.id)?.layoutGeneration).not.toBe(first?.layoutGeneration);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});

describe("file-view layout invalidation", () => {
  test("re-runs matches and layout for the same file and width after a refresh", async () => {
    let matchesCalls = 0;
    let generation = 0;
    const view = createTestView(({ file: inputFile }) => ({
      rows: [{ id: "row", spans: [{ text: `generation ${generation}` }] }],
      hunkRows: (inputFile.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }));
    view.view.matches = () => {
      matchesCalls += 1;
      return true;
    };
    const key = registeredFileViewKey(view);
    const selections = { [file.id]: key };
    const views = [view];
    let refresh = () => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [epochs, setEpochs] = useState<FileViewEpochState>(() => new Map());
      refresh = () => setEpochs((current) => bumpFileViewEpoch(current, key));
      latest = useFileViewLayouts({
        files,
        selections,
        views,
        width: 80,
        epochs,
        onIssue: ignoreIssue,
      });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    const settleAt = async (expected: string) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
        if (latest.get(file.id)?.layout.rows[0]?.spans[0]?.text === expected) return;
      }
      throw new Error(`layout did not settle at "${expected}"`);
    };

    try {
      await settleAt("generation 0");
      const first = latest.get(file.id);
      expect(matchesCalls).toBe(1);

      generation = 1;
      await act(async () => {
        refresh();
        await setup.renderOnce();
      });
      await settleAt("generation 1");
      // The refreshed pass re-consults the extension rather than reusing the cached tree.
      expect(matchesCalls).toBe(2);
      expect(latest.get(file.id)?.layoutGeneration).not.toBe(first?.layoutGeneration);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("keeps the previous layout visible until the refreshed layout resolves", async () => {
    let layoutCalls = 0;
    let resolveRefreshed:
      | ((layout: ReturnType<RegisteredFileView["view"]["layout"]>) => void)
      | undefined;
    const view = createTestView(({ file: inputFile }) => {
      layoutCalls += 1;
      if (layoutCalls > 1) {
        return new Promise((resolve) => {
          resolveRefreshed = resolve;
        });
      }
      return {
        rows: [{ id: "row", spans: [{ text: "before refresh" }] }],
        hunkRows: (inputFile.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
      };
    });
    const key = registeredFileViewKey(view);
    const selections = { [file.id]: key };
    const views = [view];
    let refresh = () => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [epochs, setEpochs] = useState<FileViewEpochState>(() => new Map());
      refresh = () => setEpochs((current) => bumpFileViewEpoch(current, key));
      latest = useFileViewLayouts({
        files,
        selections,
        views,
        width: 80,
        epochs,
        onIssue: ignoreIssue,
      });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    const rowText = () => latest.get(file.id)?.layout.rows[0]?.spans[0]?.text;

    try {
      for (let attempt = 0; attempt < 20 && latest.size === 0; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
      }
      expect(rowText()).toBe("before refresh");

      await act(async () => {
        refresh();
        await setup.renderOnce();
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
        // Never a flash back to raw diff while the replacement is still pending.
        expect(rowText()).toBe("before refresh");
      }
      expect(resolveRefreshed).toBeDefined();

      resolveRefreshed?.({
        rows: [{ id: "row", spans: [{ text: "after refresh" }] }],
        hunkRows: file.metadata.hunks.map(() => ({ startRow: 0, endRow: 0 })),
      });
      for (let attempt = 0; attempt < 20 && rowText() !== "after refresh"; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
      }
      expect(rowText()).toBe("after refresh");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("does no work for an unselected view and re-prepares it when selected again", async () => {
    let layoutCalls = 0;
    const view = createTestView(({ file: inputFile }) => {
      layoutCalls += 1;
      return {
        rows: [{ id: "row", spans: [{ text: `layout ${layoutCalls}` }] }],
        hunkRows: (inputFile.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
      };
    });
    const key = registeredFileViewKey(view);
    const views = [view];
    // Stable identities: the hook keys its preparation effect on the selections object itself.
    const selectedSelections = { [file.id]: key };
    const rawSelections: Record<string, string> = {};
    let selectView = (_selected: boolean) => {};
    let refresh = () => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [selected, setSelected] = useState(true);
      const [epochs, setEpochs] = useState<FileViewEpochState>(() => new Map());
      selectView = setSelected;
      refresh = () => setEpochs((current) => bumpFileViewEpoch(current, key));
      latest = useFileViewLayouts({
        files,
        selections: selected ? selectedSelections : rawSelections,
        views,
        width: 80,
        epochs,
        onIssue: ignoreIssue,
      });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    const settle = async () => {
      for (let attempt = 0; attempt < 20 && latest.size === 0; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
      }
    };

    try {
      await settle();
      expect(layoutCalls).toBe(1);

      await act(async () => {
        selectView(false);
        await setup.renderOnce();
      });
      await act(async () => {
        refresh();
        await setup.renderOnce();
        await Promise.resolve();
      });
      // Raw diff everywhere: an invalidated view that nothing presents costs no extension work.
      expect(layoutCalls).toBe(1);

      await act(async () => {
        selectView(true);
        await setup.renderOnce();
      });
      await settle();
      expect(layoutCalls).toBe(2);
      expect(latest.get(file.id)?.layout.rows[0]?.spans[0]?.text).toBe("layout 2");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("re-lays out only the named file for a scoped refresh and both for a view-wide one", async () => {
    const other = createTestDiffFile({
      id: "sibling",
      path: "sibling.ts",
      before: "old\n",
      after: "new\n",
    });
    const bothFiles = [file, other];
    const layoutCalls = new Map<string, number>();
    const view = createTestView(({ file: inputFile }) => {
      const calls = (layoutCalls.get(inputFile.id) ?? 0) + 1;
      layoutCalls.set(inputFile.id, calls);
      return {
        rows: [{ id: "row", spans: [{ text: `${inputFile.id} layout ${calls}` }] }],
        hunkRows: (inputFile.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
      };
    });
    const key = registeredFileViewKey(view);
    // One view presenting every matching file, as the bulk "apply to all matching files" action leaves it.
    const selections = { [file.id]: key, [other.id]: key };
    const views = [view];
    let refresh = (_fileId?: string) => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [epochs, setEpochs] = useState<FileViewEpochState>(() => new Map());
      refresh = (fileId) => setEpochs((current) => bumpFileViewEpoch(current, key, fileId));
      latest = useFileViewLayouts({
        files: bothFiles,
        selections,
        views,
        width: 80,
        epochs,
        onIssue: ignoreIssue,
      });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    const settleAt = async (fileId: string, expected: string) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
        if (latest.get(fileId)?.layout.rows[0]?.spans[0]?.text === expected) return;
      }
      throw new Error(`layout for ${fileId} did not settle at "${expected}"`);
    };

    try {
      await settleAt(file.id, "request layout 1");
      await settleAt(other.id, "sibling layout 1");

      await act(async () => {
        refresh(file.id);
        await setup.renderOnce();
      });
      await settleAt(file.id, "request layout 2");
      // The sibling's prepared tree is still retained under its own unchanged epoch.
      expect(layoutCalls.get(other.id)).toBe(1);
      expect(latest.get(other.id)?.layout.rows[0]?.spans[0]?.text).toBe("sibling layout 1");

      await act(async () => {
        refresh();
        await setup.renderOnce();
      });
      await settleAt(file.id, "request layout 3");
      await settleAt(other.id, "sibling layout 2");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
