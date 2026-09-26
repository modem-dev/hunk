import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, StrictMode, useState } from "react";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { createTestCustomThemes } from "../../../../../test/helpers/theme-helpers";
import type { DiffFile } from "../../core/changeset/model";
import { resolveTheme, type AppTheme } from "../themes";
import { loadHighlightedSourceLines, spansForHighlightedSourceLine } from "./diffRows";
import {
  createDocumentHighlightService,
  type DocumentHighlightResult,
} from "./documentHighlightService";
import { encodeCompactHighlightedDocument, registerHighlightWorker, type HastNode } from "./worker";
import { useHighlightedSource } from "./useHighlightedSource";

interface HookProps {
  file: DiffFile | undefined;
  offloadLargeDiff?: boolean;
  shouldLoadHighlight?: boolean;
  text: string | undefined;
  theme: AppTheme;
}

type SourceLoader = typeof loadHighlightedSourceLines;

/** Build one immutable plain result with controllable retry behavior. */
function fallback(reason: "invalid-document" | "highlight-failed", retryable: boolean) {
  return Object.freeze({
    status: "fallback",
    reason,
    retryable,
  }) satisfies DocumentHighlightResult;
}

/** Render the hook with mutable props and an injectable loader. */
async function renderHookHarness(
  initial: HookProps,
  load: SourceLoader = loadHighlightedSourceLines,
  options: { maxRetries?: number; retryDelayMs?: number } = {},
) {
  let current: DocumentHighlightResult | null = null;
  let setProps!: (props: HookProps) => void;

  function Harness() {
    const [props, updateProps] = useState(initial);
    setProps = updateProps;
    current = useHighlightedSource(props, { load, ...options });
    return null;
  }

  const setup = await testRender(<Harness />, { width: 80, height: 8 });
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(5);
  });
  return { current: () => current, setProps, setup };
}

/** Let hook effects and short retry timers settle deterministically. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>, delay = 5) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(delay);
  });
}

/** Return a promise plus its external settlement controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

/** Adapt one isolated service into the source loader used by the hook. */
function serviceLoader(service: ReturnType<typeof createDocumentHighlightService>): SourceLoader {
  return async ({ file, offloadLargeDiff = false, signal, text, theme }) =>
    await service.highlight({
      language: file.language ?? "text",
      offloadLargeDiff,
      path: file.path,
      signal,
      text,
      theme,
    });
}

