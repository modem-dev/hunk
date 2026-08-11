import { describe, expect, mock, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import {
  createTestDeferred,
  createTestDiffFile,
  createTestSourceFetcher,
  lines,
} from "../../test/helpers/diff-helpers";
import { createWatchTestRuntime } from "../../test/helpers/watchTest";
import type { HunkConfigResolution } from "../core/config";
import { reviewGapAddress } from "../core/review/expansion";
import { projectReviewNote } from "../core/review/notes";
import { reviewLineContextDigest } from "../core/review/reconcile";
import type { AppBootstrap, CliInput } from "../core/types";
import { createEmptyExtensionLoadResult } from "../extensions/types";
import type {
  HunkSessionBrokerClient,
  HunkSessionRegistration,
  HunkSessionServerMessage,
  HunkSessionSnapshot,
} from "../session/types";
import { createSessionRegistration } from "../session/app/registration";
import type { SessionBootstrapResult } from "./sessionBootstrap";
import { createReviewSessionRuntime, type ReviewSessionRuntimeDeps } from "./reviewSessionRuntime";

/** Build a renderer-neutral bootstrap whose source stays inside the test process cwd. */
function createBootstrap(overrides: Partial<AppBootstrap> = {}) {
  return {
    ...createTestVcsAppBootstrap({
      files: [createTestDiffFile({ path: "alpha.ts" })],
      sourceLabel: process.cwd(),
      title: "initial",
    }),
    ...overrides,
  };
}

/** Build static note metadata large enough to exceed one producer snapshot envelope. */
function createNoteHeavyBootstrap() {
  return createTestVcsAppBootstrap({
    files: [
      createTestDiffFile({
        path: "alpha.ts",
        agent: {
          path: "alpha.ts",
          annotations: Array.from({ length: 40 }, (_, index) => ({
            newRange: [1, 1] as [number, number],
            summary: `${index}:${"x".repeat(180 * 1024)}`,
          })),
        },
      }),
    ],
    sourceLabel: process.cwd(),
  });
}

/** Create a canonical reload seam that turns the requested theme into visible content. */
function createReloadDeps(
  load?: (
    input: CliInput,
    cwd: string,
    extensions: AppBootstrap["extensions"],
  ) => Promise<AppBootstrap>,
): ReviewSessionRuntimeDeps {
  return {
    resolveConfiguredCliInputImpl: ((input: CliInput) => ({
      input,
      customThemes: [],
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      keybindings: {},
      startupNotices: [],
    })) as typeof import("../core/config").resolveConfiguredCliInput,
    loadConfiguredSessionBootstrapImpl: (async ({ configured, cwd, extensions }) => {
      const input = (configured as HunkConfigResolution).input;
      const bootstrap = load
        ? await load(input, cwd, extensions)
        : {
            ...createBootstrap(),
            input,
            reloadContext: { cwd },
            changeset: {
              ...createBootstrap().changeset,
              title: input.options.theme ?? "reloaded",
            },
            extensions,
          };
      return {
        applied: { vcsAdapters: [], issues: [] },
        bootstrap,
        input,
        sessionThemes: { themes: [], notices: [] },
        sessionVcs: { vcsId: input.options.vcs },
      } as SessionBootstrapResult;
    }) as typeof import("./sessionBootstrap").loadConfiguredSessionBootstrap,
  };
}

/** Return one reload input distinguished by a title-bearing theme option. */
function reloadInput(theme: string): CliInput {
  return { kind: "vcs", staged: false, options: { theme } };
}

/** Capture broker publications and expose the command bridge for headless lifecycle tests. */
function createHeadlessHostClient(bootstrap: AppBootstrap, onReplace?: () => void) {
  type Bridge = Parameters<HunkSessionBrokerClient["setBridge"]>[0];
  let bridge: Bridge = null;
  let registration = createSessionRegistration(bootstrap);
  const updated: HunkSessionSnapshot[] = [];
  const replaced: HunkSessionSnapshot[] = [];
  let stopCount = 0;
  const hostClient = {
    getRegistration: () => registration,
    updateSnapshot: (snapshot: HunkSessionSnapshot) => updated.push(snapshot),
    setBridge: (next: Bridge) => {
      bridge = next;
    },
    replaceSession: (nextRegistration: HunkSessionRegistration, snapshot: HunkSessionSnapshot) => {
      onReplace?.();
      registration = nextRegistration;
      replaced.push(snapshot);
    },
    stop: async () => {
      stopCount += 1;
    },
  } as unknown as HunkSessionBrokerClient;
  return {
    hostClient,
    getBridge: () => bridge,
    getStopCount: () => stopCount,
    dispatchCommand(message: HunkSessionServerMessage) {
      if (!bridge) throw new Error("Session command adapter is unavailable during cutover.");
      return bridge.dispatchCommand(message);
    },
    updated,
    replaced,
  };
}

describe("ReviewSessionRuntime", () => {
  test("owns the initial document, resources, store, and launch bounds headlessly", () => {
    const runtime = createReviewSessionRuntime(createBootstrap());
    const snapshot = runtime.getSnapshot();

    expect(snapshot.bootstrap.changeset.title).toBe("initial");
    expect(snapshot.store.getSnapshot().document).toBe(snapshot.projection.document);
    const semanticFile = snapshot.projection.document.files[0]!;
    const patchId = semanticFile.patchResourceId;
    expect(runtime.getEncodedResourceCacheStats()).toEqual({ entries: 0, totalBytes: 0 });
    expect(runtime.getResource(patchId)).toBe(snapshot.bootstrap.changeset.files[0]!.patch);
    expect(snapshot.projection.resourceContents[semanticFile.canonicalResourceId]).toBeUndefined();
    const canonical = runtime.getResource(semanticFile.canonicalResourceId);
    expect(JSON.parse(canonical!)).toEqual(semanticFile);
    // Canonical JSON stays encoded only; terminal state never retains a duplicate full string.
    expect(snapshot.projection.resourceContents[semanticFile.canonicalResourceId]).toBeUndefined();
    expect(runtime.getEncodedResourceCacheStats()).toEqual({
      entries: 2,
      totalBytes:
        Buffer.byteLength(snapshot.bootstrap.changeset.files[0]!.patch) +
        Buffer.byteLength(canonical!),
    });
    expect(runtime.getResource(semanticFile.canonicalResourceId)).toBe(canonical);
    expect(runtime.getReloadBounds().roots).toEqual([process.cwd()]);
    runtime.dispose();
  });

  test("reuses encoded patch and canonical bytes within one generation and isolates reloads", async () => {
    const patch = `@@ -1 +1 @@\n-${"a".repeat(300_000)}\n+${"b".repeat(300_000)}\n`;
    const base = createTestDiffFile({ path: "alpha.ts" });
    const bootstrap = createBootstrap({
      changeset: { ...createBootstrap().changeset, files: [{ ...base, patch }] },
    });
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, {
      hostClient: host.hostClient,
      deps: createReloadDeps(async (input, cwd, extensions) => ({
        ...bootstrap,
        input,
        reloadContext: { cwd },
        extensions,
      })),
    });
    const firstProjection = runtime.getSnapshot().projection;
    const firstFile = firstProjection.document.files[0]!;
    const firstGeneration = firstProjection.document.generation;
    const sessionId = host.hostClient.getRegistration().sessionId;
    const canonical = JSON.stringify(firstFile);
    const fromSpy = spyOn(Buffer, "from");

    /** Read one producer resource range through the real command bridge. */
    const read = (generation: string, resourceId: string, offset: number, requestId: string) =>
      host.dispatchCommand({
        type: "command",
        requestId,
        command: "read_review_resource",
        input: {
          sessionId,
          generation,
          resourceId,
          offset,
          length: 256 * 1024,
        },
      });

    try {
      expect(await read(firstGeneration, firstFile.patchResourceId, 0, "patch-1")).toMatchObject({
        kind: "review-resource",
        offset: 0,
      });
      expect(
        await read(firstGeneration, firstFile.patchResourceId, 256 * 1024, "patch-2"),
      ).toMatchObject({ kind: "review-resource", offset: 256 * 1024 });
      expect(
        await read(firstGeneration, firstFile.canonicalResourceId, 0, "canonical-1"),
      ).toMatchObject({ kind: "review-resource", offset: 0 });
      expect(
        await read(firstGeneration, firstFile.canonicalResourceId, 0, "canonical-2"),
      ).toMatchObject({ kind: "review-resource", offset: 0 });
      expect(fromSpy.mock.calls.filter((call) => call[0] === patch)).toHaveLength(1);
      expect(fromSpy.mock.calls.filter((call) => call[0] === canonical)).toHaveLength(1);

      await runtime.reload("daemon", reloadInput("replacement"));
      const replacement = runtime.getSnapshot().projection;
      const replacementFile = replacement.document.files[0]!;
      expect(replacement).not.toBe(firstProjection);
      expect(
        await read(firstGeneration, firstFile.patchResourceId, 0, "patch-stale"),
      ).toMatchObject({ kind: "review-error", error: { code: "stale-generation" } });
      expect(
        await read(
          replacement.document.generation,
          replacementFile.patchResourceId,
          0,
          "patch-replacement",
        ),
      ).toMatchObject({ kind: "review-resource", offset: 0 });
      expect(fromSpy.mock.calls.filter((call) => call[0] === patch)).toHaveLength(2);
    } finally {
      fromSpy.mockRestore();
      runtime.dispose();
    }
  });

  test("rejects oversized and inconsistent canonical resources before caching output", () => {
    const oversizedRuntime = createReviewSessionRuntime(createBootstrap());
    const oversizedProjection = oversizedRuntime.getSnapshot().projection;
    const oversizedFile = oversizedProjection.document.files[0]!;
    const oversizedDescriptor = oversizedProjection.document.resources.find(
      (resource) => resource.id === oversizedFile.canonicalResourceId,
    )!;
    let serializationStarted = false;
    Object.defineProperty(oversizedFile, "toJSON", {
      configurable: true,
      get: () => {
        serializationStarted = true;
        return undefined;
      },
    });
    oversizedDescriptor.byteLength = 32 * 1024 * 1024 + 1;
    oversizedDescriptor.digest = "0".repeat(64);
    expect(() => oversizedRuntime.getResource(oversizedFile.canonicalResourceId)).toThrow(
      "outside resource bounds",
    );
    expect(serializationStarted).toBe(false);
    expect(oversizedProjection.resourceContents[oversizedFile.canonicalResourceId]).toBeUndefined();
    oversizedRuntime.dispose();

    const inconsistentRuntime = createReviewSessionRuntime(createBootstrap());
    const inconsistentProjection = inconsistentRuntime.getSnapshot().projection;
    const inconsistentFile = inconsistentProjection.document.files[0]!;
    const inconsistentDescriptor = inconsistentProjection.document.resources.find(
      (resource) => resource.id === inconsistentFile.canonicalResourceId,
    )!;
    inconsistentDescriptor.byteLength = Buffer.byteLength(JSON.stringify(inconsistentFile));
    inconsistentDescriptor.digest = "0".repeat(64);
    expect(() => inconsistentRuntime.getResource(inconsistentFile.canonicalResourceId)).toThrow(
      "integrity verification",
    );
    expect(
      inconsistentProjection.resourceContents[inconsistentFile.canonicalResourceId],
    ).toBeUndefined();
    inconsistentRuntime.dispose();
  });

  test("returns a typed failure when lazy canonical encoding exceeds its strict bound", async () => {
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const projection = runtime.getSnapshot().projection;
    const file = projection.document.files[0]!;
    Object.defineProperty(file, "toJSON", {
      configurable: true,
      value: () => "x".repeat(32 * 1024 * 1024 + 1),
    });

    const result = await host.dispatchCommand({
      type: "command",
      requestId: "oversized-canonical",
      command: "read_review_resource",
      input: {
        sessionId: host.hostClient.getRegistration().sessionId,
        generation: projection.document.generation,
        resourceId: file.canonicalResourceId,
        offset: 0,
        length: 256 * 1024,
      },
    });
    expect(result).toMatchObject({ kind: "review-error", error: { code: "resource-too-large" } });
    expect(runtime.getEncodedResourceCacheStats()).toEqual({ entries: 0, totalBytes: 0 });
    runtime.dispose();
  });

  test("publishes headless store dispatches and retires old-store broker callbacks", async () => {
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, {
      deps: createReloadDeps(),
      hostClient: host.hostClient,
    });
    const previousStore = runtime.getSnapshot().store;

    previousStore.dispatch({ type: "notes/set-visibility", visible: true });
    expect(host.updated.at(-1)?.state.showAgentNotes).toBe(true);

    await runtime.reload("manual", reloadInput("next"), { resetApp: false });
    expect(host.replaced).toHaveLength(1);
    expect(host.updated).toHaveLength(1);
    const publicationsAfterReload = host.updated.length;
    previousStore.dispatch({ type: "notes/set-visibility", visible: false });
    expect(host.updated).toHaveLength(publicationsAfterReload);

    runtime.getSnapshot().store.dispatch({ type: "notes/set-visibility", visible: false });
    expect(host.updated.at(-1)?.state.showAgentNotes).toBe(false);
    runtime.dispose();
  });

  test("keeps drafts local while publishing browser actions, saves, and renderer widths exactly once", async () => {
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const store = runtime.getSnapshot().store;
    const initial = store.getSnapshot();
    const semantic = initial.document.files[0]!;
    const sourceFile = bootstrap.changeset.files[0]!;
    const line = semantic.hunks[0]!.additionStart;
    const generalRevisions: number[] = [];
    store.subscribe(() => generalRevisions.push(store.getSnapshot().stateRevision));

    store.dispatch({
      type: "draft/start",
      expectedGeneration: initial.documentGeneration,
      draft: {
        id: "draft:runtime",
        fileKey: semantic.key,
        hunkIndex: 0,
        side: "new",
        line,
        body: "",
      },
    });
    store.dispatch({
      type: "draft/update",
      expectedGeneration: initial.documentGeneration,
      body: "terminal typing",
    });
    expect(generalRevisions).toEqual([0, 0]);
    expect(store.getSnapshot().stateRevision).toBe(0);
    expect(host.updated).toHaveLength(0);

    const browserResult = await host.dispatchCommand({
      type: "command",
      requestId: "browser-after-terminal-draft",
      command: "apply_review_action",
      input: {
        sessionId: host.hostClient.getRegistration().sessionId,
        generation: initial.documentGeneration,
        expectedStateRevision: 0,
        action: { type: "filter/set", filter: "alpha" },
      },
    });
    expect(browserResult).toMatchObject({ kind: "review-action", stateRevision: 1 });
    expect(host.updated).toHaveLength(1);

    store.dispatch({
      type: "draft/save",
      expectedGeneration: initial.documentGeneration,
      note: {
        note: projectReviewNote({
          annotation: {
            id: "user:runtime-draft",
            source: "user",
            summary: "terminal typing",
            newRange: [line, line],
          },
          fileKey: semantic.key,
          hunks: sourceFile.metadata.hunks,
          origin: "user",
          editable: true,
        }),
        contextDigest: reviewLineContextDigest(semantic, "new", line),
        resolution: "active",
      },
    });
    expect(store.getSnapshot()).toMatchObject({ stateRevision: 2, draftNote: null });
    expect(host.updated).toHaveLength(2);

    runtime.setSessionRendererFields({ noteMarkupWidth: 42 });
    expect(host.updated).toHaveLength(3);
    expect(host.updated.at(-1)?.state).toMatchObject({ stateRevision: 2, noteMarkupWidth: 42 });
    runtime.setSessionRendererFields({
      noteMarkupWidth: 42,
      validateMarkup: () => ["terminal-only"],
    });
    expect(host.updated).toHaveLength(3);
    runtime.setSessionRendererFields({ noteMarkupWidth: 44 });
    expect(host.updated).toHaveLength(4);
    expect(host.updated.at(-1)?.state.noteMarkupWidth).toBe(44);
    runtime.dispose();
  });

  test("makes commands unavailable during atomic broker cutover and never mutates retired state", async () => {
    const bootstrap = createBootstrap();
    let cutoverAttempt = "not-attempted";
    let host!: ReturnType<typeof createHeadlessHostClient>;
    host = createHeadlessHostClient(bootstrap, () => {
      try {
        void host.dispatchCommand({
          type: "command",
          requestId: "cutover-race",
          command: "clear_comments",
          input: { sessionId: "session" },
        });
        cutoverAttempt = "routed";
      } catch {
        cutoverAttempt = "unavailable";
      }
    });
    const runtime = createReviewSessionRuntime(bootstrap, {
      deps: createReloadDeps(),
      hostClient: host.hostClient,
    });
    const previousStore = runtime.getSnapshot().store;
    await runtime.reload("manual", reloadInput("cutover"), { resetApp: false });
    expect(cutoverAttempt).toBe("unavailable");
    expect(host.getBridge()).not.toBeNull();
    expect(runtime.getSnapshot().store.getSnapshot().showAgentNotes).toBe(false);

    // A retained old store can no longer publish after the runtime generation cutover.
    previousStore.dispatch({ type: "notes/set-visibility", visible: true });
    expect(runtime.getSnapshot().store.getSnapshot().showAgentNotes).toBe(false);
    runtime.dispose();
  });

  test("applies browser selection reveals and revision-guarded note CRUD through one store", async () => {
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const sessionId = host.hostClient.getRegistration().sessionId;
    const state = runtime.getSnapshot().store.getSnapshot();
    const file = state.document.files[0]!;
    const apply = (requestId: string, action: any, expectedStateRevision?: number) =>
      host.dispatchCommand({
        type: "command",
        requestId,
        command: "apply_review_action",
        input: {
          sessionId,
          generation: runtime.getSnapshot().store.getSnapshot().documentGeneration,
          ...(expectedStateRevision === undefined ? {} : { expectedStateRevision }),
          action,
        },
      });

    await apply("reveal-1", {
      type: "selection/select",
      selection: { fileKey: file.key, hunkIndex: 0 },
      reveal: { kind: "hunk" },
    });
    await apply("reveal-2", {
      type: "selection/select",
      selection: { fileKey: file.key, hunkIndex: 0 },
      reveal: { kind: "hunk" },
    });
    expect(runtime.getSnapshot().store.getSnapshot().reveal.hunkToken).toBe(2);

    const revision = runtime.getSnapshot().store.getSnapshot().stateRevision;
    const created = await apply(
      "note-create",
      {
        type: "notes/create-user",
        note: { fileKey: file.key, hunkIndex: 0, side: "new", line: 1, body: "Browser note" },
      },
      revision,
    );
    expect(created).toMatchObject({ kind: "review-action" });
    const noteId = runtime.getSnapshot().store.getSnapshot().userNotes[0]!.note.id;
    expect(runtime.getSnapshot().store.getSnapshot().userNotes).toHaveLength(1);

    const stale = await apply(
      "note-stale",
      { type: "notes/update-user", noteId, body: "stale" },
      revision,
    );
    expect(stale).toMatchObject({ kind: "review-error", error: { code: "stale-revision" } });
    expect(runtime.getSnapshot().store.getSnapshot().userNotes[0]!.note.summary).toBe(
      "Browser note",
    );

    const updateRevision = runtime.getSnapshot().store.getSnapshot().stateRevision;
    await apply(
      "note-update",
      { type: "notes/update-user", noteId, body: "Edited note" },
      updateRevision,
    );
    expect(runtime.getSnapshot().store.getSnapshot().userNotes[0]!.note.summary).toBe(
      "Edited note",
    );
    const removeRevision = runtime.getSnapshot().store.getSnapshot().stateRevision;
    await apply("note-remove", { type: "notes/remove-user", noteId }, removeRevision);
    expect(runtime.getSnapshot().store.getSnapshot().userNotes).toHaveLength(0);
    runtime.dispose();
  });

  test("rejects browser cross-hunk and incomplete selections while deriving line evidence", async () => {
    const diff = createTestDiffFile({
      path: "alpha.ts",
      before: "old one\nstable two\nstable three\nstable four\nold five\n",
      after: "new one\nstable two\nstable three\nstable four\nnew five\n",
      context: 0,
    });
    const bootstrap = createBootstrap({
      changeset: { ...createBootstrap().changeset, files: [diff] },
    });
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const state = runtime.getSnapshot().store.getSnapshot();
    const file = state.document.files[0]!;
    expect(file.hunks).toHaveLength(2);
    const sessionId = host.hostClient.getRegistration().sessionId;
    const apply = (requestId: string, action: unknown) =>
      host.dispatchCommand({
        type: "command",
        requestId,
        command: "apply_review_action",
        input: { sessionId, generation: state.documentGeneration, action },
      } as HunkSessionServerMessage);

    const valid = await apply("canonical-line", {
      type: "selection/set-line",
      fileKey: file.key,
      hunkIndex: 0,
      side: "new",
      line: file.hunks[0]!.additionStart,
      contextDigest: "caller-authored",
      reveal: true,
    });
    expect(valid).toMatchObject({
      kind: "review-action",
      state: { selection: { contextDigest: expect.any(String) } },
    });
    const afterValid = runtime.getSnapshot().store.getSnapshot();
    expect(afterValid.selection.contextDigest).not.toBe("caller-authored");

    const crossHunk = await apply("cross-hunk-line", {
      type: "selection/set-line",
      fileKey: file.key,
      hunkIndex: 1,
      side: "new",
      line: file.hunks[0]!.additionStart,
    });
    expect(crossHunk).toMatchObject({
      kind: "review-error",
      error: { code: "invalid-action" },
    });
    const incomplete = await apply("incomplete-line", {
      type: "selection/select",
      selection: { fileKey: file.key, hunkIndex: 0, side: "new" },
    });
    expect(incomplete).toMatchObject({
      kind: "review-error",
      error: { code: "invalid-action" },
    });
    expect(runtime.getSnapshot().store.getSnapshot()).toBe(afterValid);
    runtime.dispose();
  });

  test("executes direct semantic intents transactionally with canonical targets and no-ops", () => {
    const fixed = new Date("2026-02-03T04:05:06.000Z");
    const runtime = createReviewSessionRuntime(createBootstrap(), {
      deps: { nowImpl: () => fixed },
    });
    const store = runtime.getSnapshot().store;
    const initial = store.getSnapshot();
    let publications = 0;
    const unsubscribe = store.subscribePublished(() => {
      publications += 1;
    });
    const file = initial.document.files[0]!;
    const hunk = file.hunks[0]!;
    const line = hunk.additionStart;

    const unchanged = runtime.executeReviewIntent({
      type: "notes/set-visibility",
      visible: initial.showAgentNotes,
    });
    expect(unchanged).toEqual({ before: initial, state: initial, changed: false });
    expect(store.getSnapshot()).toBe(initial);
    expect(publications).toBe(0);

    const created = runtime.executeReviewIntent({
      type: "note/create-user",
      fileKey: file.key,
      hunkIndex: 0,
      side: "new",
      line,
      body: "  direct note  ",
    });
    expect(created.before).toBe(initial);
    expect(created.changed).toBe(true);
    expect(created.state.stateRevision).toBe(1);
    expect(created.createdNote).toMatchObject({
      note: {
        id: `user:${fixed.getTime()}-1`,
        summary: "direct note",
        createdAt: fixed.toISOString(),
        anchor: {
          preferred: { side: "new", line },
          ownerHunkIndex: 0,
        },
      },
    });

    const selected = runtime.executeReviewIntent({
      type: "selection/set-line",
      fileKey: file.key,
      hunkIndex: 0,
      side: "new",
      line,
      reveal: true,
    });
    expect(selected.state.selection).toMatchObject({
      fileKey: file.key,
      hunkIndex: 0,
      side: "new",
      line,
      contextDigest: expect.any(String),
    });
    expect(selected.state.stateRevision).toBe(2);

    const filtered = runtime.executeReviewIntent({ type: "filter/set", filter: "alpha" });
    expect(filtered.state.filter).toBe("alpha");
    const visible = runtime.executeReviewIntent({
      type: "notes/set-visibility",
      visible: true,
    });
    expect(visible.state.showAgentNotes).toBe(true);

    const updated = runtime.executeReviewIntent({
      type: "note/update-user",
      noteId: created.createdNote!.note.id,
      body: " updated ",
    });
    expect(updated.state.userNotes[0]!.note).toMatchObject({
      id: created.createdNote!.note.id,
      summary: "updated",
      createdAt: fixed.toISOString(),
      updatedAt: fixed.toISOString(),
    });
    const removed = runtime.executeReviewIntent({
      type: "note/remove-user",
      noteId: created.createdNote!.note.id,
    });
    expect(removed.changed).toBe(true);
    expect(removed.state.userNotes).toHaveLength(0);
    expect(removed.state.stateRevision).toBe(6);
    expect(publications).toBe(6);
    unsubscribe();
    runtime.dispose();
  });

  test("rejects stale and invalid direct intent targets without publishing", () => {
    const runtime = createReviewSessionRuntime(createBootstrap());
    const store = runtime.getSnapshot().store;
    const before = store.getSnapshot();
    let publications = 0;
    const unsubscribe = store.subscribePublished(() => {
      publications += 1;
    });
    const file = before.document.files[0]!;
    const line = file.hunks[0]!.additionStart;

    expect(() =>
      runtime.executeReviewIntent(
        { type: "filter/set", filter: "alpha" },
        { mode: "generation", expectedGeneration: "generation:retired" },
      ),
    ).toThrow("stale-generation");
    expect(() =>
      runtime.executeReviewIntent(
        { type: "filter/set", filter: "alpha" },
        {
          mode: "revision",
          expectedGeneration: before.documentGeneration,
          expectedStateRevision: before.stateRevision + 1,
        },
      ),
    ).toThrow("stale-revision");
    expect(() =>
      runtime.executeReviewIntent({
        type: "selection/set-line",
        fileKey: file.key,
        hunkIndex: 0,
        side: "new",
        line: 999,
      }),
    ).toThrow(/not backed/);
    if (file.hunks.length > 1) {
      expect(() =>
        runtime.executeReviewIntent({
          type: "selection/set-line",
          fileKey: file.key,
          hunkIndex: 1,
          side: "new",
          line,
        }),
      ).toThrow(/belongs to hunk/);
    }
    expect(store.getSnapshot()).toBe(before);
    expect(publications).toBe(0);
    unsubscribe();
    runtime.dispose();
  });

  test("does not consume user identities on semantic or attached preflight failures", async () => {
    const fixed = new Date("2026-03-01T00:00:00.000Z");
    const semanticRuntime = createReviewSessionRuntime(createBootstrap(), {
      deps: { nowImpl: () => fixed },
    });
    const semanticState = semanticRuntime.getSnapshot().store.getSnapshot();
    const semanticFile = semanticState.document.files[0]!;
    const semanticTarget = {
      fileKey: semanticFile.key,
      hunkIndex: 0,
      side: "new" as const,
      line: semanticFile.hunks[0]!.additionStart,
    };

    expect(() =>
      semanticRuntime.executeReviewIntent({
        type: "note/create-user",
        ...semanticTarget,
        line: 999,
        body: "invalid",
      }),
    ).toThrow(/not backed/);
    expect(
      semanticRuntime.executeReviewIntent({
        type: "note/create-user",
        ...semanticTarget,
        body: "first valid note",
      }).createdNote?.note.id,
    ).toBe(`user:${fixed.getTime()}-1`);
    semanticRuntime.dispose();

    const attachedHost = createHeadlessHostClient(createBootstrap());
    const attachedRuntime = createReviewSessionRuntime(createNoteHeavyBootstrap(), {
      deps: { ...createReloadDeps(), nowImpl: () => fixed },
      hostClient: attachedHost.hostClient,
    });
    const attachedBefore = attachedRuntime.getSnapshot().store.getSnapshot();
    const attachedFile = attachedBefore.document.files[0]!;
    const attachedTarget = {
      fileKey: attachedFile.key,
      hunkIndex: 0,
      side: "new" as const,
      line: attachedFile.hunks[0]!.additionStart,
    };

    expect(() =>
      attachedRuntime.executeReviewIntent({
        type: "note/create-user",
        ...attachedTarget,
        body: "rejected by attached producer preflight",
      }),
    ).toThrow(/metadata limit|websocket envelope limit/);
    expect(attachedRuntime.getSnapshot().store.getSnapshot()).toBe(attachedBefore);

    await attachedRuntime.reload("manual", reloadInput("after-preflight-failure"), {
      resetApp: false,
    });
    const reloadedState = attachedRuntime.getSnapshot().store.getSnapshot();
    const reloadedFile = reloadedState.document.files[0]!;
    expect(
      attachedRuntime.executeReviewIntent({
        type: "note/create-user",
        fileKey: reloadedFile.key,
        hunkIndex: 0,
        side: "new",
        line: reloadedFile.hunks[0]!.additionStart,
        body: "first valid note after reload",
      }).createdNote?.note.id,
    ).toBe(`user:${fixed.getTime()}-1`);
    attachedRuntime.dispose();
  });

  test("allocates fixed-clock user identities once across collisions and calls", () => {
    const fixed = new Date("2026-03-04T05:06:07.000Z");
    const baseId = `user:${fixed.getTime()}-1`;
    const bootstrap = createBootstrap({
      changeset: {
        ...createBootstrap().changeset,
        files: [
          createTestDiffFile({
            path: "alpha.ts",
            agent: {
              path: "alpha.ts",
              annotations: [{ id: baseId, newRange: [1, 1], summary: "collision" }],
            },
          }),
        ],
      },
    });
    const runtime = createReviewSessionRuntime(bootstrap, { deps: { nowImpl: () => fixed } });
    const state = runtime.getSnapshot().store.getSnapshot();
    const file = state.document.files[0]!;
    const target = {
      fileKey: file.key,
      hunkIndex: 0,
      side: "new" as const,
      line: file.hunks[0]!.additionStart,
    };

    const first = runtime.executeReviewIntent({
      type: "note/create-user",
      ...target,
      body: "first",
    });
    const second = runtime.executeReviewIntent({
      type: "note/create-user",
      ...target,
      body: "second",
    });
    expect(first.createdNote?.note.id).toBe(`${baseId}:1`);
    expect(second.createdNote?.note.id).toBe(`user:${fixed.getTime()}-2`);
    expect(
      runtime
        .getSnapshot()
        .store.getSnapshot()
        .userNotes.map((entry) => entry.note.id),
    ).toEqual([`${baseId}:1`, `user:${fixed.getTime()}-2`]);
    runtime.dispose();
  });

  test("preserves markup tri-state and rejects disabled STML before publication", () => {
    const fixed = new Date("2026-04-05T06:07:08.000Z");
    const experimentalBootstrap = createBootstrap({
      input: { kind: "vcs", staged: false, options: { experimental: true } },
    });
    const runtime = createReviewSessionRuntime(experimentalBootstrap, {
      deps: { nowImpl: () => fixed },
    });
    const initial = runtime.getSnapshot().store.getSnapshot();
    const file = initial.document.files[0]!;
    const created = runtime.executeReviewIntent({
      type: "note/create-user",
      fileKey: file.key,
      hunkIndex: 0,
      side: "new",
      line: file.hunks[0]!.additionStart,
      body: "markup",
      markup: "<strong>markup</strong>",
    });
    const noteId = created.createdNote!.note.id;
    expect(created.createdNote?.note.markup).toBe("<strong>markup</strong>");
    expect(
      runtime.executeReviewIntent({ type: "note/update-user", noteId, body: "preserve" }).state
        .userNotes[0]!.note.markup,
    ).toBe("<strong>markup</strong>");
    expect(
      runtime.executeReviewIntent({
        type: "note/update-user",
        noteId,
        body: "clear",
        markup: "   ",
      }).state.userNotes[0]!.note.markup,
    ).toBeUndefined();
    runtime.dispose();

    const disabled = createReviewSessionRuntime(createBootstrap());
    const disabledBefore = disabled.getSnapshot().store.getSnapshot();
    const disabledFile = disabledBefore.document.files[0]!;
    expect(() =>
      disabled.executeReviewIntent({
        type: "note/create-user",
        fileKey: disabledFile.key,
        hunkIndex: 0,
        side: "new",
        line: disabledFile.hunks[0]!.additionStart,
        body: "blocked",
        markup: "<strong>blocked</strong>",
      }),
    ).toThrow(/STML markup is disabled/);
    expect(disabled.getSnapshot().store.getSnapshot()).toBe(disabledBefore);
    disabled.dispose();
  });

  test("creates equivalent canonical TUI and browser notes through one runtime sequence", async () => {
    const fixed = new Date("2026-04-06T07:08:09.000Z");
    const extensions = createEmptyExtensionLoadResult(process.cwd());
    const createdEvents: string[] = [];
    extensions.registry.eventHandlers.note_created.push({
      extensionId: "capture",
      handler: ({ note }) => {
        createdEvents.push(note.id);
      },
    });
    const bootstrap = createBootstrap({ extensions });
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, {
      deps: { nowImpl: () => fixed },
      hostClient: host.hostClient,
    });
    const store = runtime.getSnapshot().store;
    const initial = store.getSnapshot();
    const file = initial.document.files[0]!;
    const line = file.hunks[0]!.additionStart;
    store.dispatch({
      type: "draft/start",
      expectedGeneration: initial.documentGeneration,
      draft: {
        id: "draft:tui",
        fileKey: file.key,
        hunkIndex: 0,
        side: "new",
        line,
        newRange: [line, line],
        body: "Shared note body",
      },
    });

    const tui = runtime.executeReviewIntent({ type: "note/create-user", consumeDraft: true });
    const afterTui = store.getSnapshot();
    const browser = await host.dispatchCommand({
      type: "command",
      requestId: "browser-equivalent-note",
      command: "apply_review_action",
      input: {
        sessionId: host.hostClient.getRegistration().sessionId,
        generation: afterTui.documentGeneration,
        expectedStateRevision: afterTui.stateRevision,
        action: {
          type: "notes/create-user",
          note: {
            fileKey: file.key,
            hunkIndex: 0,
            side: "new",
            line,
            body: "Shared note body",
          },
        },
      },
    });
    expect(browser).toMatchObject({ kind: "review-action" });

    const [tuiNote, browserNote] = store.getSnapshot().userNotes;
    expect(tui.createdNote).toBe(tuiNote);
    expect(tuiNote?.note.id).toBe(`user:${fixed.getTime()}-1`);
    expect(browserNote?.note.id).toBe(`user:${fixed.getTime()}-2`);
    const withoutIdentity = (entry: NonNullable<typeof tuiNote>) => ({
      ...entry,
      note: { ...entry.note, id: "<surface-independent>" },
    });
    expect(withoutIdentity(browserNote!)).toEqual(withoutIdentity(tuiNote!));
    expect(createdEvents).toEqual([tuiNote!.note.id, browserNote!.note.id]);
    runtime.dispose();
  });

  test("emits browser-created user notes once after commit and isolates handler failures", async () => {
    const extensions = createEmptyExtensionLoadResult(process.cwd());
    const events: Array<{ id: string; body: string }> = [];
    extensions.registry.eventHandlers.note_created.push(
      {
        extensionId: "capture",
        handler: ({ note }) => {
          events.push({ id: note.id, body: note.body });
        },
      },
      {
        extensionId: "failure",
        handler: () => {
          throw new Error("handler failed");
        },
      },
    );
    const bootstrap = createBootstrap({ extensions });
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const before = runtime.getSnapshot().store.getSnapshot();
    const file = before.document.files[0]!;
    const result = await host.dispatchCommand({
      type: "command",
      requestId: "browser-created-event",
      command: "apply_review_action",
      input: {
        sessionId: host.hostClient.getRegistration().sessionId,
        generation: before.documentGeneration,
        expectedStateRevision: before.stateRevision,
        action: {
          type: "notes/create-user",
          note: {
            fileKey: file.key,
            hunkIndex: 0,
            side: "new",
            line: file.hunks[0]!.additionStart,
            body: "Browser event",
          },
        },
      },
    });
    expect(result).toMatchObject({ kind: "review-action" });
    const stored = runtime.getSnapshot().store.getSnapshot().userNotes[0]!;
    expect(events).toEqual([{ id: stored.note.id, body: "Browser event" }]);
    expect(runtime.getSnapshot().store.getSnapshot().userNotes).toHaveLength(1);

    const revision = runtime.getSnapshot().store.getSnapshot().stateRevision;
    const invalid = await host.dispatchCommand({
      type: "command",
      requestId: "browser-invalid-event",
      command: "apply_review_action",
      input: {
        sessionId: host.hostClient.getRegistration().sessionId,
        generation: before.documentGeneration,
        expectedStateRevision: revision,
        action: {
          type: "notes/create-user",
          note: {
            fileKey: file.key,
            hunkIndex: 0,
            side: "new",
            line: 999,
            body: "invalid",
          },
        },
      },
    });
    expect(invalid).toMatchObject({ kind: "review-error", error: { code: "invalid-action" } });
    expect(events).toHaveLength(1);
    runtime.dispose();
  });

  test("does not emit created-note events when attached publication preflight rejects", async () => {
    const extensions = createEmptyExtensionLoadResult(process.cwd());
    let eventCount = 0;
    extensions.registry.eventHandlers.note_created.push({
      extensionId: "capture",
      handler: () => {
        eventCount += 1;
      },
    });
    const bootstrap = { ...createNoteHeavyBootstrap(), extensions };
    const host = createHeadlessHostClient(createBootstrap());
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const before = runtime.getSnapshot().store.getSnapshot();
    const file = before.document.files[0]!;
    const result = await host.dispatchCommand({
      type: "command",
      requestId: "preflight-created-event",
      command: "apply_review_action",
      input: {
        sessionId: host.hostClient.getRegistration().sessionId,
        generation: before.documentGeneration,
        expectedStateRevision: before.stateRevision,
        action: {
          type: "notes/create-user",
          note: {
            fileKey: file.key,
            hunkIndex: 0,
            side: "new",
            line: file.hunks[0]!.additionStart,
            body: "blocked by preflight",
          },
        },
      },
    });
    expect(result).toMatchObject({ kind: "review-error", error: { code: "invalid-action" } });
    expect(runtime.getSnapshot().store.getSnapshot()).toBe(before);
    expect(eventCount).toBe(0);
    runtime.dispose();
  });

  test("rejects a near-limit note before publishing state or revision", async () => {
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const before = runtime.getSnapshot().store.getSnapshot();
    const updatesBefore = host.updated.length;
    const file = before.document.files[0]!;
    const result = await host.dispatchCommand({
      type: "command",
      requestId: "oversized-note",
      command: "apply_review_action",
      input: {
        sessionId: host.hostClient.getRegistration().sessionId,
        generation: before.documentGeneration,
        expectedStateRevision: before.stateRevision,
        action: {
          type: "notes/create-user",
          note: {
            fileKey: file.key,
            hunkIndex: 0,
            side: "new",
            line: file.hunks[0]!.additionStart,
            body: "x".repeat(256 * 1024),
          },
        },
      },
    });
    expect(result).toMatchObject({ kind: "review-error", error: { code: "invalid-action" } });
    expect(runtime.getSnapshot().store.getSnapshot()).toBe(before);
    expect(host.updated).toHaveLength(updatesBefore);
    runtime.dispose();
  });

  test("keeps attached note-heavy producers bounded and atomic", () => {
    const bootstrap = createNoteHeavyBootstrap();
    // Attach a valid producer seam directly so this test reaches next-snapshot validation rather
    // than failing the intentionally oversized initial registration first.
    const host = createHeadlessHostClient(createBootstrap());
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const store = runtime.getSnapshot().store;
    const before = store.getSnapshot();

    expect(() => store.dispatch({ type: "notes/set-visibility", visible: true })).toThrow(
      /producer message metadata limit|websocket envelope limit/,
    );
    expect(store.getSnapshot()).toBe(before);
    expect(host.updated).toHaveLength(0);
    runtime.dispose();
  });

  test("rejects an oversized direct terminal note before state or revision publication", () => {
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const store = runtime.getSnapshot().store;
    const before = store.getSnapshot();
    const semantic = before.document.files[0]!;
    const sourceFile = bootstrap.changeset.files[0]!;
    const updatesBefore = host.updated.length;
    const oversizedSummary = "x".repeat(256 * 1024);

    expect(() =>
      store.dispatch({
        type: "notes/add-user",
        expectedGeneration: before.documentGeneration,
        note: {
          note: projectReviewNote({
            annotation: {
              id: "user:terminal-oversized",
              source: "user",
              summary: oversizedSummary,
              newRange: [semantic.hunks[0]!.additionStart, semantic.hunks[0]!.additionStart],
            },
            fileKey: semantic.key,
            hunks: sourceFile.metadata.hunks,
            origin: "user",
            editable: true,
          }),
          contextDigest: reviewLineContextDigest(semantic, "new", semantic.hunks[0]!.additionStart),
          resolution: "active",
        },
      }),
    ).toThrow(/metadata limit|message metadata limit|websocket envelope limit/);
    expect(store.getSnapshot()).toBe(before);
    expect(store.getSnapshot().stateRevision).toBe(before.stateRevision);
    expect(host.updated).toHaveLength(updatesBefore);
    runtime.dispose();
  });

  test("emits a later expanded-gap note with the validated owning hunk", async () => {
    const beforeLines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
    const afterLines = [...beforeLines];
    afterLines[9] = "line 10 changed";
    afterLines[39] = "line 40 changed";
    const sourceText = lines(...afterLines);
    const extensions = createEmptyExtensionLoadResult(process.cwd());
    const events: Array<{ hunkIndex: number; body: string }> = [];
    extensions.registry.eventHandlers.note_created.push({
      extensionId: "capture-expanded-owner",
      handler: ({ note }) => {
        events.push({ hunkIndex: note.hunkIndex, body: note.body });
      },
    });
    const file = createTestDiffFile({
      id: "expanded-owner",
      path: "expanded-owner.ts",
      before: lines(...beforeLines),
      after: sourceText,
      context: 3,
      sourceFetcher: createTestSourceFetcher(() => sourceText),
    });
    const runtime = createReviewSessionRuntime(
      createBootstrap({
        changeset: { ...createBootstrap().changeset, files: [file] },
        extensions,
      }),
    );
    const semantic = runtime.getSnapshot().projection.document.files[0]!;

    await runtime.toggleSourceGap(semantic.key, "before:1");
    const state = runtime.getSnapshot().store.getSnapshot();
    const gap = state.expandedGaps.find(
      (candidate) => candidate.fileKey === semantic.key && candidate.gapId === "before:1",
    )!;
    runtime.executeReviewIntent({
      type: "note/create-user",
      fileKey: semantic.key,
      hunkIndex: 1,
      side: gap.side,
      line: gap.newRange[0],
      body: "Later expanded rationale",
      expandedLineProof: { gapId: gap.gapId, sourceIdentity: gap.sourceIdentity },
    });

    expect(runtime.getSnapshot().store.getSnapshot().userNotes[0]?.note.anchor).toMatchObject({
      intersectingHunkIndices: [],
      ownerHunkIndex: 1,
    });
    expect(events).toEqual([{ hunkIndex: 1, body: "Later expanded rationale" }]);
    runtime.dispose();
  });

  test("owns source loading, deduplicates fetches, and rejects retired completions", async () => {
    const deferred = createTestDeferred<string | null>();
    let reads = 0;
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const after = [...lines];
    after[15] = "changed";
    const sourceFetcher = {
      cacheKey: "source:test",
      getFullText: async () => {
        reads += 1;
        return deferred.promise;
      },
    };
    const file = createTestDiffFile({
      id: "source",
      path: "source.ts",
      before: `${lines.join("\n")}\n`,
      after: `${after.join("\n")}\n`,
      sourceFetcher,
    });
    const bootstrap = createBootstrap({
      changeset: { ...createBootstrap().changeset, files: [file] },
    });
    const runtime = createReviewSessionRuntime(bootstrap);
    const semantic = runtime.getSnapshot().projection.document.files[0]!;
    const first = runtime.toggleSourceGap(semantic.key, "before:0");
    expect(runtime.getSnapshot().store.getSnapshot().sourceStatusByFileKey[semantic.key]).toEqual({
      kind: "loading",
    });
    const second = runtime.toggleSourceGap(semantic.key, "before:0");
    expect(reads).toBe(1);
    deferred.resolve(`${after.join("\n")}\n`);
    await Promise.all([first, second]);
    expect(
      runtime.getSnapshot().store.getSnapshot().sourceStatusByFileKey[semantic.key]?.kind,
    ).toBe("loaded");
    const sourceId = semantic.sourceResourceIds.new!;
    expect(runtime.getResource(sourceId)).toContain("changed");
    runtime.dispose();
  });

  test("loads only old source for valid deleted-side gaps and rejects whole-file deletion gaps", async () => {
    const sides: string[] = [];
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const changed = [...lines];
    changed[15] = "changed";
    const deletedMarked = createTestDiffFile({
      id: "deleted-marked",
      path: "deleted-marked.ts",
      before: `${lines.join("\n")}\n`,
      after: `${changed.join("\n")}\n`,
      sourceFetcher: {
        cacheKey: "deleted-marked-source",
        getFullText: async (side) => {
          sides.push(side);
          return `${lines.join("\n")}\n`;
        },
      },
    });
    deletedMarked.metadata.type = "deleted";
    const runtime = createReviewSessionRuntime(
      createBootstrap({
        changeset: { ...createBootstrap().changeset, files: [deletedMarked] },
      }),
    );
    const semantic = runtime.getSnapshot().projection.document.files[0]!;
    await runtime.toggleSourceGap(semantic.key, "before:0");
    expect(sides).toEqual(["old"]);
    expect(runtime.getResource(semantic.sourceResourceIds.old!)).toContain("line 1");
    expect(runtime.getResource(semantic.sourceResourceIds.new!)).toBeUndefined();
    runtime.dispose();

    let wholeFileReads = 0;
    const wholeDeletion = createTestDiffFile({
      id: "whole-deletion",
      path: "whole-deletion.ts",
      before: `${lines.join("\n")}\n`,
      after: "",
      sourceFetcher: {
        cacheKey: "whole-deletion-source",
        getFullText: async () => {
          wholeFileReads += 1;
          return `${lines.join("\n")}\n`;
        },
      },
    });
    const deletionRuntime = createReviewSessionRuntime(
      createBootstrap({
        changeset: { ...createBootstrap().changeset, files: [wholeDeletion] },
      }),
    );
    const deletedFile = deletionRuntime.getSnapshot().projection.document.files[0]!;
    expect(reviewGapAddress(deletedFile, "trailing:0")).toBeUndefined();
    await expect(deletionRuntime.toggleSourceGap(deletedFile.key, "trailing:0")).rejects.toThrow(
      "invalid",
    );
    expect(wholeFileReads).toBe(0);
    deletionRuntime.dispose();
  });

  test("routes legacy agent comments directly and publishes each exactly once", async () => {
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const result = await host.dispatchCommand({
      type: "command",
      requestId: "agent-comment",
      command: "comment",
      input: {
        sessionId: host.hostClient.getRegistration().sessionId,
        filePath: "alpha.ts",
        hunkIndex: 0,
        summary: "Agent rationale",
        reveal: true,
      },
    });
    expect(result).toMatchObject({ commentId: "mcp:agent-comment" });
    expect(runtime.getSnapshot().store.getSnapshot().liveNotes).toHaveLength(1);
    expect(host.updated.at(-1)?.state.liveComments).toHaveLength(1);
    runtime.dispose();
  });

  test("removes compatible live notes through browser intents and preserves cached retries", async () => {
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const sessionId = host.hostClient.getRegistration().sessionId;
    const comment = {
      type: "command",
      requestId: "removable-live-note",
      command: "comment",
      input: {
        sessionId,
        filePath: "alpha.ts",
        hunkIndex: 0,
        summary: "Removable agent note",
        reveal: false,
      },
    } as const;
    const created = await host.dispatchCommand(comment);
    expect(created).toMatchObject({ commentId: "mcp:removable-live-note" });
    const liveNote = runtime.getSnapshot().store.getSnapshot().liveNotes[0]!;
    expect(liveNote.note).toMatchObject({ origin: "live-agent", editable: false });
    const retainedIds = (runtime as unknown as { sessionCommentIds: Map<string, string> })
      .sessionCommentIds;
    expect(retainedIds.get(comment.requestId)).toBe(liveNote.note.id);

    const beforeRemoval = runtime.getSnapshot().store.getSnapshot();
    const removed = await host.dispatchCommand({
      type: "command",
      requestId: "browser-remove-live",
      command: "apply_review_action",
      input: {
        sessionId,
        generation: beforeRemoval.documentGeneration,
        expectedStateRevision: beforeRemoval.stateRevision,
        action: { type: "notes/remove-live", noteId: liveNote.note.id },
      },
    });
    expect(removed).toMatchObject({ kind: "review-action" });
    expect(runtime.getSnapshot().store.getSnapshot().liveNotes).toHaveLength(0);
    expect(retainedIds.has(comment.requestId)).toBe(false);

    // Existing retry results remain idempotent and do not recreate a removed note.
    expect(await host.dispatchCommand(comment)).toEqual(created);
    expect(runtime.getSnapshot().store.getSnapshot().liveNotes).toHaveLength(0);

    const current = runtime.getSnapshot().store.getSnapshot();
    const locked = {
      ...liveNote,
      note: {
        ...liveNote.note,
        id: "sidecar:locked",
        origin: "sidecar" as const,
        editable: false,
      },
    };
    runtime.getSnapshot().store.dispatch({
      type: "notes/add-live",
      expectedGeneration: current.documentGeneration,
      notes: [locked],
    });
    const lockedState = runtime.getSnapshot().store.getSnapshot();
    const rejected = await host.dispatchCommand({
      type: "command",
      requestId: "browser-remove-locked-live",
      command: "apply_review_action",
      input: {
        sessionId,
        generation: lockedState.documentGeneration,
        expectedStateRevision: lockedState.stateRevision,
        action: { type: "notes/remove-live", noteId: locked.note.id },
      },
    });
    expect(rejected).toMatchObject({
      kind: "review-error",
      error: { code: "invalid-action" },
    });
    expect(runtime.getSnapshot().store.getSnapshot()).toBe(lockedState);
    runtime.dispose();
  });

  test("allocates a stable generated id when an immutable note collides", async () => {
    const file = createTestDiffFile({
      path: "alpha.ts",
      agent: {
        path: "alpha.ts",
        annotations: [{ id: "mcp:collision", source: "ai", summary: "Static collision" }],
      },
    });
    const bootstrap = createBootstrap({
      changeset: { ...createBootstrap().changeset, files: [file] },
    });
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const command = {
      type: "command",
      requestId: "collision",
      command: "comment",
      input: {
        sessionId: host.hostClient.getRegistration().sessionId,
        filePath: "alpha.ts",
        hunkIndex: 0,
        summary: "Mutable comment",
        reveal: false,
      },
    } as const;

    const first = await host.dispatchCommand(command);
    const retry = await host.dispatchCommand(command);
    expect(first).toMatchObject({ commentId: "mcp:collision:1" });
    expect(retry).toEqual(first);
    expect(runtime.getSnapshot().store.getSnapshot().liveNotes).toHaveLength(1);
    expect(runtime.getSnapshot().store.getSnapshot().liveNotes[0]!.note.id).toBe("mcp:collision:1");
    runtime.dispose();
  });

  test("allocates a stable generated id when an existing mutable note collides", async () => {
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const state = runtime.getSnapshot().store.getSnapshot();
    const semantic = state.document.files[0]!;
    runtime.getSnapshot().store.dispatch({
      type: "notes/add-live",
      expectedGeneration: state.documentGeneration,
      notes: [
        {
          note: projectReviewNote({
            annotation: {
              id: "mcp:mutable-collision",
              source: "mcp",
              newRange: [1, 1],
              summary: "Existing mutable note",
            },
            fileKey: semantic.key,
            hunks: bootstrap.changeset.files[0]!.metadata.hunks,
            origin: "live-agent",
          }),
          contextDigest: reviewLineContextDigest(semantic, "new", 1),
          resolution: "active",
        },
      ],
    });
    const command = {
      type: "command",
      requestId: "mutable-collision",
      command: "comment",
      input: {
        sessionId: host.hostClient.getRegistration().sessionId,
        filePath: "alpha.ts",
        hunkIndex: 0,
        summary: "Generated mutable note",
        reveal: false,
      },
    } as const;

    const first = await host.dispatchCommand(command);
    const retry = await host.dispatchCommand(command);
    expect(first).toMatchObject({ commentId: "mcp:mutable-collision:1" });
    expect(retry).toEqual(first);
    expect(runtime.getSnapshot().store.getSnapshot().liveNotes).toHaveLength(2);
    runtime.dispose();
  });

  test("returns a cached single result after reload orphaning even when a retry retargets", async () => {
    const bootstrap = createBootstrap();
    const beta = createTestDiffFile({ id: "beta", path: "beta.ts" });
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, {
      hostClient: host.hostClient,
      deps: createReloadDeps(async (input, cwd, extensions) => ({
        ...createBootstrap(),
        input,
        reloadContext: { cwd },
        extensions,
        changeset: { ...createBootstrap().changeset, files: [beta], title: "beta reload" },
      })),
    });
    const command = (filePath: string) =>
      host.dispatchCommand({
        type: "command",
        requestId: "cached-single",
        command: "comment",
        input: {
          sessionId: host.hostClient.getRegistration().sessionId,
          filePath,
          hunkIndex: 0,
          summary: `target ${filePath}`,
          reveal: false,
        },
      });

    const applied = await command("alpha.ts");
    await runtime.reload("manual", reloadInput("beta"), { resetApp: false });
    expect(runtime.getSnapshot().store.getSnapshot().liveNotes[0]?.resolution).toBe("orphaned");
    const beforeRetry = runtime.getSnapshot().store.getSnapshot();
    const updatesBeforeRetry = host.updated.length;
    const retry = await command("beta.ts");

    expect(retry).toEqual(applied);
    expect(retry).toMatchObject({ filePath: "alpha.ts" });
    expect(runtime.getSnapshot().store.getSnapshot()).toBe(beforeRetry);
    expect(host.updated).toHaveLength(updatesBeforeRetry);
    runtime.dispose();
  });

  test("prepares comment batches atomically and keeps retries idempotent", async () => {
    const file = createTestDiffFile({
      path: "alpha.ts",
      agent: {
        path: "alpha.ts",
        annotations: [{ id: "mcp:valid-batch:0", source: "ai", summary: "Batch collision" }],
      },
    });
    const bootstrap = createBootstrap({
      changeset: { ...createBootstrap().changeset, files: [file] },
    });
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const before = runtime.getSnapshot().store.getSnapshot();
    const batch = (requestId: string, comments: Array<Record<string, unknown>>) =>
      host.dispatchCommand({
        type: "command",
        requestId,
        command: "comment_batch",
        input: {
          sessionId: host.hostClient.getRegistration().sessionId,
          comments,
          revealMode: "none",
        },
      } as unknown as HunkSessionServerMessage);

    await expect(
      batch("invalid-batch", [
        { filePath: "alpha.ts", summary: "first", hunkIndex: 0 },
        { filePath: "missing.ts", summary: "second", hunkIndex: 0 },
      ]),
    ).rejects.toThrow("No diff file matches missing.ts");
    expect(runtime.getSnapshot().store.getSnapshot()).toBe(before);

    const result = await batch("valid-batch", [
      { filePath: "alpha.ts", summary: "first", hunkIndex: 0 },
      { filePath: "alpha.ts", summary: "second", hunkIndex: 0 },
    ]);
    expect(result).toMatchObject({
      applied: [{ commentId: "mcp:valid-batch:0:1" }, { commentId: "mcp:valid-batch:1" }],
    });
    const committed = runtime.getSnapshot().store.getSnapshot();
    expect(committed.stateRevision).toBe(before.stateRevision + 1);
    expect(committed.liveNotes.map((entry) => entry.note.summary)).toEqual(["first", "second"]);
    const retry = await batch("valid-batch", [
      { filePath: "alpha.ts", summary: "first", hunkIndex: 0 },
      { filePath: "alpha.ts", summary: "second", hunkIndex: 0 },
    ]);
    expect(retry).toEqual(result);
    expect(runtime.getSnapshot().store.getSnapshot()).toBe(committed);
    runtime.dispose();
  });

  test("caches batch first-reveal results without repeating visibility, revision, or reveal", async () => {
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const batch = (filePath: string) =>
      host.dispatchCommand({
        type: "command",
        requestId: "cached-reveal-batch",
        command: "comment_batch",
        input: {
          sessionId: host.hostClient.getRegistration().sessionId,
          comments: [{ filePath, summary: `target ${filePath}`, hunkIndex: 0 }],
          revealMode: "first",
        },
      });

    const result = await batch("alpha.ts");
    const committed = runtime.getSnapshot().store.getSnapshot();
    const updatesAfterCommit = host.updated.length;
    expect(committed.showAgentNotes).toBe(true);
    expect(committed.reveal).toMatchObject({ kind: "hunk", scrollToNote: true });

    const retry = await batch("missing.ts");
    expect(retry).toEqual(result);
    expect(runtime.getSnapshot().store.getSnapshot()).toBe(committed);
    expect(runtime.getSnapshot().store.getSnapshot().stateRevision).toBe(committed.stateRevision);
    expect(runtime.getSnapshot().store.getSnapshot().reveal).toEqual(committed.reveal);
    expect(host.updated).toHaveLength(updatesAfterCommit);
    runtime.dispose();
  });

  test("bounds applied comment retries with least-recently-used eviction", async () => {
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    const comment = (requestId: string, filePath = "alpha.ts") =>
      host.dispatchCommand({
        type: "command",
        requestId,
        command: "comment",
        input: {
          sessionId: host.hostClient.getRegistration().sessionId,
          filePath,
          hunkIndex: 0,
          summary: requestId,
          reveal: false,
        },
      });

    for (let index = 0; index < 256; index += 1) await comment(`bounded:${index}`);
    await expect(comment("bounded:0", "missing.ts")).resolves.toMatchObject({
      commentId: "mcp:bounded:0",
      filePath: "alpha.ts",
    });
    await comment("bounded:256");
    await expect(comment("bounded:0", "missing.ts")).resolves.toMatchObject({
      commentId: "mcp:bounded:0",
      filePath: "alpha.ts",
    });
    await expect(comment("bounded:1", "missing.ts")).rejects.toThrow(
      "No diff file matches missing.ts",
    );
    expect(runtime.getSnapshot().store.getSnapshot().liveNotes).toHaveLength(257);
    runtime.dispose();
  });

  test("returns terminal width-sensitive STML degradation feedback", async () => {
    const base = createBootstrap();
    const bootstrap = createBootstrap({
      input: { ...base.input, options: { ...base.input.options, experimental: true } },
    });
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, { hostClient: host.hostClient });
    runtime.setSessionRendererFields({
      noteMarkupWidth: 42,
      validateMarkup: (markup, width) => [`degraded ${markup} at ${width}`],
    });
    const result = await host.dispatchCommand({
      type: "command",
      requestId: "stml-feedback",
      command: "comment",
      input: {
        sessionId: host.hostClient.getRegistration().sessionId,
        filePath: "alpha.ts",
        hunkIndex: 0,
        summary: "markup",
        markup: "<box>markup</box>",
        reveal: false,
      },
    });
    expect(result).toMatchObject({
      markupWidth: 42,
      markupNotes: ["degraded <box>markup</box> at 42"],
    });
    runtime.dispose();
  });

  test("reserves one asynchronous browser action per generation revision", async () => {
    const deferred = createTestDeferred<AppBootstrap>();
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, {
      hostClient: host.hostClient,
      deps: createReloadDeps(async () => deferred.promise),
    });
    const state = runtime.getSnapshot().store.getSnapshot();
    const action = (requestId: string) =>
      host.dispatchCommand({
        type: "command",
        requestId,
        command: "apply_review_action",
        input: {
          sessionId: host.hostClient.getRegistration().sessionId,
          generation: state.documentGeneration,
          expectedStateRevision: state.stateRevision,
          action: { type: "session/reload" },
        },
      });
    const first = action("reload-first");
    await Bun.sleep(0);
    const second = await action("reload-second");
    expect(second).toMatchObject({ kind: "review-error", error: { code: "stale-revision" } });
    const synchronous = await host.dispatchCommand({
      type: "command",
      requestId: "filter-during-reload",
      command: "apply_review_action",
      input: {
        sessionId: host.hostClient.getRegistration().sessionId,
        generation: state.documentGeneration,
        expectedStateRevision: state.stateRevision,
        action: { type: "filter/set", filter: "blocked" },
      },
    });
    expect(synchronous).toMatchObject({
      kind: "review-error",
      error: { code: "stale-revision" },
    });
    expect(runtime.getSnapshot().store.getSnapshot().filter).toBe("");
    deferred.resolve(createBootstrap());
    await expect(first).resolves.toMatchObject({ kind: "review-action" });
    expect(host.replaced).toHaveLength(1);
    runtime.dispose();
  });

  test("detached terminal reloads do not build broker-limited reconnect manifests", async () => {
    const oversized = createTestDiffFile({
      id: "oversized",
      path: "oversized.ts",
      agent: {
        path: "oversized.ts",
        summary: "x".repeat(4 * 1024 * 1024),
        annotations: [],
      },
    });
    const runtime = createReviewSessionRuntime(createBootstrap(), {
      deps: createReloadDeps(async (input, cwd, extensions) => ({
        ...createBootstrap(),
        input,
        reloadContext: { cwd },
        extensions,
        changeset: { ...createBootstrap().changeset, files: [oversized], title: "oversized" },
      })),
    });

    await expect(
      runtime.reload("manual", reloadInput("oversized"), { resetApp: false }),
    ).resolves.toMatchObject({ title: "oversized", fileCount: 1 });
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("oversized");
    runtime.dispose();
  });

  test("manual reload degrades an oversized replacement to unrestricted local review", async () => {
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, {
      hostClient: host.hostClient,
      deps: createReloadDeps(async (input, cwd, extensions) => ({
        ...createNoteHeavyBootstrap(),
        input,
        reloadContext: { cwd },
        extensions,
      })),
    });

    await expect(
      runtime.reload("manual", reloadInput("note-heavy"), { resetApp: false }),
    ).resolves.toMatchObject({ fileCount: 1 });
    expect(host.replaced).toHaveLength(0);
    expect(host.getStopCount()).toBe(1);
    expect(host.getBridge()).toBeNull();
    expect(runtime.getSnapshot().notice).toContain("reviewing locally");
    const store = runtime.getSnapshot().store;
    expect(() => store.dispatch({ type: "notes/set-visibility", visible: true })).not.toThrow();
    expect(store.getSnapshot()).toMatchObject({ showAgentNotes: true });
    runtime.dispose();
  });

  test("manual reload atomically replaces bootstrap, resources, and reconciled store", async () => {
    const runtime = createReviewSessionRuntime(createBootstrap(), {
      deps: createReloadDeps(),
      rawInput: reloadInput("manual-title"),
    });
    const previous = runtime.getSnapshot();
    const previousCanonicalId = previous.projection.document.files[0]!.canonicalResourceId;
    expect(previous.projection.resourceContents[previousCanonicalId]).toBeUndefined();
    previous.store.dispatch({ type: "filter/set", filter: "alpha" });

    await runtime.reload("manual", reloadInput("manual-title"), { resetApp: false });
    const next = runtime.getSnapshot();

    expect(next.bootstrap.changeset.title).toBe("manual-title");
    expect(next.projection.document.title).toBe("manual-title");
    expect(next.store).not.toBe(previous.store);
    expect(next.store.getSnapshot().filter).toBe("alpha");
    expect(next.store.getSnapshot().document).toBe(next.projection.document);
    const nextCanonicalId = next.projection.document.files[0]!.canonicalResourceId;
    expect(next.projection.resourceContents[nextCanonicalId]).toBeUndefined();
    expect(runtime.getResource(previousCanonicalId)).toBeUndefined();
    expect(JSON.parse(runtime.getResource(nextCanonicalId)!)).toEqual(
      next.projection.document.files[0],
    );
    expect(next.projection.resourceContents[nextCanonicalId]).toBeUndefined();
    runtime.dispose();
  });

  test("failed reload preflight preserves active extensions, trust eligibility, watch, and broker state", async () => {
    const activeExtensions = createEmptyExtensionLoadResult(process.cwd());
    const bootstrap = createBootstrap({
      extensions: activeExtensions,
      input: { kind: "vcs", staged: false, options: { watch: true } },
    });
    const watch = createWatchTestRuntime();
    const failedExtensions = createEmptyExtensionLoadResult(process.cwd());
    failedExtensions.pendingTrustRepoRoot = process.cwd();
    const validExtensions = createEmptyExtensionLoadResult(process.cwd());
    validExtensions.pendingTrustRepoRoot = process.cwd();
    let extensionLoads = 0;
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, {
      hostClient: host.hostClient,
      watchRuntime: watch.runtime,
      deps: {
        ...createReloadDeps(async (input, cwd, extensions) => ({
          ...createBootstrap(),
          input,
          reloadContext: { cwd },
          extensions,
          changeset: {
            ...createBootstrap().changeset,
            title: extensionLoads === 1 ? "x".repeat(5 * 1024 * 1024) : "validated reload",
          },
        })),
        loadStartupExtensionsImpl: async () => {
          extensionLoads += 1;
          return extensionLoads === 1 ? failedExtensions : validExtensions;
        },
      },
    });
    runtime.start();
    const before = runtime.getSnapshot();
    const updatesBefore = host.updated.length;
    expect(watch.sources).toHaveLength(1);

    await expect(
      runtime.reload("daemon", reloadInput("invalid"), {
        resetApp: false,
        reloadExtensions: true,
      }),
    ).rejects.toThrow(/metadata limit|websocket envelope limit/);
    expect(runtime.getSnapshot()).toBe(before);
    expect(runtime.getSnapshot().extensions).toBe(activeExtensions);
    expect(activeExtensions.registry.eventBusPhase).not.toBe("closed");
    expect(failedExtensions.registry.eventBusPhase).toBe("closed");
    expect(watch.sources[0]!.closeCount).toBe(0);
    expect(host.updated).toHaveLength(updatesBefore);
    expect(host.replaced).toHaveLength(0);
    runtime.getSnapshot().store.dispatch({ type: "notes/set-visibility", visible: true });
    expect(host.updated.at(-1)?.state.showAgentNotes).toBe(true);

    await runtime.reload("manual", reloadInput("valid"), {
      resetApp: false,
      reloadExtensions: true,
    });
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("validated reload");
    expect(runtime.getSnapshot().extensions).toBe(validExtensions);
    expect(runtime.getSnapshot().trust.promptRepoRoot).toBe(process.cwd());
    expect(activeExtensions.registry.eventBusPhase).toBe("closed");
    expect(watch.sources[0]!.closeCount).toBe(1);
    expect(host.replaced).toHaveLength(1);
    runtime.dispose();
  });

  test("a slow older request cannot publish after a newer requested reload", async () => {
    const older = createTestDeferred<AppBootstrap>();
    const loadedThemes: string[] = [];
    const deps = createReloadDeps(async (input, cwd, extensions) => {
      const theme = input.options.theme ?? "none";
      loadedThemes.push(theme);
      if (theme === "older") return older.promise;
      return {
        ...createBootstrap(),
        input,
        reloadContext: { cwd },
        changeset: { ...createBootstrap().changeset, title: theme },
        extensions,
      };
    });
    const runtime = createReviewSessionRuntime(createBootstrap(), { deps });
    const olderResult = runtime.reload("daemon", reloadInput("older"), { resetApp: false });
    await Bun.sleep(0);
    const newerResult = runtime.reload("daemon", reloadInput("newer"), { resetApp: false });
    older.resolve({
      ...createBootstrap(),
      input: reloadInput("older"),
      changeset: { ...createBootstrap().changeset, title: "older" },
    });

    await Promise.all([olderResult, newerResult]);
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("newer");
    expect(runtime.getSnapshot().revision).toBe(1);
    expect(loadedThemes).toEqual(["older", "newer"]);
    await runtime.reload("manual", reloadInput("ignored-after-supersede"), { resetApp: false });
    expect(loadedThemes).toEqual(["older", "newer", "newer"]);
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("newer");
    runtime.dispose();
  });

  test("watch patch and agent-sidecar hints reload through the same serialized path", async () => {
    const watch = createWatchTestRuntime();
    let reloads = 0;
    let plannedInput: CliInput | undefined;
    const bootstrap = createBootstrap({
      input: {
        kind: "patch",
        file: "review.patch",
        text: "diff --git a/a b/a\n",
        options: { watch: true, agentContext: "review.agent.json" },
      },
    });
    const runtime = createReviewSessionRuntime(bootstrap, {
      deps: createReloadDeps(async (input, cwd, extensions) => {
        reloads += 1;
        return {
          ...bootstrap,
          input,
          reloadContext: { cwd },
          changeset: { ...bootstrap.changeset, title: `watch-${reloads}` },
          extensions,
        };
      }),
      watchRuntime: {
        ...watch.runtime,
        resolvePlan(input) {
          plannedInput = input;
          return {
            coverage: "hybrid",
            targets: [
              {
                kind: "directory-entries",
                directory: process.cwd(),
                entries: ["review.patch", "review.agent.json"],
                sources: ["content", "sidecar"],
              },
            ],
          };
        },
      },
    });
    runtime.start();
    watch.setSignature("signature:1");
    watch.emit();
    watch.advanceBy(200);
    for (let attempt = 0; attempt < 20 && reloads === 0; attempt++) await Bun.sleep(0);

    expect(plannedInput?.kind).toBe("patch");
    expect(plannedInput?.options.agentContext).toBe("review.agent.json");
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("watch-1");
    runtime.dispose();
  });

  test("executes the configured transform pipeline once for one winning generation", async () => {
    const transformPipeline = mock(async (input: CliInput, cwd: string) => ({
      ...createBootstrap(),
      input,
      reloadContext: { cwd },
      changeset: { ...createBootstrap().changeset, title: "transformed-once" },
    }));
    const runtime = createReviewSessionRuntime(createBootstrap(), {
      deps: createReloadDeps(transformPipeline),
    });

    await runtime.reload("manual", reloadInput("raw"), { resetApp: false });
    expect(transformPipeline).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().projection.document.title).toBe("transformed-once");
    runtime.dispose();
  });

  test("keeps repo extensions pending until a headless trust action approves and reloads", async () => {
    const extensions = createEmptyExtensionLoadResult(process.cwd());
    extensions.pendingTrustRepoRoot = process.cwd();
    const writeTrust = mock(() => "state.json");
    const discover = mock(async () => createEmptyExtensionLoadResult(process.cwd()));
    const runtime = createReviewSessionRuntime(createBootstrap({ extensions }), {
      deps: {
        ...createReloadDeps(),
        writeExtensionTrustImpl: writeTrust,
        loadStartupExtensionsImpl: discover,
      },
    });

    expect(runtime.getSnapshot().trust.promptRepoRoot).toBe(process.cwd());
    expect(runtime.getSnapshot().store.getSnapshot().trustPromptRepoRoot).toBe(process.cwd());
    expect(discover).toHaveBeenCalledTimes(0);
    await runtime.decideExtensionTrust("trusted");
    expect(writeTrust).toHaveBeenCalledWith(process.cwd(), "trusted");
    expect(discover).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().trust.promptRepoRoot).toBeNull();
    expect(runtime.getSnapshot().store.getSnapshot().trustPromptRepoRoot).toBeNull();
    runtime.dispose();

    const deniedExtensions = createEmptyExtensionLoadResult(process.cwd());
    deniedExtensions.pendingTrustRepoRoot = process.cwd();
    const deniedDiscover = mock(async () => createEmptyExtensionLoadResult(process.cwd()));
    const deniedRuntime = createReviewSessionRuntime(
      createBootstrap({ extensions: deniedExtensions }),
      {
        deps: {
          ...createReloadDeps(),
          writeExtensionTrustImpl: writeTrust,
          loadStartupExtensionsImpl: deniedDiscover,
        },
      },
    );
    await deniedRuntime.decideExtensionTrust("denied");
    expect(writeTrust).toHaveBeenCalledWith(process.cwd(), "denied");
    expect(deniedDiscover).toHaveBeenCalledTimes(1);
    expect(deniedRuntime.getSnapshot().trust.promptRepoRoot).toBeNull();
    deniedRuntime.dispose();
  });

  test("publishes mandatory trust extension reload before a later watch reload", async () => {
    const activeExtensions = createEmptyExtensionLoadResult(process.cwd());
    activeExtensions.pendingTrustRepoRoot = process.cwd();
    const refreshedExtensions = createEmptyExtensionLoadResult(process.cwd());
    const bootstrap = createBootstrap({ extensions: activeExtensions });
    const enteredTrustLoad = createTestDeferred<void>();
    const releaseTrustLoad = createTestDeferred<void>();
    const extensionsSeen: AppBootstrap["extensions"][] = [];
    let loads = 0;
    const runtime = createReviewSessionRuntime(bootstrap, {
      deps: {
        ...createReloadDeps(async (input, cwd, extensions) => {
          loads += 1;
          extensionsSeen.push(extensions);
          if (loads === 1) {
            enteredTrustLoad.resolve();
            await releaseTrustLoad.promise;
          }
          return {
            ...createBootstrap(),
            input,
            reloadContext: { cwd },
            extensions,
            changeset: { ...createBootstrap().changeset, title: `reload-${loads}` },
          };
        }),
        writeExtensionTrustImpl: () => "state.json",
        loadStartupExtensionsImpl: async () => refreshedExtensions,
      },
    });

    const trust = runtime.decideExtensionTrust("trusted");
    await enteredTrustLoad.promise;
    const watch = runtime.reload("watch", bootstrap.input, { resetApp: false });
    releaseTrustLoad.resolve();

    await trust;
    expect(runtime.getSnapshot().extensions).toBe(refreshedExtensions);
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("reload-1");
    await watch;
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("reload-2");
    expect(runtime.getSnapshot().extensions).toBe(refreshedExtensions);
    expect(extensionsSeen).toEqual([refreshedExtensions, refreshedExtensions]);
    expect(activeExtensions.registry.eventBusPhase).toBe("closed");
    runtime.dispose();
  });

  test("keeps a failed trust decision visible and retryable through the typed action boundary", async () => {
    const extensions = createEmptyExtensionLoadResult(process.cwd());
    extensions.pendingTrustRepoRoot = process.cwd();
    const bootstrap = createBootstrap({ extensions });
    const host = createHeadlessHostClient(bootstrap);
    let attempts = 0;
    const writeTrust = mock(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("trust store unavailable");
      return "state.json";
    });
    const runtime = createReviewSessionRuntime(bootstrap, {
      hostClient: host.hostClient,
      deps: { ...createReloadDeps(), writeExtensionTrustImpl: writeTrust },
    });
    const before = runtime.getSnapshot().store.getSnapshot();
    const decide = (requestId: string) =>
      host.dispatchCommand({
        type: "command",
        requestId,
        command: "apply_review_action",
        input: {
          sessionId: host.hostClient.getRegistration().sessionId,
          generation: before.documentGeneration,
          expectedStateRevision: before.stateRevision,
          action: { type: "trust/decide", decision: "denied" },
        },
      });

    await expect(decide("trust-fails")).resolves.toMatchObject({
      kind: "review-error",
      error: { code: "invalid-action", message: "trust store unavailable" },
    });
    expect(runtime.getSnapshot().trust.promptRepoRoot).toBe(process.cwd());
    expect(runtime.getSnapshot().store.getSnapshot()).toMatchObject({
      stateRevision: before.stateRevision,
      trustPromptRepoRoot: process.cwd(),
    });
    expect(runtime.getSnapshot().notice).toBe("trust store unavailable");

    await expect(decide("trust-retry")).resolves.toMatchObject({ kind: "review-action" });
    expect(writeTrust).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot().trust.promptRepoRoot).toBeNull();
    expect(runtime.getSnapshot().store.getSnapshot().trustPromptRepoRoot).toBeNull();
    runtime.dispose();
  });

  test("keeps persisted trust retryable when extension reload fails and manual reload rediscovers", async () => {
    const extensions = createEmptyExtensionLoadResult(process.cwd());
    extensions.pendingTrustRepoRoot = process.cwd();
    const bootstrap = createBootstrap({ extensions });
    const host = createHeadlessHostClient(bootstrap);
    const writeTrust = mock(() => "state.json");
    let discoveries = 0;
    const discover = mock(async () => {
      discoveries += 1;
      if (discoveries === 1) throw new Error("extension reload failed");
      return createEmptyExtensionLoadResult(process.cwd());
    });
    const runtime = createReviewSessionRuntime(bootstrap, {
      hostClient: host.hostClient,
      deps: {
        ...createReloadDeps(),
        writeExtensionTrustImpl: writeTrust,
        loadStartupExtensionsImpl: discover,
      },
    });
    const before = runtime.getSnapshot().store.getSnapshot();
    const action = (
      requestId: string,
      nextAction: { type: "trust/decide"; decision: "trusted" } | { type: "session/reload" },
    ) =>
      host.dispatchCommand({
        type: "command",
        requestId,
        command: "apply_review_action",
        input: {
          sessionId: host.hostClient.getRegistration().sessionId,
          generation: before.documentGeneration,
          expectedStateRevision: before.stateRevision,
          action: nextAction,
        },
      });

    await expect(
      action("trust-reload-fails", { type: "trust/decide", decision: "trusted" }),
    ).resolves.toMatchObject({
      kind: "review-error",
      error: { code: "invalid-action", message: "extension reload failed" },
    });
    expect(writeTrust).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().trust.promptRepoRoot).toBe(process.cwd());
    expect(runtime.getSnapshot().store.getSnapshot()).toBe(before);

    await expect(
      action("reload-trusted-extensions", { type: "session/reload" }),
    ).resolves.toMatchObject({
      kind: "review-action",
    });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot().trust.promptRepoRoot).toBeNull();
    expect(runtime.getSnapshot().store.getSnapshot().trustPromptRepoRoot).toBeNull();
    runtime.dispose();
  });

  test("applies config at the validated source cwd and rejects an escaping source", async () => {
    const deps = createReloadDeps();
    const resolveConfigured = deps.resolveConfiguredCliInputImpl!;
    deps.loadStartupExtensionsImpl = async ({ cwd }) =>
      createEmptyExtensionLoadResult(cwd ?? process.cwd());
    const configuredCwds: Array<string | undefined> = [];
    deps.resolveConfiguredCliInputImpl = ((input, options) => {
      configuredCwds.push(options?.cwd);
      return resolveConfigured(input, options);
    }) as typeof resolveConfigured;
    const runtime = createReviewSessionRuntime(createBootstrap(), { deps });

    await runtime.reload("daemon", reloadInput("inside"), {
      resetApp: false,
      sourcePath: "src",
    });
    expect(configuredCwds).toEqual([resolve(process.cwd(), "src")]);
    await expect(
      runtime.reload("daemon", reloadInput("escape"), { sourcePath: "../outside" }),
    ).rejects.toThrow("outside the initial Hunk root");
    expect(configuredCwds).toHaveLength(1);
    runtime.dispose();
  });

  test("re-resolves local reloads from raw invocation and current source cwd", async () => {
    let configuredTheme = "config-one";
    const configuredInputs: Array<{ cwd?: string; input: CliInput }> = [];
    const deps = createReloadDeps();
    deps.resolveConfiguredCliInputImpl = ((input: CliInput, options?: { cwd?: string }) => {
      configuredInputs.push({ cwd: options?.cwd, input });
      return {
        input: { ...input, options: { ...input.options, theme: configuredTheme } },
        customThemes: [],
        extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
        keybindings: {},
        startupNotices: [],
      };
    }) as typeof import("../core/config").resolveConfiguredCliInput;
    const rawInput: CliInput = { kind: "vcs", staged: false, options: {} };
    const bootstrap = createBootstrap({
      input: { kind: "vcs", staged: false, options: { theme: "old-config" } },
    });
    const host = createHeadlessHostClient(bootstrap);
    deps.loadStartupExtensionsImpl = async () => createEmptyExtensionLoadResult(process.cwd());
    const runtime = createReviewSessionRuntime(bootstrap, {
      deps,
      rawInput,
      hostClient: host.hostClient,
    });

    configuredTheme = "config-two";
    await runtime.reload("manual", bootstrap.input, {
      resetApp: false,
      sourcePath: "src",
    });
    expect(configuredInputs.at(-1)?.cwd).toBe(resolve(process.cwd(), "src"));
    expect(configuredInputs.at(-1)?.input.options.theme).toBeUndefined();
    expect(runtime.getSnapshot().bootstrap.input.options.theme).toBe("config-two");

    await runtime.reload("daemon", reloadInput("daemon-explicit"), { resetApp: false });
    expect(configuredInputs.at(-1)?.input.options.theme).toBe("daemon-explicit");

    await runtime.reload("manual", reloadInput("ignored-manual-argument"), { resetApp: false });
    expect(configuredInputs.at(-1)?.input.options.theme).toBe("daemon-explicit");
    await runtime.reload("watch", reloadInput("ignored-watch-argument"), { resetApp: false });
    expect(configuredInputs.at(-1)?.input.options.theme).toBe("daemon-explicit");

    const state = runtime.getSnapshot().store.getSnapshot();
    await expect(
      host.dispatchCommand({
        type: "command",
        requestId: "browser-reload-keeps-daemon-input",
        command: "apply_review_action",
        input: {
          sessionId: host.hostClient.getRegistration().sessionId,
          generation: state.documentGeneration,
          expectedStateRevision: state.stateRevision,
          action: { type: "session/reload" },
        },
      }),
    ).resolves.toMatchObject({ kind: "review-action" });
    expect(configuredInputs.at(-1)?.input.options.theme).toBe("daemon-explicit");
    runtime.dispose();
  });

  test("does not promote daemon input rejected by publication preflight", async () => {
    const configuredInputs: CliInput[] = [];
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const deps = createReloadDeps(async (input, cwd, extensions) => ({
      ...createBootstrap(),
      input,
      reloadContext: { cwd },
      changeset: {
        ...createBootstrap().changeset,
        title:
          input.options.theme === "daemon-publication-fails"
            ? "x".repeat(5 * 1024 * 1024)
            : (input.options.theme ?? "none"),
      },
      extensions,
    }));
    const resolveConfigured = deps.resolveConfiguredCliInputImpl!;
    deps.resolveConfiguredCliInputImpl = ((input: CliInput, options?: { cwd?: string }) => {
      configuredInputs.push(input);
      return resolveConfigured(input, options);
    }) as typeof import("../core/config").resolveConfiguredCliInput;
    const runtime = createReviewSessionRuntime(bootstrap, { deps, hostClient: host.hostClient });

    await runtime.reload("daemon", reloadInput("daemon-published"), { resetApp: false });
    const publishedSnapshot = runtime.getSnapshot();
    expect(host.replaced).toHaveLength(1);
    await expect(
      runtime.reload("daemon", reloadInput("daemon-publication-fails"), { resetApp: false }),
    ).rejects.toThrow(/metadata limit|websocket envelope limit/);
    expect(runtime.getSnapshot()).toBe(publishedSnapshot);
    expect(host.replaced).toHaveLength(1);

    await runtime.reload("manual", reloadInput("ignored"), { resetApp: false });
    expect(configuredInputs.map((input) => input.options.theme)).toEqual([
      "daemon-published",
      "daemon-publication-fails",
      "daemon-published",
    ]);
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("daemon-published");
    expect(host.replaced).toHaveLength(2);
    runtime.dispose();
  });

  test("dispose immediately closes a freshly discovered registry while transforms remain pending", async () => {
    const transform = createTestDeferred<AppBootstrap>();
    const freshExtensions = createEmptyExtensionLoadResult(process.cwd());
    let phase = freshExtensions.registry.eventBusPhase;
    let closeWrites = 0;
    Object.defineProperty(freshExtensions.registry, "eventBusPhase", {
      configurable: true,
      get: () => phase,
      set(next: typeof phase) {
        phase = next;
        if (next === "closed") closeWrites += 1;
      },
    });
    const loadExtensions = mock(async () => freshExtensions);
    const runtime = createReviewSessionRuntime(createBootstrap(), {
      deps: {
        ...createReloadDeps(async () => transform.promise),
        loadStartupExtensionsImpl: loadExtensions,
      },
    });
    const reload = runtime
      .reload("manual", reloadInput("pending-transform"), {
        reloadExtensions: true,
        resetApp: false,
      })
      .catch((error) => error);
    for (let attempt = 0; attempt < 20 && loadExtensions.mock.calls.length === 0; attempt++) {
      await Bun.sleep(0);
    }
    await Bun.sleep(0);

    runtime.dispose();
    expect(freshExtensions.registry.eventBusPhase).toBe("closed");
    expect(closeWrites).toBe(1);
    expect(await reload).toBeInstanceOf(Error);

    transform.resolve({
      ...createBootstrap(),
      changeset: { ...createBootstrap().changeset, title: "late-transform" },
      extensions: freshExtensions,
    });
    await Bun.sleep(0);
    expect(closeWrites).toBe(1);
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("initial");
  });

  test("dispose during broker replacement skips binding, notification, watch, and lifecycle work", async () => {
    const extensions = createEmptyExtensionLoadResult(process.cwd());
    let reloadEvents = 0;
    extensions.registry.eventHandlers.session_reload.push({
      extensionId: "cutover-test",
      handler: () => {
        reloadEvents += 1;
      },
    });
    const bootstrap = createBootstrap({
      extensions,
      input: { kind: "vcs", staged: false, options: { watch: true } },
    });
    const watch = createWatchTestRuntime();
    let runtime!: ReturnType<typeof createReviewSessionRuntime>;
    const host = createHeadlessHostClient(bootstrap, () => runtime.dispose());
    runtime = createReviewSessionRuntime(bootstrap, {
      deps: createReloadDeps(),
      hostClient: host.hostClient,
      watchRuntime: watch.runtime,
    });
    let notifications = 0;
    runtime.subscribe(() => {
      notifications += 1;
    });
    runtime.start();
    const updatesBeforeReload = host.updated.length;

    await expect(runtime.reload("manual", bootstrap.input, { resetApp: false })).rejects.toThrow(
      "disposed",
    );
    expect(notifications).toBe(0);
    expect(watch.sources).toHaveLength(1);
    expect(watch.sources[0]?.closeCount).toBe(1);
    expect(reloadEvents).toBe(0);
    expect(host.updated).toHaveLength(updatesBeforeReload);

    runtime.getSnapshot().store.dispatch({ type: "notes/set-visibility", visible: true });
    expect(host.updated).toHaveLength(updatesBeforeReload);
  });

  test("dispose from a runtime subscriber stops later notifications, watch restart, and events", async () => {
    const extensions = createEmptyExtensionLoadResult(process.cwd());
    let reloadEvents = 0;
    extensions.registry.eventHandlers.session_reload.push({
      extensionId: "subscriber-cutover-test",
      handler: () => {
        reloadEvents += 1;
      },
    });
    const bootstrap = createBootstrap({
      extensions,
      input: { kind: "vcs", staged: false, options: { watch: true } },
    });
    const watch = createWatchTestRuntime();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, {
      deps: createReloadDeps(),
      hostClient: host.hostClient,
      watchRuntime: watch.runtime,
    });
    let laterNotifications = 0;
    runtime.subscribe(() => runtime.dispose());
    runtime.subscribe(() => {
      laterNotifications += 1;
    });
    runtime.start();

    await expect(runtime.reload("manual", bootstrap.input, { resetApp: false })).rejects.toThrow(
      "disposed",
    );
    expect(laterNotifications).toBe(0);
    expect(watch.sources).toHaveLength(1);
    expect(watch.sources[0]?.closeCount).toBe(1);
    expect(reloadEvents).toBe(0);
    const updatesAfterDispose = host.updated.length;
    runtime.getSnapshot().store.dispatch({ type: "notes/set-visibility", visible: true });
    expect(host.updated).toHaveLength(updatesAfterDispose);
  });

  test("dispose rejects an active deferred reload immediately and ignores late completion", async () => {
    const deferred = createTestDeferred<AppBootstrap>();
    const runtime = createReviewSessionRuntime(createBootstrap(), {
      deps: createReloadDeps(async () => deferred.promise),
    });
    const reload = runtime.reload("manual", reloadInput("pending"), { resetApp: false });
    await Bun.sleep(0);

    runtime.dispose();
    const settlement = await Promise.race([
      reload.then(
        () => "resolved",
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
      Bun.sleep(50).then(() => "timed-out"),
    ]);
    expect(settlement).toContain("disposed");

    deferred.resolve({
      ...createBootstrap(),
      changeset: { ...createBootstrap().changeset, title: "late" },
    });
    await Bun.sleep(0);
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("initial");
  });

  test("closes watch resources and rejects work after disposal", async () => {
    const watch = createWatchTestRuntime();
    const before = lines(...Array.from({ length: 10 }, (_, index) => `line ${index + 1}`));
    const afterLines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
    afterLines[4] = "line 5 changed";
    const expandedFile = createTestDiffFile({
      id: "disposed-expanded",
      path: "disposed-expanded.ts",
      before,
      after: lines(...afterLines),
      context: 0,
      sourceFetcher: createTestSourceFetcher(() => lines(...afterLines)),
    });
    const base = createBootstrap();
    const bootstrap = createBootstrap({
      input: { kind: "vcs", staged: false, options: { watch: true } },
      changeset: { ...base.changeset, files: [expandedFile] },
    });
    const runtime = createReviewSessionRuntime(bootstrap, {
      deps: createReloadDeps(),
      watchRuntime: watch.runtime,
    });
    runtime.start();

    runtime.dispose();
    expect(watch.sources[0]?.closeCount).toBe(1);
    const store = runtime.getSnapshot().store;
    const beforeRejectedAuthorities = store.getSnapshot();
    expect(() => runtime.executeReviewIntent({ type: "filter/set", filter: "rejected" })).toThrow(
      "Review session runtime is disposed.",
    );
    expect(store.getSnapshot()).toBe(beforeRejectedAuthorities);
    await expect(
      runtime.toggleSourceGap(beforeRejectedAuthorities.document.files[0]!.key, "before:0"),
    ).rejects.toThrow("Review session runtime is disposed.");
    expect(store.getSnapshot()).toBe(beforeRejectedAuthorities);
    expect(store.getSnapshot().stateRevision).toBe(beforeRejectedAuthorities.stateRevision);
    await expect(runtime.reload("manual")).rejects.toThrow("disposed");
  });
});
