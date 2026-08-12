import { describe, expect, test } from "bun:test";
import { createReviewSessionRuntime } from "../../app/reviewSessionRuntime";
import type { AppBootstrap } from "../../core/types";
import { createSessionRegistration } from "../app/registration";
import { createSessionSnapshotFromReviewState } from "../app/reviewSnapshot";
import type {
  HunkSessionBrokerClient,
  HunkSessionCommandResult,
  HunkSessionServerMessage,
} from "../types";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import { ReviewResourceCache } from "./reviewResourceCache";
import { HunkSessionBrokerState } from "./state";

function bootstrapWithPatch(patch: string): AppBootstrap {
  const file = createTestDiffFile({
    id: "file-1",
    path: "large.patch.txt",
    before: "old\n",
    after: "new\n",
  });
  return {
    input: { kind: "diff", left: "before", right: "after", options: {} },
    changeset: {
      id: "large-review",
      title: "large review",
      sourceLabel: "before → after",
      files: [{ ...file, patch }],
    },
    initialMode: "split",
    reloadContext: { cwd: process.cwd() },
  };
}

/** Connect a runtime-native command bridge to one in-memory daemon state. */
function connectRuntime(
  bootstrap: AppBootstrap,
  mutateRegistration?: (registration: ReturnType<typeof createSessionRegistration>) => void,
  state = new HunkSessionBrokerState(),
  // Observe one dispatched command and optionally delay its result delivery to expose overlap.
  onCommand?: (message: HunkSessionServerMessage) => (() => Promise<void> | void) | undefined,
) {
  const runtime = createReviewSessionRuntime(bootstrap);
  const runtimeSnapshot = runtime.getSnapshot();
  const registration = createSessionRegistration(bootstrap, runtimeSnapshot.projection.document);
  mutateRegistration?.(registration);
  const snapshot = createSessionSnapshotFromReviewState(runtimeSnapshot.store.getSnapshot());
  let bridge: {
    dispatchCommand(message: HunkSessionServerMessage): Promise<HunkSessionCommandResult>;
  } | null = null;
  const host = {
    getRegistration: () => registration,
    setBridge: (next: typeof bridge) => {
      bridge = next;
    },
    replaceSession: () => {},
    updateSnapshot: () => {},
  } as unknown as HunkSessionBrokerClient;
  runtime.attachHostClient(host);

  const commandCounts = new Map<string, number>();
  const socket = {
    send(data: string) {
      const message = JSON.parse(data) as HunkSessionServerMessage;
      commandCounts.set(message.command, (commandCounts.get(message.command) ?? 0) + 1);
      const settleCommand = onCommand?.(message);
      if (!bridge) throw new Error("Expected runtime bridge.");
      void bridge.dispatchCommand(message).then(
        async (result) => {
          await settleCommand?.();
          state.handleCommandResult(socket, { requestId: message.requestId, ok: true, result });
        },
        async (error) => {
          await settleCommand?.();
          state.handleCommandResult(socket, {
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    },
  };
  expect(state.registerSession(socket, registration, snapshot)).toBe(true);
  return {
    runtime,
    state,
    socket,
    registration,
    commandCounts,
    dispatch: (message: HunkSessionServerMessage) => bridge!.dispatchCommand(message),
  };
}

class RacingReviewResourceCache extends ReviewResourceCache {
  onCacheHit: (() => void) | null = null;

  override get(sessionId: string, generation: string, resourceId: string) {
    const bytes = super.get(sessionId, generation, resourceId);
    if (bytes) this.onCacheHit?.();
    return bytes;
  }
}

describe("chunked review resources", () => {
  test("keeps >2 MiB patches out of registration and reconstructs them in bounded chunks", async () => {
    const patch = `@@ -1 +1 @@\n-${"a".repeat(1_100_000)}\n+${"b".repeat(1_100_000)}\n`;
    const connected = connectRuntime(bootstrapWithPatch(patch));
    expect(JSON.stringify(connected.registration)).not.toContain(patch);
    expect(Buffer.byteLength(JSON.stringify(connected.registration))).toBeLessThan(100_000);

    const review = await connected.state.getSessionReviewWithResources(
      { sessionId: connected.registration.sessionId },
      { includePatch: true },
    );
    expect(review.files[0]?.patch).toBe(patch);
    expect(connected.state.getReviewResourceCacheEntryCount()).toBe(1);

    connected.state.unregisterSocket(connected.socket);
    expect(connected.state.getReviewResourceCacheEntryCount()).toBe(0);
    connected.runtime.dispose();
  });

  test("reconstructs opt-in patches through a bounded parallel worker pool, not serially", async () => {
    const bootstrap = bootstrapWithPatch("unused");
    bootstrap.changeset.files = Array.from({ length: 6 }, (_, index) => ({
      ...createTestDiffFile({
        id: `file-${index}`,
        path: `file-${index}.txt`,
        before: `old ${index}\n`,
        after: `new ${index}\n`,
      }),
      patch: `@@ -1 +1 @@\n-old ${index}\n+new ${index}\n`,
    }));
    let inFlightReads = 0;
    let maxInFlightReads = 0;
    const connected = connectRuntime(bootstrap, undefined, undefined, (message) => {
      if (message.command !== "read_review_resource") return undefined;
      inFlightReads += 1;
      maxInFlightReads = Math.max(maxInFlightReads, inFlightReads);
      return async () => {
        // Hold every producer response open briefly so serialized loads could never overlap.
        await Bun.sleep(5);
        inFlightReads -= 1;
      };
    });

    const review = await connected.state.getSessionReviewWithResources(
      { sessionId: connected.registration.sessionId },
      { includePatch: true },
    );
    expect(review.files.map((file) => file.patch)).toEqual(
      bootstrap.changeset.files.map((file) => file.patch),
    );
    // Six single-chunk patches through a pool of four workers must saturate the pool exactly.
    expect(maxInFlightReads).toBe(4);
    connected.runtime.dispose();
  });

  test("reconstructs lazy canonical files once through verified bounded chunks", async () => {
    const connected = connectRuntime(bootstrapWithPatch("@@ -1 +1 @@\n-old\n+new\n"));
    const projection = connected.runtime.getSnapshot().projection;
    const file = projection.document.files[0]!;
    expect(projection.resourceContents[file.canonicalResourceId]).toBeUndefined();

    const [first, concurrent] = await Promise.all([
      connected.state.getBrowserReviewResource(
        connected.registration.sessionId,
        projection.document.generation,
        file.canonicalResourceId,
      ),
      connected.state.getBrowserReviewResource(
        connected.registration.sessionId,
        projection.document.generation,
        file.canonicalResourceId,
      ),
    ]);
    expect(concurrent.bytes).toEqual(first.bytes);
    expect(JSON.parse(Buffer.from(first.bytes).toString("utf8"))).toEqual(file);
    expect(first.descriptor).not.toHaveProperty("byteLength");
    expect(first.descriptor).not.toHaveProperty("digest");
    expect(projection.resourceContents[file.canonicalResourceId]).toBeUndefined();
    expect(connected.state.getReviewResourceCacheEntryCount()).toBe(1);
    const reads = connected.commandCounts.get("read_review_resource");

    const second = await connected.state.getBrowserReviewResource(
      connected.registration.sessionId,
      projection.document.generation,
      file.canonicalResourceId,
    );
    expect(second.bytes).toEqual(first.bytes);
    expect(connected.commandCounts.get("read_review_resource")).toBe(reads);
    connected.runtime.dispose();
  });

  test("never returns a retired generation from a cache-hit replacement race", async () => {
    const cache = new RacingReviewResourceCache();
    const state = new HunkSessionBrokerState(cache);
    const connected = connectRuntime(bootstrapWithPatch("cached patch"), undefined, state);
    await state.getSessionReviewWithResources(
      { sessionId: connected.registration.sessionId },
      { includePatch: true },
    );
    const replacement = structuredClone(connected.registration);
    replacement.info.documentGeneration = "generation:replacement";
    replacement.info.reviewManifest.generation = "generation:replacement";
    for (const resource of replacement.info.reviewManifest.resources) {
      resource.generation = "generation:replacement";
    }
    const replacementSnapshot = createSessionSnapshotFromReviewState(
      connected.runtime.getSnapshot().store.getSnapshot(),
    );
    replacementSnapshot.state.documentGeneration = "generation:replacement";
    replacementSnapshot.state.review.documentGeneration = "generation:replacement";
    cache.onCacheHit = () => {
      cache.onCacheHit = null;
      state.registerSession(connected.socket, replacement, replacementSnapshot);
    };
    await expect(
      state.getSessionReviewWithResources(
        { sessionId: connected.registration.sessionId },
        { includePatch: true },
      ),
    ).rejects.toThrow("retired");
    connected.runtime.dispose();
  });

  test("rejects digest mismatches and releases the failed assembly reservation", async () => {
    const patch = "@@ -1 +1 @@\n-old\n+new\n";
    const cache = new ReviewResourceCache();
    const connected = connectRuntime(
      bootstrapWithPatch(patch),
      (registration) => {
        registration.info.reviewManifest.resources[0]!.digest = "0".repeat(64);
      },
      new HunkSessionBrokerState(cache),
    );
    await expect(
      connected.state.getSessionReviewWithResources(
        { sessionId: connected.registration.sessionId },
        { includePatch: true },
      ),
    ).rejects.toThrow("inconsistent metadata");
    expect(connected.state.getReviewResourceCacheEntryCount()).toBe(0);
    expect(cache.getReservationCount()).toBe(0);
    connected.runtime.dispose();
  });

  test("deduplicates and caches one lazy source materialization across concurrent browser reads", async () => {
    const lines = Array.from({ length: 80_000 }, (_, index) => `line ${index + 1}`);
    const after = [...lines];
    after[40_000] = "changed";
    let sourceReads = 0;
    const bootstrap = bootstrapWithPatch("patch");
    bootstrap.changeset.files = [
      createTestDiffFile({
        id: "source-file",
        path: "source.ts",
        before: `${lines.join("\n")}\n`,
        after: `${after.join("\n")}\n`,
        sourceFetcher: {
          cacheKey: "source:materialized",
          getFullText: async () => {
            sourceReads += 1;
            await Bun.sleep(5);
            return `${after.join("\n")}\n`;
          },
        },
      }),
    ];
    const connected = connectRuntime(bootstrap);
    const semantic = connected.runtime.getSnapshot().projection.document.files[0]!;
    await connected.runtime.toggleSourceGap(semantic.key, "before:0");
    const resourceId = semantic.sourceResourceIds.new!;
    const reads = await Promise.all(
      Array.from({ length: 4 }, () =>
        connected.state.getBrowserReviewResource(
          connected.registration.sessionId,
          connected.registration.info.documentGeneration,
          resourceId,
        ),
      ),
    );
    expect(sourceReads).toBe(1);
    expect(new Set(reads.map((entry) => entry.bytes)).size).toBe(1);
    expect(connected.commandCounts.get("read_review_resource")).toBeLessThanOrEqual(5);
    expect(connected.state.getReviewResourceCacheEntryCount()).toBe(1);
    await connected.state.getBrowserReviewResource(
      connected.registration.sessionId,
      connected.registration.info.documentGeneration,
      resourceId,
    );
    expect(connected.commandCounts.get("read_review_resource")).toBeLessThanOrEqual(5);
    connected.runtime.dispose();
  });

  test("reserves strict maxima before concurrent distinct lazy source assemblies", async () => {
    const bootstrap = bootstrapWithPatch("patch");
    const sourceText = `${"source line\n".repeat(50_000)}`;
    bootstrap.changeset.files = ["first", "second"].map((id) =>
      createTestDiffFile({
        id,
        path: `${id}.ts`,
        before: `before\n${sourceText}`,
        after: `after\n${sourceText}`,
        sourceFetcher: {
          cacheKey: `source:${id}`,
          getFullText: async () => `after\n${sourceText}`,
        },
      }),
    );
    const cache = new ReviewResourceCache({ inFlightBytes: 1_500_000 });
    const connected = connectRuntime(bootstrap, undefined, new HunkSessionBrokerState(cache));
    const semantics = connected.runtime.getSnapshot().projection.document.files;
    await Promise.all(
      semantics.map((file) => connected.runtime.toggleSourceGap(file.key, "trailing:0")),
    );
    const [firstId, secondId] = semantics.map((file) => file.sourceResourceIds.new!);
    const read = (resourceId: string) =>
      connected.state.getBrowserReviewResource(
        connected.registration.sessionId,
        connected.registration.info.documentGeneration,
        resourceId,
      );

    const first = read(firstId!);
    const second = read(secondId!);
    expect(cache.getReservationCount()).toBe(1);
    await expect(second).rejects.toThrow("in-flight");
    await expect(first).resolves.toMatchObject({ descriptor: { id: firstId } });
    expect(cache.getReservationCount()).toBe(0);
    const materializedBytes = Buffer.byteLength(`after\n${sourceText}`);
    expect(cache.getTotalBytes()).toBe(materializedBytes);
    await expect(read(secondId!)).resolves.toMatchObject({ descriptor: { id: secondId } });
    expect(cache.getReservationCount()).toBe(0);
    expect(cache.getTotalBytes()).toBe(materializedBytes * 2);
    expect(connected.state.getReviewResourceCacheEntryCount()).toBe(2);
    connected.runtime.dispose();
  });

  test("rejects undescribed lazy sources without loading or allocating them", async () => {
    const bootstrap = bootstrapWithPatch("patch");
    let sourceReads = 0;
    bootstrap.changeset.files[0]!.sourceFetcher = {
      cacheKey: "source:test",
      getFullText: async () => {
        sourceReads += 1;
        return "x".repeat(33 * 1024 * 1024);
      },
    };
    const connected = connectRuntime(bootstrap);
    const descriptor = connected.registration.info.reviewManifest.resources.find(
      (resource) => resource.kind === "source" && resource.side === "new",
    )!;
    const result = await connected.dispatch({
      type: "command",
      requestId: "source-1",
      command: "read_review_resource",
      input: {
        sessionId: connected.registration.sessionId,
        generation: connected.registration.info.documentGeneration,
        resourceId: descriptor.id,
        offset: 0,
        length: 256 * 1024,
      },
    });
    expect(result).toMatchObject({
      kind: "review-error",
      error: { code: "unknown-resource" },
    });
    expect(sourceReads).toBe(0);
    connected.runtime.dispose();
  });

  test("serves reconnect snapshots and applies generation-guarded semantic actions", async () => {
    const connected = connectRuntime(bootstrapWithPatch("patch"));
    const generation = connected.registration.info.documentGeneration;
    const snapshot = await connected.dispatch({
      type: "command",
      requestId: "snapshot-1",
      command: "get_review_snapshot",
      input: { sessionId: connected.registration.sessionId, generation },
    });
    expect(snapshot).toMatchObject({
      kind: "review-snapshot",
      generation,
      state: { stateRevision: 0, showAgentNotes: false },
    });

    const applied = await connected.dispatch({
      type: "command",
      requestId: "action-1",
      command: "apply_review_action",
      input: {
        sessionId: connected.registration.sessionId,
        generation,
        expectedStateRevision: 0,
        action: { type: "notes/set-visibility", visible: true },
      },
    });
    expect(applied).toMatchObject({
      kind: "review-action",
      generation,
      stateRevision: 1,
      state: { showAgentNotes: true },
    });
    const stale = await connected.dispatch({
      type: "command",
      requestId: "action-stale",
      command: "apply_review_action",
      input: {
        sessionId: connected.registration.sessionId,
        generation: "generation:retired",
        action: { type: "filter/set", filter: "src" },
      },
    });
    expect(stale).toMatchObject({ kind: "review-error", error: { code: "stale-generation" } });
    connected.runtime.dispose();
  });

  test("rejects malformed action DTOs and missing generations without mutating state", async () => {
    const connected = connectRuntime(bootstrapWithPatch("patch"));
    const generation = connected.registration.info.documentGeneration;
    const initialRevision = connected.runtime.getSnapshot().store.getSnapshot().stateRevision;
    const malformed = [
      { type: "selection/select", selection: { fileKey: "file", hunkIndex: -1 } },
      {
        type: "selection/select",
        selection: { fileKey: "file", hunkIndex: 0, contextDigest: { bad: true } },
      },
      {
        type: "selection/select",
        selection: { fileKey: "file", hunkIndex: 0 },
        reveal: true,
      },
      {
        type: "selection/select",
        selection: { fileKey: "file", hunkIndex: 0 },
        reveal: { kind: "viewport" },
      },
      { type: "filter/set", filter: "src", extra: true },
      {
        type: "selection/set-line",
        fileKey: "file",
        hunkIndex: 0,
        side: "new",
        line: 1,
        reveal: "yes",
      },
    ];
    for (const action of malformed) {
      const result = await connected.dispatch({
        type: "command",
        requestId: crypto.randomUUID(),
        command: "apply_review_action",
        input: { sessionId: connected.registration.sessionId, generation, action },
      } as HunkSessionServerMessage);
      expect(result).toMatchObject({ kind: "review-error", error: { code: "invalid-action" } });
    }
    const unsupported = await connected.dispatch({
      type: "command",
      requestId: "unsupported-action",
      command: "apply_review_action",
      input: {
        sessionId: connected.registration.sessionId,
        generation,
        action: { type: "future/action" },
      },
    } as unknown as HunkSessionServerMessage);
    expect(unsupported).toMatchObject({
      kind: "review-error",
      error: { code: "unsupported-action" },
    });
    const oversized = await connected.dispatch({
      type: "command",
      requestId: "oversized-action",
      command: "apply_review_action",
      input: {
        sessionId: connected.registration.sessionId,
        generation,
        action: {
          type: "notes/create-user",
          note: {
            fileKey: "file",
            hunkIndex: 0,
            side: "new",
            line: 1,
            body: "é".repeat(128 * 1024 + 1),
          },
        },
      },
    } as HunkSessionServerMessage);
    expect(oversized).toMatchObject({
      kind: "review-error",
      error: { code: "invalid-action" },
    });
    const missingGeneration = await connected.dispatch({
      type: "command",
      requestId: "missing-generation",
      command: "apply_review_action",
      input: { action: { type: "notes/set-visibility", visible: true } },
    } as HunkSessionServerMessage);
    expect(missingGeneration).toMatchObject({
      kind: "review-error",
      error: { code: "invalid-command" },
    });
    expect(connected.runtime.getSnapshot().store.getSnapshot().stateRevision).toBe(initialRevision);
    connected.runtime.dispose();
  });

  test("rejects malformed complete review command DTOs without mutation", async () => {
    const connected = connectRuntime(bootstrapWithPatch("patch"));
    const sessionId = connected.registration.sessionId;
    const generation = connected.registration.info.documentGeneration;
    const resourceId = connected.registration.info.reviewManifest.resources[0]!.id;
    const revision = connected.runtime.getSnapshot().store.getSnapshot().stateRevision;
    const malformed = [
      {
        type: "command",
        requestId: "bad-read-extra",
        command: "read_review_resource",
        input: { sessionId, generation, resourceId, offset: 0, length: 1, extra: true },
      },
      {
        type: "command",
        requestId: "bad-read-id",
        command: "read_review_resource",
        input: { sessionId, generation, resourceId: "", offset: 0, length: 1 },
      },
      {
        type: "command",
        requestId: "bad-action-session",
        command: "apply_review_action",
        input: { sessionId: "", generation, action: { type: "filter/set", filter: "changed" } },
      },
      {
        type: "command",
        requestId: "bad-snapshot-extra",
        command: "get_review_snapshot",
        input: { sessionId, generation, extra: true },
      },
      {
        type: "command",
        requestId: "bad-outer-extra",
        command: "get_review_snapshot",
        input: { sessionId, generation },
        extra: true,
      },
    ];
    for (const message of malformed) {
      const result = await connected.dispatch(message as unknown as HunkSessionServerMessage);
      expect(result).toMatchObject({ kind: "review-error", error: { code: "invalid-command" } });
    }
    expect(connected.runtime.getSnapshot().store.getSnapshot().stateRevision).toBe(revision);
    connected.runtime.dispose();
  });

  test("returns typed failures for invalid, stale, cross-session, and unknown resource reads", async () => {
    const connected = connectRuntime(bootstrapWithPatch("patch"));
    const generation = connected.registration.info.documentGeneration;
    const resourceId = connected.registration.info.reviewManifest.resources[0]!.id;
    const read = (input: Record<string, unknown>) =>
      connected.dispatch({
        type: "command",
        requestId: crypto.randomUUID(),
        command: "read_review_resource",
        input: {
          sessionId: connected.registration.sessionId,
          generation,
          resourceId,
          offset: 0,
          length: 1,
          ...input,
        },
      } as HunkSessionServerMessage);

    await expect(read({ generation: "" })).resolves.toMatchObject({
      kind: "review-error",
      error: { code: "invalid-command" },
    });
    await expect(read({ offset: -1 })).resolves.toMatchObject({
      kind: "review-error",
      error: { code: "invalid-range" },
    });
    await expect(read({ generation: "generation:retired" })).resolves.toMatchObject({
      kind: "review-error",
      error: { code: "stale-generation" },
    });
    await expect(read({ sessionId: "another-session" })).resolves.toMatchObject({
      kind: "review-error",
      error: { code: "cross-session" },
    });
    await expect(read({ resourceId: "resource:unknown" })).resolves.toMatchObject({
      kind: "review-error",
      error: { code: "unknown-resource" },
    });
    connected.runtime.dispose();
  });
});