describe("useHighlightedSource", () => {
  const file = createTestDiffFile({ id: "source", path: "source.ts" });
  const theme = resolveTheme("github-dark-default", null);

  test("does not restart work when StrictMode parents recreate equivalent props", async () => {
    let calls = 0;
    let renders = 0;
    let bump!: () => void;
    const load: SourceLoader = async () => {
      calls += 1;
      await Bun.sleep(1);
      return fallback("invalid-document", false);
    };

    function Source() {
      renders += 1;
      useHighlightedSource(
        {
          file: { ...file },
          shouldLoadHighlight: true,
          text: "const value = 1;\n",
          theme: { ...theme, syntaxColors: { ...theme.syntaxColors } },
        },
        { load, maxRetries: 0 },
      );
      return null;
    }
    function Harness() {
      const [, setTick] = useState(0);
      bump = () => setTick((value) => value + 1);
      return (
        <StrictMode>
          <Source />
        </StrictMode>
      );
    }

    const setup = await testRender(<Harness />, { width: 80, height: 8 });
    try {
      await flush(setup);
      const callsAfterMount = calls;
      for (let update = 0; update < 20; update += 1) {
        await act(async () => bump());
        await flush(setup, 0);
      }
      expect(renders).toBeGreaterThanOrEqual(22);
      expect(callsAfterMount).toBeGreaterThan(0);
      expect(calls).toBe(callsAfterMount);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("threads offload policy and aborts work when demand is disabled", async () => {
    const calls: Array<{ offloadLargeDiff?: boolean; signal?: AbortSignal }> = [];
    const pending = deferred<DocumentHighlightResult>();
    const load: SourceLoader = (input) => {
      calls.push(input);
      return pending.promise;
    };
    const harness = await renderHookHarness(
      {
        file,
        offloadLargeDiff: true,
        shouldLoadHighlight: true,
        text: "const value = 1;\n",
        theme,
      },
      load,
    );

    try {
      await flush(harness.setup);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.offloadLargeDiff).toBe(true);
      expect(calls[0]?.signal?.aborted).toBe(false);

      await act(async () =>
        harness.setProps({
          file,
          offloadLargeDiff: true,
          shouldLoadHighlight: false,
          text: "const value = 1;\n",
          theme,
        }),
      );
      expect(calls[0]?.signal?.aborted).toBe(true);
      expect(harness.current()).toBeNull();
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("shows retryable fallback and recovers after one bounded retry", async () => {
    let calls = 0;
    const load: SourceLoader = async () => {
      calls += 1;
      await Bun.sleep(1);
      return calls === 1 ? fallback("highlight-failed", true) : fallback("invalid-document", false);
    };
    const harness = await renderHookHarness(
      { file, shouldLoadHighlight: true, text: "const value = 1;\n", theme },
      load,
      { retryDelayMs: 0 },
    );

    try {
      await flush(harness.setup, 10);
      expect(calls).toBe(2);
      expect(harness.current()).toMatchObject({
        status: "fallback",
        reason: "invalid-document",
        retryable: false,
      });
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("stops after the configured retry budget", async () => {
    let calls = 0;
    const load: SourceLoader = async () => {
      calls += 1;
      await Bun.sleep(1);
      return fallback("highlight-failed", true);
    };
    const harness = await renderHookHarness(
      { file, shouldLoadHighlight: true, text: "const value = 1;\n", theme },
      load,
      { maxRetries: 1, retryDelayMs: 0 },
    );

    try {
      await flush(harness.setup, 15);
      expect(calls).toBe(2);
      await flush(harness.setup, 15);
      expect(calls).toBe(2);
      expect(harness.current()?.retryable).toBe(true);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("suppresses stale identity results during rapid file and theme changes", async () => {
    const pending: Array<ReturnType<typeof deferred<DocumentHighlightResult>>> = [];
    const signals: AbortSignal[] = [];
    const load: SourceLoader = ({ signal }) => {
      signals.push(signal!);
      const next = deferred<DocumentHighlightResult>();
      pending.push(next);
      return next.promise;
    };
    const nextTheme = resolveTheme("github-light-default", null);
    const harness = await renderHookHarness(
      { file, shouldLoadHighlight: true, text: "const first = 1;\n", theme },
      load,
      { maxRetries: 0 },
    );

    try {
      await flush(harness.setup);
      await act(async () =>
        harness.setProps({
          file: { ...file, path: "next.ts" },
          shouldLoadHighlight: true,
          text: "const second = 2;\n",
          theme: nextTheme,
        }),
      );
      await flush(harness.setup);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);

      pending[1]!.resolve(fallback("invalid-document", false));
      await flush(harness.setup);
      pending[0]!.resolve(fallback("highlight-failed", true));
      await flush(harness.setup);
      expect(harness.current()).toMatchObject({
        reason: "invalid-document",
      });
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("aborts on unmount and does not commit a later completion", async () => {
    const pending = deferred<DocumentHighlightResult>();
    let signal: AbortSignal | undefined;
    const load: SourceLoader = (input) => {
      signal = input.signal;
      return pending.promise;
    };
    const harness = await renderHookHarness(
      { file, shouldLoadHighlight: true, text: "const value = 1;\n", theme },
      load,
    );

    await flush(harness.setup);
    await act(async () => harness.setup.renderer.destroy());
    expect(signal?.aborted).toBe(true);
    pending.resolve(fallback("invalid-document", false));
    await Bun.sleep(5);
    expect(signal?.aborted).toBe(true);
  });

  test("remounts with fresh work while suppressing an aborted in-flight completion", async () => {
    const requests: Array<ReturnType<typeof deferred<DocumentHighlightResult>>> = [];
    const signals: AbortSignal[] = [];
    const load: SourceLoader = ({ signal }) => {
      signals.push(signal!);
      const request = deferred<DocumentHighlightResult>();
      requests.push(request);
      return request.promise;
    };
    const props = {
      file,
      shouldLoadHighlight: true,
      text: "const value = 1;\n",
      theme,
    };
    const first = await renderHookHarness(props, load, { maxRetries: 0 });
    await flush(first.setup);
    await act(async () => first.setup.renderer.destroy());
    expect(signals[0]?.aborted).toBe(true);

    const second = await renderHookHarness(props, load, { maxRetries: 0 });
    try {
      await flush(second.setup);
      expect(requests).toHaveLength(2);
      requests[0]!.resolve(fallback("highlight-failed", true));
      await flush(second.setup);
      expect(second.current()).toBeNull();

      requests[1]!.resolve(fallback("invalid-document", false));
      await flush(second.setup);
      expect(second.current()).toMatchObject({
        reason: "invalid-document",
        retryable: false,
      });
    } finally {
      await act(async () => second.setup.renderer.destroy());
    }
  });

  test("cancels a pending retry timer when the hook unmounts", async () => {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const load: SourceLoader = async (input) => {
      calls += 1;
      signal = input.signal;
      await Bun.sleep(1);
      return fallback("highlight-failed", true);
    };
    const harness = await renderHookHarness(
      { file, shouldLoadHighlight: true, text: "const value = 1;\n", theme },
      load,
      { maxRetries: 1, retryDelayMs: 50 },
    );

    await flush(harness.setup);
    expect(calls).toBe(1);
    await act(async () => harness.setup.renderer.destroy());
    expect(signal?.aborted).toBe(true);
    await Bun.sleep(70);
    expect(calls).toBe(1);
  });

  test("keeps shared service work alive when one hook subscriber unmounts", async () => {
    const underlying = deferred<ReturnType<typeof encodeCompactHighlightedDocument>>();
    let underlyingSignal: AbortSignal | undefined;
    let inlineCalls = 0;
    const service = createDocumentHighlightService({
      inlineHighlight: ({ signal }) => {
        inlineCalls += 1;
        underlyingSignal = signal;
        return underlying.promise;
      },
    });
    const load = serviceLoader(service);
    let hideFirst!: () => void;
    let second: DocumentHighlightResult | null = null;

    function Subscriber({ capture }: { capture?: boolean }) {
      const value = useHighlightedSource(
        { file, shouldLoadHighlight: true, text: "const value = 1;", theme },
        { load, maxRetries: 0 },
      );
      if (capture) second = value;
      return null;
    }
    function Harness() {
      const [firstVisible, setFirstVisible] = useState(true);
      hideFirst = () => setFirstVisible(false);
      return (
        <>
          {firstVisible ? <Subscriber /> : null}
          <Subscriber capture />
        </>
      );
    }

    const setup = await testRender(<Harness />, { width: 80, height: 8 });
    try {
      await flush(setup);
      expect(inlineCalls).toBe(1);
      await act(async () => hideFirst());
      expect(underlyingSignal?.aborted).toBe(false);

      const line: HastNode = {
        type: "element",
        tagName: "span",
        properties: { style: "color:#112233" },
        children: [{ type: "text", value: "const value = 1;" }],
      };
      underlying.resolve(encodeCompactHighlightedDocument([line], "dark"));
      await flush(setup);
      expect((second as DocumentHighlightResult | null)?.status).toBe("highlighted");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("reuses a completed service result after unmount and remount", async () => {
    let inlineCalls = 0;
    const service = createDocumentHighlightService({
      inlineHighlight: async ({ text }) => {
        inlineCalls += 1;
        return encodeCompactHighlightedDocument([{ type: "text", value: text }], "dark");
      },
    });
    const load = serviceLoader(service);
    const props = {
      file,
      shouldLoadHighlight: true,
      text: "const value = 1;",
      theme,
    };
    const first = await renderHookHarness(props, load, { maxRetries: 0 });
    await flush(first.setup);
    expect(first.current()?.status).toBe("highlighted");
    await act(async () => first.setup.renderer.destroy());

    const second = await renderHookHarness(props, load, { maxRetries: 0 });
    try {
      await flush(second.setup);
      expect(second.current()?.status).toBe("highlighted");
      expect(inlineCalls).toBe(1);
    } finally {
      await act(async () => second.setup.renderer.destroy());
    }
  });

  test("uses the registered document worker when fast offload is enabled", async () => {
    let workerCalls = 0;
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage(request: { id: number; kind: string; text: string }) {
        workerCalls += 1;
        const lines = request.text.split("\n").map((value): HastNode => ({ type: "text", value }));
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              version: 4,
              id: request.id,
              kind: "document",
              ok: true,
              code: encodeCompactHighlightedDocument(lines, "dark"),
            },
          } as MessageEvent),
        );
      },
      terminate() {
        return Promise.resolve(0);
      },
      unref() {},
    };
    registerHighlightWorker(worker as unknown as Worker);
    const workerText = Array.from(
      { length: 40 },
      (_, index) => `const workerValue${index} = ${index};`,
    ).join("\n");
    const harness = await renderHookHarness({
      file: { ...file, path: "worker-source.ts" },
      offloadLargeDiff: true,
      shouldLoadHighlight: true,
      text: workerText,
      theme,
    });

    try {
      for (let attempt = 0; attempt < 20 && !harness.current(); attempt += 1) {
        await flush(harness.setup, 5);
      }
      expect(harness.current()?.status).toBe("highlighted");
      expect(workerCalls).toBe(1);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("keeps small bundled-theme documents inline under fast mode", async () => {
    let workerCalls = 0;
    registerHighlightWorker({
      onmessage: null,
      onerror: null,
      postMessage() {
        workerCalls += 1;
      },
      terminate() {
        return Promise.resolve(0);
      },
      unref() {},
    } as unknown as Worker);
    const harness = await renderHookHarness({
      file: { ...file, path: "small-worker-source.ts" },
      offloadLargeDiff: true,
      shouldLoadHighlight: true,
      text: "const smallValue = 1;",
      theme,
    });

    try {
      for (let attempt = 0; attempt < 20 && !harness.current(); attempt += 1) {
        await flush(harness.setup, 5);
      }
      expect(harness.current()?.status).toBe("highlighted");
      expect(workerCalls).toBe(0);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("renders a custom syntax scope through the inline hook path", async () => {
    let workerCalls = 0;
    registerHighlightWorker({
      onmessage: null,
      onerror: null,
      postMessage() {
        workerCalls += 1;
      },
      terminate() {
        return Promise.resolve(0);
      },
      unref() {},
    } as unknown as Worker);
    const customTheme = resolveTheme(
      "custom",
      null,
      createTestCustomThemes({
        base: "nord",
        syntaxScopes: {
          "comment.line.double-slash.ts": "#abcdef",
          "punctuation.definition.comment.ts": "#abcdef",
        },
      }),
    );
    const line = "// expanded comment";
    const harness = await renderHookHarness({
      file,
      offloadLargeDiff: true,
      shouldLoadHighlight: true,
      text: `${line}\n`,
      theme: customTheme,
    });

    try {
      for (let attempt = 0; attempt < 20 && !harness.current(); attempt += 1) {
        await flush(harness.setup, 5);
      }
      const highlighted = harness.current();
      expect(highlighted?.status).toBe("highlighted");
      expect(spansForHighlightedSourceLine(line, highlighted)[0]?.fg).toBe("#ABCDEF");
      expect(workerCalls).toBe(0);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });
});
