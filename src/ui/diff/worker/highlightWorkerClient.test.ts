import { afterEach, describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";
import { supportsHighlightWorkerOffload } from "../../../highlightWorkerClient";
import { replaceExtensionSyntaxGrammars } from "../../../core/changeset/syntaxGrammar";
import type { CompactHighlightedDiff } from "./highlightCompact";
import {
  disposeHighlightWorker,
  highlightDiffInWorker,
  registerHighlightWorker,
} from "./highlightWorkerClient";

type TestWorkerRequest =
  | { version: 4; type: "configure"; generation: number; grammars: readonly unknown[] }
  | { version: 4; type: "highlight"; id: number; aliasContext: boolean };

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
    acknowledgeConfiguration() {
      const request = state.messages.at(-1);
      if (!request || request.type !== "configure") throw new Error("Expected configure request");
      worker.onmessage?.({
        data: { version: 4, type: "configured", generation: request.generation, ok: true },
      } as MessageEvent);
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
  replaceExtensionSyntaxGrammars([]);
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
    expect(control.state.messages[0]?.type).toBe("configure");
    control.acknowledgeConfiguration();
    expect(control.state.messages).toHaveLength(2);
    const firstRequest = control.state.messages[1];
    expect(firstRequest?.type === "highlight" && firstRequest.aliasContext).toBe(true);

    control.reply({ version: 3, type: "highlight", id: 1, ok: true });
    await Promise.resolve();
    expect(control.state.messages).toHaveLength(2);

    control.reply({
      version: 4,
      type: "highlight",
      id: firstRequest?.type === "highlight" ? firstRequest.id : -1,
      ok: true,
      code: emptyCompactResponse(),
    });
    await expect(first).resolves.toEqual(emptyCompactResponse());
    expect(control.state.messages).toHaveLength(3);
    const secondRequest = control.state.messages[2];

    control.reply({
      version: 4,
      type: "highlight",
      id: secondRequest?.type === "highlight" ? secondRequest.id : -1,
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
    recovered.acknowledgeConfiguration();
    const request = recovered.state.messages[1]!;
    recovered.reply({
      version: 4,
      type: "highlight",
      id: request.type === "highlight" ? request.id : -1,
      ok: true,
      code: emptyCompactResponse(),
    });
    await expect(pending).resolves.toEqual(emptyCompactResponse());
  });

  test("rejects every pending request when worker configuration is rejected", async () => {
    const control = createTestHighlightWorker();
    registerHighlightWorker(control.worker);
    const active = requestHighlight();
    const queued = requestHighlight();
    const configure = control.state.messages[0];
    if (!configure || configure.type !== "configure") throw new Error("Expected configure request");

    control.reply({
      version: 4,
      type: "configured",
      generation: configure.generation,
      ok: false,
      message: "grammar rejected",
    });

    await expect(active).rejects.toThrow("grammar rejected");
    await expect(queued).rejects.toThrow("grammar rejected");
    expect(control.state.terminateCalls).toBe(1);
  });

  test("times out stalled worker configuration without waiting for the production budget", async () => {
    const control = createTestHighlightWorker();
    registerHighlightWorker(control.worker, { timeoutMs: 10 });

    await expect(requestHighlight()).rejects.toThrow(
      "Syntax grammar configuration timed out after 10ms",
    );
    expect(control.state.terminateCalls).toBe(1);
  });

  test("sends grammar data before work and retires a worker on generation change", async () => {
    replaceExtensionSyntaxGrammars([
      {
        extensionId: "custom",
        grammar: Object.freeze({
          id: "custom",
          scopeName: "source.custom",
          patterns: Object.freeze([{ match: "x", name: "keyword.custom" }]),
        }),
      },
    ]);
    const first = createTestHighlightWorker();
    registerHighlightWorker(first.worker);
    const pending = requestHighlight();
    const configure = first.state.messages[0];
    expect(configure?.type).toBe("configure");
    expect(configure?.type === "configure" && configure.grammars).toHaveLength(1);

    replaceExtensionSyntaxGrammars([]);
    await expect(pending).rejects.toThrow("configuration changed");
    expect(first.state.terminateCalls).toBe(1);

    const replacement = createTestHighlightWorker();
    registerHighlightWorker(replacement.worker);
    const replacementPending = requestHighlight();
    expect(replacement.state.messages[0]?.type).toBe("configure");
    disposeHighlightWorker();
    await expect(replacementPending).rejects.toThrow("disposed");
  });

  test("retires an active highlight when its configured grammar generation changes", async () => {
    replaceExtensionSyntaxGrammars([
      {
        extensionId: "custom",
        grammar: Object.freeze({
          id: "custom",
          scopeName: "source.custom",
          patterns: Object.freeze([{ match: "x", name: "keyword.custom" }]),
        }),
      },
    ]);
    const control = createTestHighlightWorker();
    registerHighlightWorker(control.worker);
    const active = requestHighlight();
    control.acknowledgeConfiguration();
    expect(control.state.messages[1]?.type).toBe("highlight");

    replaceExtensionSyntaxGrammars([]);

    await expect(active).rejects.toThrow("configuration changed");
    expect(control.state.terminateCalls).toBe(1);
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
