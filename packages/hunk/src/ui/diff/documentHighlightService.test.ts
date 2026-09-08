import { describe, expect, test } from "bun:test";
import { THEMES, type AppTheme } from "../themes";
import {
  createDocumentHighlightService,
  documentHighlightCacheKey,
  DocumentHighlightAbortedError,
  type DocumentHighlightInput,
} from "./documentHighlightService";
import {
  compactHighlightedDocumentRunsForLine,
  HighlightWorkerClientError,
  type CompactHighlightedDocument,
  type DocumentWorkerEligibility,
} from "./worker";

const theme = THEMES.find((candidate) => candidate.id === "github-dark-default")!;
const base: Omit<DocumentHighlightInput, "signal"> = {
  text: "const answer = 42;",
  path: "example.ts",
  language: "typescript",
  theme,
  offloadLargeDiff: false,
};

/** Build one valid compact document with configurable retained bytes. */
function compact(lineLength = 1, color = "#112233"): CompactHighlightedDocument {
  return {
    version: 1,
    foregroundPalette: [color],
    document: {
      lineOffsets: Uint32Array.from([0, 1]),
      starts: Uint32Array.from([0]),
      ends: Uint32Array.from([lineLength]),
      styleIds: Uint16Array.from([1]),
      flags: Uint8Array.from([0]),
    },
  };
}

/** Mark every test document as worker-eligible without consulting the host runtime. */
function eligible(input: {
  language: string;
  path: string;
  text: string;
  theme: AppTheme;
}): DocumentWorkerEligibility {
  return {
    eligible: true,
    input: {
      appearance: input.theme.appearance,
      language: input.language,
      path: input.path,
      text: input.text,
      theme: input.theme.syntaxTheme ?? input.theme.id,
    },
  };
}

