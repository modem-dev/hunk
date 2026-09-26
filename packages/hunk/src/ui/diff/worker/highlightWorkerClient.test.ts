import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createTestDiffFile } from "../../../../../../test/helpers/diff-helpers";
import { supportsHighlightWorkerOffload } from "../../../highlightWorkerClient";
import type { CompactHighlightedDiff, CompactHighlightedDocument } from "./highlightCompact";
import {
  disposeHighlightWorker,
  HighlightWorkerClientError,
  highlightDiffInWorker,
  highlightDocumentInWorker,
  registerHighlightWorker,
} from "./highlightWorkerClient";
import {
  highlightWorkerDocumentLineLengths,
  HIGHLIGHT_WORKER_PROTOCOL_VERSION,
  type HighlightWorkerRequest,
} from "./highlightWorkerProtocol";

/** Build the smallest valid compact diff worker response. */
function emptyCompactDiffResponse(): CompactHighlightedDiff {
  const side = () => ({
    lineOffsets: Uint32Array.of(0),
    starts: new Uint32Array(),
    ends: new Uint32Array(),
    styleIds: new Uint16Array(),
    flags: new Uint8Array(),
  });

  return {
    version: 1,
    foregroundPalette: [],
    deletion: side(),
    addition: side(),
  };
}

/** Build one plain compact document response matching exact request geometry. */
function compactDocumentResponseForText(text: string): CompactHighlightedDocument {
  const lineLengths = highlightWorkerDocumentLineLengths(text);
  return {
    version: 1,
    foregroundPalette: [],
    document: {
      lineOffsets: Uint32Array.from({ length: lineLengths.length + 1 }, (_, index) => index),
      starts: Uint32Array.from({ length: lineLengths.length }, () => 0),
      ends: Uint32Array.from(lineLengths),
      styleIds: new Uint16Array(lineLengths.length),
      flags: new Uint8Array(lineLengths.length),
    },
  };
}

/** Build the smallest zero-line compact document response. */
function emptyCompactDocumentResponse(): CompactHighlightedDocument {
  return compactDocumentResponseForText("");
}

/** Build a controllable Worker double for queue, protocol, and lifecycle tests. */
function createTestHighlightWorker({ throwOnPost }: { throwOnPost?: Error } = {}) {
  const state = {
    messages: [] as HighlightWorkerRequest[],
    terminateCalls: 0,
    unrefCalls: 0,
  };
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage(message: HighlightWorkerRequest) {
      if (throwOnPost) {
        throw throwOnPost;
      }
      state.messages.push(message);
    },
    terminate() {
      state.terminateCalls += 1;
      return Promise.resolve(0);
    },
    unref() {
      state.unrefCalls += 1;
    },
  };

  return {
    state,
    worker: worker as unknown as Worker,
    reply(data: unknown) {
      worker.onmessage?.({ data } as MessageEvent);
    },
    fail(message: string) {
      worker.onerror?.({ message } as ErrorEvent);
    },
  };
}

/** Queue one representative diff request through the worker client. */
function requestDiff(aliasContext = false) {
  return highlightDiffInWorker({
    aliasContext,
    appearance: "dark",
    language: "typescript",
    metadata: createTestDiffFile().metadata,
    theme: "github-dark-default",
  });
}

/** Queue one representative complete-document request through the worker client. */
function requestDocument({
  signal,
  text = "const answer = 42;\n",
}: { signal?: AbortSignal; text?: string } = {}) {
  return highlightDocumentInWorker({
    appearance: "dark",
    language: "typescript",
    path: "example.ts",
    signal,
    text,
    theme: "github-dark-default",
  });
}

afterEach(() => {
  disposeHighlightWorker();
});

