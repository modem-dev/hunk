import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, StrictMode, useState } from "react";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import type { DiffFile } from "../../core/changeset/model";
import type {
  ExtensionFileViewCodeDocument,
  ExtensionFileViewLayout,
  ExtensionFileViewRow,
} from "../../extension-api/types";
import {
  createDocumentHighlightService,
  type DocumentHighlightInput,
  type DocumentHighlightResult,
} from "../diff/documentHighlightService";
import { encodeCompactHighlightedDocument } from "../diff/worker";
import { createVisibleAgentNote } from "../lib/agentAnnotations";
import { resolveTheme, type AppTheme } from "../themes";
import { validateFileViewLayout } from "./layout";
import { buildFileViewRenderPlan, type PlannedFileViewRow } from "./renderPlan";
import {
  demandedFileViewSyntaxDocumentIds,
  useFileViewSyntaxHighlight,
} from "./useFileViewSyntaxHighlight";
import type { ResolvedFileViewLayout } from "./useFileViews";

interface HookProps {
  file: DiffFile;
  fileView: ResolvedFileViewLayout;
  mountedRows: readonly PlannedFileViewRow[];
  offloadLargeDiff: boolean;
  shouldLoadHighlight: boolean;
  theme: AppTheme;
}

type DocumentLoader = (input: DocumentHighlightInput) => Promise<DocumentHighlightResult>;

/** Build one immutable fallback with controllable retry semantics. */
function fallback(
  reason: "invalid-document" | "highlight-failed" | "unsupported-language",
  retryable = false,
) {
  return Object.freeze({
    status: "fallback",
    reason,
    retryable,
  }) satisfies DocumentHighlightResult;
}

/** Validate a layout and attach the host identities used to suppress stale work. */
function resolveTestLayout(
  codeDocuments: readonly ExtensionFileViewCodeDocument[] | undefined,
  rows: readonly ExtensionFileViewRow[],
  options: { generation?: number; registration?: number; viewId?: string } = {},
): ResolvedFileViewLayout {
  const layout: ExtensionFileViewLayout = {
    ...(codeDocuments ? { codeDocuments } : {}),
    rows,
    hunkRows: [{ startRow: 0, endRow: Math.max(0, rows.length - 1) }],
  };
  const checked = validateFileViewLayout(layout, 1, 80);
  if (!checked.valid) throw new Error(checked.issue);
  return {
    ...checked.value,
    key: `test:${options.viewId ?? "view"}`,
    extensionId: "test",
    viewId: options.viewId ?? "view",
    registrationIdentity: options.registration ?? 1,
    layoutGeneration: options.generation ?? 1,
  };
}

/** Return the extension rows from one host render plan. */
function plannedRows(fileView: ResolvedFileViewLayout) {
  return buildFileViewRenderPlan(fileView.layout, []).rows;
}

/** Render the hook with mutable props and an injectable document service. */
async function renderHookHarness(
  initial: HookProps,
  load: DocumentLoader,
  options: { maxRetries?: number; retryDelayMs?: number } = {},
) {
  let current: ReadonlyMap<string, DocumentHighlightResult> = new Map();
  let setProps!: (props: HookProps) => void;

  function Harness() {
    const [props, updateProps] = useState(initial);
    setProps = updateProps;
    current = useFileViewSyntaxHighlight(props, { load, ...options });
    return null;
  }

  const setup = await testRender(<Harness />, { width: 80, height: 8 });
  await flush(setup);
  return { current: () => current, setProps, setup };
}