describe("document highlight service", () => {
  test("keeps complete-document lexical state for identical lines", async () => {
    const service = createDocumentHighlightService();
    const commentText = "/* open\nconst answer = 42;\n*/";
    const codeText = "const other = 1;\nconst answer = 42;\n";

    const [comment, code] = await Promise.all([
      service.highlight({ ...base, text: commentText }),
      service.highlight({ ...base, text: codeText }),
    ]);
    expect(comment.status).toBe("highlighted");
    expect(code.status).toBe("highlighted");
    if (comment.status !== "highlighted" || code.status !== "highlighted") return;

    const commentColors = compactHighlightedDocumentRunsForLine(comment.compact, 1).map(
      (run) => run.fg,
    );
    const codeColors = compactHighlightedDocumentRunsForLine(code.compact, 1).map((run) => run.fg);
    expect(commentColors).not.toEqual(codeColors);
  });

  test("strong keys change for every render-affecting input", () => {
    const key = documentHighlightCacheKey(base);
    expect(documentHighlightCacheKey({ ...base, text: "const answer = 43;" })).not.toBe(key);
    expect(documentHighlightCacheKey({ ...base, path: "other.ts" })).not.toBe(key);
    expect(documentHighlightCacheKey({ ...base, language: "javascript" })).not.toBe(key);
    expect(
      documentHighlightCacheKey({
        ...base,
        theme: { ...theme, appearance: "light" },
      }),
    ).not.toBe(key);
    expect(
      documentHighlightCacheKey({
        ...base,
        theme: { ...theme, syntaxScopeOverrides: { keyword: "#112233" } },
      }),
    ).not.toBe(key);
  });

  test("single-flights identical requests and reuses the completed result after remount", async () => {
    let calls = 0;
    let release!: (value: CompactHighlightedDocument) => void;
    const pending = new Promise<CompactHighlightedDocument>((resolve) => {
      release = resolve;
    });
    const service = createDocumentHighlightService({
      inlineHighlight: async () => {
        calls += 1;
        return pending;
      },
    });

    const first = service.highlight(base);
    const second = service.highlight(base);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(service.stats().inFlight).toBe(1);
    release(compact(base.text.length));
    await Promise.all([first, second]);
    await service.highlight(base);
    expect(calls).toBe(1);
    expect(service.stats()).toMatchObject({ completedEntries: 1, inFlight: 0 });
  });

  test("keeps shared work alive when one subscriber aborts", async () => {
    let release!: (value: CompactHighlightedDocument) => void;
    const pending = new Promise<CompactHighlightedDocument>((resolve) => {
      release = resolve;
    });
    const service = createDocumentHighlightService({
      inlineHighlight: async () => pending,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = service.highlight({
      ...base,
      signal: firstController.signal,
    });
    const second = service.highlight({
      ...base,
      signal: secondController.signal,
    });

    firstController.abort();
    await expect(first).rejects.toBeInstanceOf(DocumentHighlightAbortedError);
    expect(service.stats().inFlight).toBe(1);
    release(compact(base.text.length));
    expect((await second).status).toBe("highlighted");
  });

  test("cancels underlying work when every subscriber aborts", async () => {
    let underlyingAborted = false;
    const service = createDocumentHighlightService({
      inlineHighlight: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              underlyingAborted = true;
              reject(new DocumentHighlightAbortedError());
            },
            { once: true },
          );
        }),
    });
    const one = new AbortController();
    const two = new AbortController();
    const first = service.highlight({ ...base, signal: one.signal });
    const second = service.highlight({ ...base, signal: two.signal });
    await Promise.resolve();
    one.abort();
    two.abort();

    await expect(first).rejects.toBeInstanceOf(DocumentHighlightAbortedError);
    await expect(second).rejects.toBeInstanceOf(DocumentHighlightAbortedError);
    expect(underlyingAborted).toBe(true);
    expect(service.stats()).toMatchObject({ completedEntries: 0, inFlight: 0 });
  });

  test("obeys offload policy and centralized eligibility", async () => {
    let workerCalls = 0;
    let inlineCalls = 0;
    const service = createDocumentHighlightService({
      workerEligibility: eligible,
      workerHighlight: async () => {
        workerCalls += 1;
        return compact(base.text.length);
      },
      inlineHighlight: async () => {
        inlineCalls += 1;
        return compact(base.text.length);
      },
    });

    await service.highlight({
      ...base,
      path: "inline.ts",
      offloadLargeDiff: false,
    });
    await service.highlight({
      ...base,
      path: "worker.ts",
      offloadLargeDiff: true,
    });
    expect({ inlineCalls, workerCalls }).toEqual({
      inlineCalls: 1,
      workerCalls: 1,
    });
  });

  test("keeps custom scope themes inline with the same colors", async () => {
    const customTheme = {
      ...theme,
      syntaxScopeOverrides: { keyword: "#112233" },
    };
    let workerCalls = 0;
    const offloadedService = createDocumentHighlightService({
      workerHighlight: async () => {
        workerCalls += 1;
        return compact(base.text.length);
      },
    });
    const inlineService = createDocumentHighlightService();
    const [requestedOffload, inline] = await Promise.all([
      offloadedService.highlight({
        ...base,
        theme: customTheme,
        offloadLargeDiff: true,
      }),
      inlineService.highlight({
        ...base,
        theme: customTheme,
        offloadLargeDiff: false,
      }),
    ]);

    expect(workerCalls).toBe(0);
    expect(requestedOffload).toEqual(inline);
  });

  test("caches permanent fallback but retries transient worker failure", async () => {
    let permanentCalls = 0;
    const permanent = createDocumentHighlightService({
      workerEligibility: eligible,
      workerHighlight: async () => {
        permanentCalls += 1;
        throw new HighlightWorkerClientError("unsupported-language", false, "unsupported");
      },
    });
    const permanentInput = { ...base, offloadLargeDiff: true };
    expect(await permanent.highlight(permanentInput)).toMatchObject({
      status: "fallback",
      retryable: false,
      reason: "unsupported-language",
    });
    await permanent.highlight(permanentInput);
    expect(permanentCalls).toBe(1);

    let retryableCalls = 0;
    const retryable = createDocumentHighlightService({
      workerEligibility: eligible,
      workerHighlight: async () => {
        retryableCalls += 1;
        throw new HighlightWorkerClientError("worker-failed", true, "retry");
      },
    });
    expect(await retryable.highlight(permanentInput)).toMatchObject({
      status: "fallback",
      retryable: true,
    });
    await retryable.highlight(permanentInput);
    expect(retryableCalls).toBe(2);
  });

  test("returns plain permanent fallback for unknown and unbounded documents", async () => {
    const service = createDocumentHighlightService();
    expect(await service.highlight({ ...base, language: "not-a-real-grammar" })).toMatchObject({
      status: "fallback",
      retryable: false,
    });
    expect(await service.highlight({ ...base, text: "x".repeat(1_000) })).toMatchObject({
      status: "fallback",
      reason: "invalid-document",
      retryable: false,
    });
    expect(await service.highlight({ ...base, text: "x".repeat(1_000_001) })).toMatchObject({
      status: "fallback",
      reason: "invalid-document",
      retryable: false,
    });
  });

  test("bounds completed results by entry count and retained bytes", async () => {
    let calls = 0;
    const entryBound = createDocumentHighlightService({
      maxCacheEntries: 1,
      workerEligibility: eligible,
      workerHighlight: async () => {
        calls += 1;
        throw new HighlightWorkerClientError("unsupported-language", false, "unsupported");
      },
    });
    const workerBase = { ...base, offloadLargeDiff: true };
    await entryBound.highlight({ ...workerBase, path: "one.ts" });
    await entryBound.highlight({ ...workerBase, path: "two.ts" });
    await entryBound.highlight({ ...workerBase, path: "one.ts" });
    expect(calls).toBe(3);
    expect(entryBound.stats().completedEntries).toBe(1);

    let byteCalls = 0;
    const byteBound = createDocumentHighlightService({
      maxCacheBytes: 600,
      maxCacheEntries: 10,
      inlineHighlight: async () => {
        byteCalls += 1;
        return compact(base.text.length);
      },
    });
    await byteBound.highlight({ ...base, path: "one.ts" });
    await byteBound.highlight({ ...base, path: "two.ts" });
    await byteBound.highlight({ ...base, path: "one.ts" });
    await byteBound.highlight({ ...base, path: "three.ts" });
    await byteBound.highlight({ ...base, path: "one.ts" });
    await byteBound.highlight({ ...base, path: "two.ts" });
    expect(byteCalls).toBe(4);
    expect(byteBound.stats().completedEntries).toBe(2);
  });

  test("never exposes or retains a caller-detached cache buffer", async () => {
    let calls = 0;
    const service = createDocumentHighlightService({
      inlineHighlight: async () => {
        calls += 1;
        return compact(base.text.length);
      },
    });
    const first = await service.highlight(base);
    expect(first.status).toBe("highlighted");
    if (first.status !== "highlighted") return;

    const buffer = first.compact.document.starts.buffer;
    structuredClone(first.compact, { transfer: [buffer] });
    expect(buffer.byteLength).toBe(0);

    const cached = await service.highlight(base);
    expect(cached.status).toBe("highlighted");
    if (cached.status !== "highlighted") return;
    expect(cached.compact.document.starts.buffer.byteLength).toBeGreaterThan(0);
    expect(calls).toBe(1);
  });
});