describe("highlight worker client", () => {
  test("disables offload only for Bun-compiled Windows entrypoints", () => {
    expect(
      supportsHighlightWorkerOffload({
        platform: "win32",
        execPath: "C:\\Program Files\\Hunk\\hunk.exe",
      }),
    ).toBe(false);
    expect(
      supportsHighlightWorkerOffload({
        platform: "win32",
        execPath: "C:\\Users\\dev\\.bun\\bin\\bun.exe",
      }),
    ).toBe(true);
    expect(
      supportsHighlightWorkerOffload({
        platform: "linux",
        execPath: "/opt/hunk/bin/hunk",
      }),
    ).toBe(true);
  });

  test("serializes diff and document requests while ignoring stale IDs", async () => {
    const control = createTestHighlightWorker();
    registerHighlightWorker(control.worker);

    const first = requestDiff(true);
    const second = requestDocument();
    expect(control.state.unrefCalls).toBe(1);
    expect(control.state.messages).toHaveLength(1);
    expect(control.state.messages[0]).toMatchObject({
      kind: "diff",
      aliasContext: true,
    });

    control.reply({
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id: 999_999,
      kind: "diff",
      ok: true,
      code: emptyCompactDiffResponse(),
    });
    await Promise.resolve();
    expect(control.state.messages).toHaveLength(1);

    control.reply({
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id: control.state.messages[0]?.id,
      kind: "diff",
      ok: true,
      code: emptyCompactDiffResponse(),
    });
    await expect(first).resolves.toEqual(emptyCompactDiffResponse());
    expect(control.state.messages).toHaveLength(2);
    expect(control.state.messages[1]).toMatchObject({
      kind: "document",
      path: "example.ts",
      text: "const answer = 42;\n",
    });

    control.reply({
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id: control.state.messages[1]?.id,
      kind: "document",
      ok: true,
      code: compactDocumentResponseForText("const answer = 42;\n"),
    });
    await expect(second).resolves.toEqual(compactDocumentResponseForText("const answer = 42;\n"));
  });

  test("rejects matching replies with a wrong version, kind, or malformed payload", async () => {
    for (const reply of [
      (request: HighlightWorkerRequest) => ({
        version: 3,
        id: request.id,
        kind: request.kind,
        ok: true,
        code: emptyCompactDiffResponse(),
      }),
      (request: HighlightWorkerRequest) => ({
        version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
        id: request.id,
        kind: "document",
        ok: true,
        code: emptyCompactDocumentResponse(),
      }),
      (request: HighlightWorkerRequest) => ({
        version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
        id: request.id,
        kind: "diff",
        ok: true,
        code: { version: 1, foregroundPalette: [] },
      }),
      (request: HighlightWorkerRequest) => ({
        version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
        id: request.id,
        kind: "diff",
        ok: false,
        code: "unsupported-language",
        retryable: true,
        message: "inconsistent retry policy",
      }),
    ]) {
      const control = createTestHighlightWorker();
      registerHighlightWorker(control.worker);
      const pending = requestDiff();
      control.reply(reply(control.state.messages[0]!));
      await expect(pending).rejects.toThrow(/mismatch|typed arrays|malformed/);
      expect(control.state.terminateCalls).toBe(1);
    }
  });

  test("rejects document replies that do not match exact request geometry", async () => {
    for (const code of [
      emptyCompactDocumentResponse(),
      {
        ...compactDocumentResponseForText("const answer = 42;\n"),
        document: {
          ...compactDocumentResponseForText("const answer = 42;\n").document,
          ends: Uint32Array.of(16),
        },
      },
    ]) {
      const control = createTestHighlightWorker();
      registerHighlightWorker(control.worker);
      const pending = requestDocument();
      control.reply({
        version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
        id: control.state.messages[0]?.id,
        kind: "document",
        ok: true,
        code,
      });
      await expect(pending).rejects.toThrow(/line count|cover/);
      expect(control.state.terminateCalls).toBe(1);
    }
  });

  test("propagates typed worker failures and runtime crashes", async () => {
    const rejected = createTestHighlightWorker();
    registerHighlightWorker(rejected.worker);
    const pending = requestDocument();
    const request = rejected.state.messages[0]!;
    rejected.reply({
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id: request.id,
      kind: "document",
      ok: false,
      code: "unsupported-language",
      retryable: false,
      message: "highlight rejected",
    });
    const rejectedError = await pending.catch((error: unknown) => error);
    expect(rejectedError).toBeInstanceOf(HighlightWorkerClientError);
    expect(rejectedError).toMatchObject({
      code: "unsupported-language",
      retryable: false,
      message: "highlight rejected",
    });

    const crashed = createTestHighlightWorker();
    registerHighlightWorker(crashed.worker);
    const active = requestDiff();
    const queued = requestDocument();
    crashed.fail("worker crashed");
    const [activeError, queuedError] = await Promise.all([
      active.catch((error: unknown) => error),
      queued.catch((error: unknown) => error),
    ]);
    expect(activeError).toMatchObject({ code: "worker-failed", retryable: true });
    expect(queuedError).toMatchObject({ code: "worker-failed", retryable: true });
  });

  test("rejects active and queued work when a replacement worker takes over", async () => {
    const first = createTestHighlightWorker();
    const replacement = createTestHighlightWorker();
    registerHighlightWorker(first.worker);

    const active = requestDiff();
    const queued = requestDocument();
    registerHighlightWorker(replacement.worker);

    await expect(active).rejects.toThrow("replaced");
    await expect(queued).rejects.toThrow("replaced");
    expect(first.state.terminateCalls).toBe(1);
    expect(replacement.state.unrefCalls).toBe(1);
  });

  test("ignores late events from a terminated worker generation", async () => {
    const first = createTestHighlightWorker();
    const replacement = createTestHighlightWorker();
    registerHighlightWorker(first.worker);
    const lateError = first.worker.onerror;
    const lateMessage = first.worker.onmessage;
    registerHighlightWorker(replacement.worker);

    const pending = requestDiff();
    lateError?.call(first.worker, {
      message: "late old failure",
    } as ErrorEvent);
    lateMessage?.call(first.worker, {
      data: { id: replacement.state.messages[0]?.id },
    } as MessageEvent);
    expect(replacement.state.terminateCalls).toBe(0);

    replacement.reply({
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id: replacement.state.messages[0]?.id,
      kind: "diff",
      ok: true,
      code: emptyCompactDiffResponse(),
    });
    await expect(pending).resolves.toEqual(emptyCompactDiffResponse());
  });

  test("fails all work when posting throws and permits a later worker", async () => {
    const broken = createTestHighlightWorker({
      throwOnPost: new Error("post failed"),
    });
    registerHighlightWorker(broken.worker);

    await expect(requestDiff()).rejects.toThrow("post failed");
    expect(broken.state.terminateCalls).toBe(1);

    const recovered = createTestHighlightWorker();
    registerHighlightWorker(recovered.worker);
    const pending = requestDiff();
    const request = recovered.state.messages[0]!;
    recovered.reply({
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id: request.id,
      kind: "diff",
      ok: true,
      code: emptyCompactDiffResponse(),
    });
    await expect(pending).resolves.toEqual(emptyCompactDiffResponse());
  });

  test("rejects unbounded, non-normalized, or tokenizer-skipped documents before queueing", async () => {
    const control = createTestHighlightWorker();
    registerHighlightWorker(control.worker);
    const base = {
      appearance: "dark" as const,
      language: "typescript",
      path: "example.ts",
      theme: "pierre-dark",
    };

    await expect(
      highlightDocumentInWorker({ ...base, text: "line one\r\nline two" }),
    ).rejects.toThrow("normalized LF");
    await expect(
      highlightDocumentInWorker({
        ...base,
        text: `${"/*".padEnd(1_000, "x")}\nconst live = true;`,
      }),
    ).rejects.toThrow("shorter than 1000");
    expect(control.state.messages).toHaveLength(0);
  });

  test("removes aborted queued document jobs without disturbing queue order", async () => {
    const control = createTestHighlightWorker();
    registerHighlightWorker(control.worker);
    const active = requestDiff();
    const cancelledController = new AbortController();
    const cancelled = requestDocument({
      signal: cancelledController.signal,
      text: "const cancelled = true;\n",
    });
    const following = requestDocument({ text: "const following = true;\n" });

    cancelledController.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "aborted", retryable: false });
    expect(control.state.messages).toHaveLength(1);

    control.reply({
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id: control.state.messages[0]!.id,
      kind: "diff",
      ok: true,
      code: emptyCompactDiffResponse(),
    });
    await expect(active).resolves.toEqual(emptyCompactDiffResponse());
    expect(control.state.messages).toHaveLength(2);
    expect(control.state.messages[1]).toMatchObject({
      kind: "document",
      text: "const following = true;\n",
    });

    control.reply({
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id: control.state.messages[1]!.id,
      kind: "document",
      ok: true,
      code: compactDocumentResponseForText("const following = true;\n"),
    });
    await expect(following).resolves.toEqual(
      compactDocumentResponseForText("const following = true;\n"),
    );
    expect(control.state.terminateCalls).toBe(0);
  });

  test("ignores an aborted active result and preserves unrelated queued work", async () => {
    const control = createTestHighlightWorker();
    registerHighlightWorker(control.worker);
    const controller = new AbortController();
    const cancelled = requestDocument({ signal: controller.signal });
    const unrelated = requestDiff();

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "aborted", retryable: false });
    expect(control.state.messages).toHaveLength(1);
    expect(control.state.terminateCalls).toBe(0);

    control.reply({
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id: control.state.messages[0]!.id,
      kind: "document",
      ok: true,
      code: compactDocumentResponseForText("const answer = 42;\n"),
    });
    expect(control.state.messages).toHaveLength(2);
    expect(control.state.messages[1]?.kind).toBe("diff");

    control.reply({
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id: control.state.messages[1]!.id,
      kind: "diff",
      ok: true,
      code: emptyCompactDiffResponse(),
    });
    await expect(unrelated).resolves.toEqual(emptyCompactDiffResponse());
    expect(control.state.terminateCalls).toBe(0);
  });

  test("detaches abort listeners on success and disposal", async () => {
    const control = createTestHighlightWorker();
    registerHighlightWorker(control.worker);
    const controller = new AbortController();
    const addEventListener = spyOn(controller.signal, "addEventListener");
    const removeEventListener = spyOn(controller.signal, "removeEventListener");

    const completed = requestDocument({ signal: controller.signal });
    control.reply({
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id: control.state.messages[0]!.id,
      kind: "document",
      ok: true,
      code: compactDocumentResponseForText("const answer = 42;\n"),
    });
    await completed;
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);

    const disposed = requestDocument({ signal: controller.signal });
    disposeHighlightWorker();
    await expect(disposed).rejects.toMatchObject({ code: "worker-disposed", retryable: false });
    expect(addEventListener).toHaveBeenCalledTimes(2);
    expect(removeEventListener).toHaveBeenCalledTimes(2);
  });

  test("disposal terminates the worker and rejects active plus queued work", async () => {
    const control = createTestHighlightWorker();
    registerHighlightWorker(control.worker);
    const active = requestDiff();
    const queued = requestDocument();

    disposeHighlightWorker();

    await expect(active).rejects.toThrow("disposed");
    await expect(queued).rejects.toThrow("disposed");
    expect(control.state.terminateCalls).toBe(1);
  });
});
