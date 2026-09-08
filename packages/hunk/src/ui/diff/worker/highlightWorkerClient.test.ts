import { afterEach, describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../../../../test/helpers/diff-helpers";
import { supportsHighlightWorkerOffload } from "../../../highlightWorkerClient";
import type { CompactHighlightedDiff } from "./highlightCompact";
import {
  disposeHighlightWorker,
  highlightDiffInWorker,
  registerHighlightWorker,
} from "./highlightWorkerClient";

interface TestWorkerRequest {
  version: 3;
  id: number;
  aliasContext: boolean;
}

/** Build the smallest valid compact worker response. */
function emptyCompactResponse(): CompactHighlightedDiff {
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

/** Build a controllable Worker double for queue and lifecycle tests. */
function createTestHighlightWorker({ throwOnPost }: { throwOnPost?: Error } = {}) {
  const state = {
    messages: [] as TestWorkerRequest[],
    terminateCalls: 0,
    unrefCalls: 0,
  };
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage(message: TestWorkerRequest) {
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
  };
}

/** Queue one representative request through the worker client. */
function requestHighlight(aliasContext = false) {
  return highlightDiffInWorker({
    aliasContext,
    appearance: "dark",
    language: "typescript",
    metadata: createTestDiffFile().metadata,
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

  test("serializes requests, ignores stale replies, and propagates worker responses", async () => {
    const control = createTestHighlightWorker();
    registerHighlightWorker(control.worker);

    const first = requestHighlight(true);
    const second = requestHighlight();
    expect(control.state.unrefCalls).toBe(1);
    expect(control.state.messages).toHaveLength(1);
    expect(control.state.messages[0]?.aliasContext).toBe(true);

    control.reply({ version: 2, id: control.state.messages[0]?.id, ok: true });
    await Promise.resolve();
    expect(control.state.messages).toHaveLength(1);

    control.reply({
      version: 3,
      id: control.state.messages[0]?.id,
      ok: true,
      code: emptyCompactResponse(),
    });
    await expect(first).resolves.toEqual(emptyCompactResponse());
    expect(control.state.messages).toHaveLength(2);

    control.reply({
      version: 3,
      id: control.state.messages[1]?.id,
      ok: false,
      message: "highlight rejected",
    });
    await expect(second).rejects.toThrow("highlight rejected");
  });

  test("rejects active and queued work when a replacement worker takes over", async () => {
    const first = createTestHighlightWorker();
    const replacement = createTestHighlightWorker();
    registerHighlightWorker(first.worker);

    const active = requestHighlight();
    const queued = requestHighlight();
    registerHighlightWorker(replacement.worker);

    await expect(active).rejects.toThrow("replaced");
    await expect(queued).rejects.toThrow("replaced");
    expect(first.state.terminateCalls).toBe(1);
    expect(replacement.state.unrefCalls).toBe(1);
  });

  test("fails all work when posting throws and permits a later worker", async () => {
    const broken = createTestHighlightWorker({ throwOnPost: new Error("post failed") });
    registerHighlightWorker(broken.worker);

    await expect(requestHighlight()).rejects.toThrow("post failed");
    expect(broken.state.terminateCalls).toBe(1);

    const recovered = createTestHighlightWorker();
    registerHighlightWorker(recovered.worker);
    const pending = requestHighlight();
    const request = recovered.state.messages[0]!;
    recovered.reply({ version: 3, id: request.id, ok: true, code: emptyCompactResponse() });
    await expect(pending).resolves.toEqual(emptyCompactResponse());
  });

  test("disposal terminates the worker and rejects active plus queued work", async () => {
    const control = createTestHighlightWorker();
    registerHighlightWorker(control.worker);
    const active = requestHighlight();
    const queued = requestHighlight();

    disposeHighlightWorker();

    await expect(active).rejects.toThrow("disposed");
    await expect(queued).rejects.toThrow("disposed");
    expect(control.state.terminateCalls).toBe(1);
  });
});