/** Let layout effects, promises, and short retry timers settle. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>, delay = 5) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(delay);
  });
}

/** Return one externally controlled promise. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const theme = resolveTheme("github-dark-default", null);
const file = createTestDiffFile({
  id: "file",
  path: "src/file.ts",
  language: "typescript",
});
const documents = [
  { id: "old", text: "const oldValue = 1;", language: "typescript" },
  { id: "new", text: "const newValue = 2;" },
];
const rows = [
  {
    id: "old-row",
    spans: [{ text: documents[0]!.text, syntax: { documentId: "old", line: 1 } }],
  },
  { id: "plain", spans: [{ text: "separator" }] },
  {
    id: "new-row",
    spans: [{ text: documents[1]!.text, syntax: { documentId: "new", line: 1 } }],
  },
] satisfies readonly ExtensionFileViewRow[];

describe("file-view syntax demand", () => {
  test("ignores plain rows and inserted semantic note rows", () => {
    const boundRows: readonly ExtensionFileViewRow[] = [
      {
        ...rows[0]!,
        sourceRanges: [{ side: "new", range: [1, 2] }],
      },
      ...rows.slice(1),
    ];
    const fileView = resolveTestLayout(documents, boundRows);
    const plan = buildFileViewRenderPlan(fileView.layout, [
      createVisibleAgentNote([], {
        id: "note",
        annotation: { id: "note", summary: "note", newRange: [1, 1] },
      }),
    ]);
    const noteOnly = plan.rows.filter((row) => row.kind === "inline-note");
    const plainOnly = plan.rows.filter(
      (row) => row.kind === "file-view-row" && row.row.id === "plain",
    );
    expect(noteOnly).toHaveLength(1);
    expect([...demandedFileViewSyntaxDocumentIds(noteOnly)]).toEqual([]);
    expect([...demandedFileViewSyntaxDocumentIds(plainOnly)]).toEqual([]);
  });

  test("demands both sides of one mounted split-style symbolic row", async () => {
    const splitRow = {
      id: "split",
      spans: [
        { text: documents[0]!.text, syntax: { documentId: "old", line: 1 } },
        { text: " | " },
        { text: documents[1]!.text, syntax: { documentId: "new", line: 1 } },
      ],
      component: { height: 1, render: () => null },
    } satisfies ExtensionFileViewRow;
    const fileView = resolveTestLayout(documents, [splitRow]);
    const calls: string[] = [];
    const harness = await renderHookHarness(
      {
        file,
        fileView,
        mountedRows: plannedRows(fileView),
        offloadLargeDiff: false,
        shouldLoadHighlight: true,
        theme,
      },
      async (input) => {
        calls.push(input.text);
        return fallback("invalid-document");
      },
    );

    try {
      expect(calls).toEqual([documents[0]!.text, documents[1]!.text]);
      expect([...harness.current().keys()]).toEqual(["old", "new"]);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("does not load without references, visible references, or host demand", async () => {
    let calls = 0;
    const load: DocumentLoader = async () => {
      calls += 1;
      return fallback("invalid-document");
    };
    const fileView = resolveTestLayout(documents, rows);
    const plan = plannedRows(fileView);
    const harness = await renderHookHarness(
      {
        file,
        fileView,
        mountedRows: [plan[1]!],
        offloadLargeDiff: false,
        shouldLoadHighlight: true,
        theme,
      },
      load,
    );

    try {
      expect(calls).toBe(0);
      await act(async () =>
        harness.setProps({
          file,
          fileView,
          mountedRows: [plan[0]!],
          offloadLargeDiff: false,
          shouldLoadHighlight: false,
          theme,
        }),
      );
      await flush(harness.setup);
      expect(calls).toBe(0);
      expect(harness.current().size).toBe(0);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("loads visible and halo documents, waits for offscreen rows, and reuses retained results", async () => {
    const calls: string[] = [];
    const load: DocumentLoader = async (input) => {
      calls.push(input.text);
      return fallback("invalid-document");
    };
    const fileView = resolveTestLayout(documents, rows);
    const plan = plannedRows(fileView);
    const harness = await renderHookHarness(
      {
        file,
        fileView,
        mountedRows: [plan[0]!],
        offloadLargeDiff: false,
        shouldLoadHighlight: true,
        theme,
      },
      load,
    );

    try {
      expect(calls).toEqual([documents[0]!.text]);
      expect(harness.current().has("old")).toBe(true);
      expect(harness.current().has("new")).toBe(false);

      await act(async () =>
        harness.setProps({
          file,
          fileView,
          mountedRows: [plan[0]!, plan[2]!],
          offloadLargeDiff: false,
          shouldLoadHighlight: true,
          theme,
        }),
      );
      await flush(harness.setup);
      expect(calls).toEqual([documents[0]!.text, documents[1]!.text]);
      expect([...harness.current().keys()]).toEqual(["old", "new"]);

      await act(async () =>
        harness.setProps({
          file,
          fileView,
          mountedRows: [plan[2]!],
          offloadLargeDiff: false,
          shouldLoadHighlight: true,
          theme,
        }),
      );
      await flush(harness.setup);
      await act(async () =>
        harness.setProps({
          file,
          fileView,
          mountedRows: [plan[0]!],
          offloadLargeDiff: false,
          shouldLoadHighlight: true,
          theme,
        }),
      );
      await flush(harness.setup);
      expect(calls).toHaveLength(2);
      expect([...harness.current().keys()]).toEqual(["old"]);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("does not restart for equivalent resize generations or reconstructed StrictMode inputs", async () => {
    let calls = 0;
    let bump!: () => void;
    const load: DocumentLoader = async () => {
      calls += 1;
      return fallback("invalid-document");
    };
    function Source({ generation }: { generation: number }) {
      const reconstructed = resolveTestLayout(
        documents.map((document) => ({ ...document })),
        rows.map((row) => ({
          ...row,
          spans: row.spans.map((span) => ({ ...span })),
        })),
        { generation },
      );
      useFileViewSyntaxHighlight(
        {
          file: { ...file },
          fileView: reconstructed,
          mountedRows: plannedRows(reconstructed).slice(0, 1),
          offloadLargeDiff: false,
          shouldLoadHighlight: true,
          theme: { ...theme, syntaxColors: { ...theme.syntaxColors } },
        },
        { load, maxRetries: 0 },
      );
      return null;
    }
    function Harness() {
      const [tick, setTick] = useState(0);
      bump = () => setTick((value) => value + 1);
      return (
        <StrictMode>
          <Source generation={tick + 1} />
        </StrictMode>
      );
    }

    const setup = await testRender(<Harness />, { width: 80, height: 8 });
    try {
      await flush(setup);
      const mountedCalls = calls;
      for (let update = 0; update < 10; update += 1) {
        await act(async () => bump());
        await flush(setup, 0);
      }
      expect(mountedCalls).toBeGreaterThan(0);
      expect(calls).toBe(mountedCalls);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("suppresses stale file, view, document, language, and theme work", async () => {
    const pending: Array<ReturnType<typeof deferred<DocumentHighlightResult>>> = [];
    const signals: AbortSignal[] = [];
    const load: DocumentLoader = (input) => {
      signals.push(input.signal!);
      const next = deferred<DocumentHighlightResult>();
      pending.push(next);
      return next.promise;
    };
    const firstView = resolveTestLayout([documents[0]!], [rows[0]!]);
    const nextDocument = {
      id: "old",
      text: "let changed = true;",
      language: "javascript",
    };
    const nextRow = {
      id: "changed",
      spans: [{ text: nextDocument.text, syntax: { documentId: "old", line: 1 } }],
    } satisfies ExtensionFileViewRow;
    const nextView = resolveTestLayout([nextDocument], [nextRow], {
      registration: 2,
      viewId: "other",
    });
    const harness = await renderHookHarness(
      {
        file,
        fileView: firstView,
        mountedRows: plannedRows(firstView),
        offloadLargeDiff: false,
        shouldLoadHighlight: true,
        theme,
      },
      load,
      { maxRetries: 0 },
    );

    try {
      const nextTheme = resolveTheme("github-light-default", null);
      await act(async () =>
        harness.setProps({
          file: {
            ...file,
            id: "other-file",
            path: "src/other.js",
            language: "javascript",
          },
          fileView: nextView,
          mountedRows: plannedRows(nextView),
          offloadLargeDiff: true,
          shouldLoadHighlight: true,
          theme: nextTheme,
        }),
      );
      await flush(harness.setup);
      expect(signals[0]?.aborted).toBe(true);
      expect(pending).toHaveLength(2);
      pending[0]!.resolve(fallback("unsupported-language"));
      await flush(harness.setup);
      expect(harness.current().size).toBe(0);
      pending[1]!.resolve(fallback("invalid-document"));
      await flush(harness.setup);
      expect(harness.current().get("old")?.status).toBe("fallback");
      expect(harness.current().get("old")).toMatchObject({
        reason: "invalid-document",
      });
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("threads host language, offload policy, and custom syntax theme inputs", async () => {
    const calls: DocumentHighlightInput[] = [];
    const customTheme: AppTheme = {
      ...theme,
      syntaxScopeOverrides: { keyword: "#abcdef" },
      syntaxTheme: "custom-test",
    };
    const fileView = resolveTestLayout([documents[1]!], [rows[2]!]);
    const load: DocumentLoader = async (input) => {
      calls.push(input);
      return fallback("invalid-document");
    };
    const harness = await renderHookHarness(
      {
        file,
        fileView,
        mountedRows: plannedRows(fileView),
        offloadLargeDiff: true,
        shouldLoadHighlight: true,
        theme: customTheme,
      },
      load,
    );

    try {
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        language: "typescript",
        offloadLargeDiff: true,
        path: "src/file.ts",
      });
      expect(calls[0]?.theme.syntaxScopeOverrides).toEqual({
        keyword: "#abcdef",
      });
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("retries retryable failures once and retains the permanent fallback", async () => {
    let calls = 0;
    const load: DocumentLoader = async () => {
      calls += 1;
      if (calls === 1) return fallback("highlight-failed", true);
      return fallback("invalid-document");
    };
    const fileView = resolveTestLayout([documents[0]!], [rows[0]!]);
    const harness = await renderHookHarness(
      {
        file,
        fileView,
        mountedRows: plannedRows(fileView),
        offloadLargeDiff: false,
        shouldLoadHighlight: true,
        theme,
      },
      load,
      { retryDelayMs: 0 },
    );

    await flush(harness.setup, 10);
    expect(calls).toBe(2);
    expect(harness.current().get("old")).toMatchObject({ retryable: false });
    await act(async () => harness.setup.renderer.destroy());
  });

  test("cancels a scheduled retry when demand disappears", async () => {
    let calls = 0;
    const fileView = resolveTestLayout([documents[0]!], [rows[0]!]);
    const harness = await renderHookHarness(
      {
        file,
        fileView,
        mountedRows: plannedRows(fileView),
        offloadLargeDiff: false,
        shouldLoadHighlight: true,
        theme,
      },
      async () => {
        calls += 1;
        return fallback("highlight-failed", true);
      },
      { retryDelayMs: 1_000 },
    );

    try {
      expect(calls).toBe(1);
      await act(async () =>
        harness.setProps({
          file,
          fileView,
          mountedRows: [],
          offloadLargeDiff: false,
          shouldLoadHighlight: true,
          theme,
        }),
      );
      await flush(harness.setup, 20);
      expect(calls).toBe(1);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("aborts pending subscriber work on demand removal and unmount", async () => {
    const calls: Array<{
      signal: AbortSignal;
      pending: ReturnType<typeof deferred<DocumentHighlightResult>>;
    }> = [];
    const fileView = resolveTestLayout([documents[0]!], [rows[0]!]);
    const load: DocumentLoader = (input) => {
      const pending = deferred<DocumentHighlightResult>();
      calls.push({ signal: input.signal!, pending });
      return pending.promise;
    };
    const harness = await renderHookHarness(
      {
        file,
        fileView,
        mountedRows: plannedRows(fileView),
        offloadLargeDiff: false,
        shouldLoadHighlight: true,
        theme,
      },
      load,
      { maxRetries: 0 },
    );

    await act(async () =>
      harness.setProps({
        file,
        fileView,
        mountedRows: [],
        offloadLargeDiff: false,
        shouldLoadHighlight: true,
        theme,
      }),
    );
    await flush(harness.setup);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(harness.current().size).toBe(0);

    await act(async () =>
      harness.setProps({
        file,
        fileView,
        mountedRows: plannedRows(fileView),
        offloadLargeDiff: false,
        shouldLoadHighlight: true,
        theme,
      }),
    );
    await flush(harness.setup);
    expect(calls).toHaveLength(2);
    await act(async () => harness.setup.renderer.destroy());
    expect(calls[1]?.signal.aborted).toBe(true);
  });

  test("keeps shared in-flight work alive when one hook subscriber unmounts", async () => {
    const underlying = deferred<ReturnType<typeof encodeCompactHighlightedDocument>>();
    let underlyingSignal: AbortSignal | undefined;
    let inlineCalls = 0;
    const service = createDocumentHighlightService({
      inlineHighlight: async ({ signal }) => {
        inlineCalls += 1;
        underlyingSignal = signal;
        return await underlying.promise;
      },
    });
    const fileView = resolveTestLayout([documents[0]!], [rows[0]!]);
    let hideFirst!: () => void;
    const seen: Array<ReadonlyMap<string, DocumentHighlightResult>> = [];

    function Subscriber() {
      seen.push(
        useFileViewSyntaxHighlight(
          {
            file,
            fileView,
            mountedRows: plannedRows(fileView),
            offloadLargeDiff: false,
            shouldLoadHighlight: true,
            theme,
          },
          { load: (input) => service.highlight(input), maxRetries: 0 },
        ),
      );
      return null;
    }
    function Harness() {
      const [firstVisible, setFirstVisible] = useState(true);
      hideFirst = () => setFirstVisible(false);
      return (
        <>
          {firstVisible ? <Subscriber /> : null}
          <Subscriber />
        </>
      );
    }

    const setup = await testRender(<Harness />, { width: 80, height: 8 });
    try {
      await flush(setup);
      expect(inlineCalls).toBe(1);
      await act(async () => hideFirst());
      await flush(setup);
      expect(underlyingSignal?.aborted).toBe(false);
      underlying.resolve(
        encodeCompactHighlightedDocument(
          [
            {
              type: "element",
              tagName: "span",
              properties: { style: "color: #ff0000" },
              children: [{ type: "text", value: documents[0]!.text }],
            },
          ],
          "dark",
        ),
      );
      await flush(setup);
      expect(seen.some((lookup) => lookup.get("old")?.status === "highlighted")).toBe(true);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
