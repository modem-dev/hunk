import { describe, expect, test } from "bun:test";
import {
  createTestSessionRegistration,
  createTestSessionSnapshot,
} from "../../../test/helpers/session-daemon-fixtures";
import { ReviewResourceCache } from "./reviewResourceCache";
import { HunkSessionBrokerState, type HunkSessionObserverEvent } from "./state";
import { projectManifestReviewCompatibility } from "../reviewCompatibility";

describe("HunkSessionBrokerState review revisions", () => {
  test("rejects an oversized producer generation before retaining session state", () => {
    const state = new HunkSessionBrokerState();
    const oversized = "g".repeat(300 * 1024);
    const registration = createTestSessionRegistration();
    registration.info.documentGeneration = oversized;
    registration.info.reviewManifest.generation = oversized;
    for (const resource of registration.info.reviewManifest.resources) {
      resource.generation = oversized;
    }
    const snapshot = createTestSessionSnapshot({ documentGeneration: oversized });
    snapshot.state.review.documentGeneration = oversized;

    expect(state.registerSession({ send: () => {} }, registration, snapshot)).toBe(false);
    expect(state.listSessions()).toEqual([]);
    expect(state.getBrowserReviewCapabilityHash(registration.sessionId)).toBeUndefined();
  });

  test("observes registration, monotonic state revisions, replacement, and disconnect", () => {
    const state = new HunkSessionBrokerState();
    const events: HunkSessionObserverEvent[] = [];
    state.subscribeReviewEvents((event) => events.push(event));
    const socket = { send: () => {} };
    const registration = createTestSessionRegistration();
    const snapshot = createTestSessionSnapshot();
    expect(state.registerSession(socket, registration, snapshot)).toBe(true);

    const nextSnapshot = createTestSessionSnapshot({ stateRevision: 2 });
    nextSnapshot.state.review.stateRevision = 2;
    expect(state.updateSnapshot(socket, registration.sessionId, nextSnapshot)).toBe("updated");
    const retiredSnapshot = createTestSessionSnapshot({ stateRevision: 1 });
    retiredSnapshot.state.review.stateRevision = 1;
    expect(state.updateSnapshot(socket, registration.sessionId, retiredSnapshot)).toBe("invalid");

    const replacement = structuredClone(registration);
    replacement.info.documentGeneration = "generation:replacement";
    replacement.info.reviewManifest.generation = "generation:replacement";
    for (const resource of replacement.info.reviewManifest.resources) {
      resource.generation = "generation:replacement";
    }
    const replacementSnapshot = createTestSessionSnapshot({
      documentGeneration: "generation:replacement",
      stateRevision: 0,
    });
    replacementSnapshot.state.review.documentGeneration = "generation:replacement";
    expect(state.registerSession(socket, replacement, replacementSnapshot)).toBe(true);
    state.unregisterSocket(socket);

    expect(events.map((event) => event.type)).toEqual([
      "registration",
      "state-revision",
      "state-revision",
      "document-replaced",
      "state-revision",
      "disconnect",
    ]);
  });

  test("releases in-flight resource reservations after producer disconnect", async () => {
    const cache = new ReviewResourceCache();
    const state = new HunkSessionBrokerState(cache);
    const socket = { send: () => {} };
    const registration = createTestSessionRegistration();
    const snapshot = createTestSessionSnapshot();
    state.registerSession(socket, registration, snapshot);
    const pending = state.getSessionReviewWithResources(
      { sessionId: registration.sessionId },
      { includePatch: true },
    );
    await Bun.sleep(0);
    expect(cache.getReservationCount()).toBe(1);
    state.unregisterSocket(socket);
    await expect(pending).rejects.toThrow("disconnected");
    expect(cache.getReservationCount()).toBe(0);
  });

  test("releases in-flight reservations when a generation is retired", async () => {
    const cache = new ReviewResourceCache();
    const state = new HunkSessionBrokerState(cache);
    const socket = { send: () => {} };
    const registration = createTestSessionRegistration();
    state.registerSession(socket, registration, createTestSessionSnapshot());
    const pending = state.getSessionReviewWithResources(
      { sessionId: registration.sessionId },
      { includePatch: true },
    );
    await Bun.sleep(0);
    expect(cache.getReservationCount()).toBe(1);

    const replacement = structuredClone(registration);
    replacement.info.documentGeneration = "generation:replacement";
    replacement.info.reviewManifest.generation = "generation:replacement";
    for (const resource of replacement.info.reviewManifest.resources) {
      resource.generation = "generation:replacement";
    }
    const replacementSnapshot = createTestSessionSnapshot({
      documentGeneration: "generation:replacement",
    });
    replacementSnapshot.state.review.documentGeneration = "generation:replacement";
    state.registerSession(socket, replacement, replacementSnapshot);
    await expect(pending).rejects.toThrow("generation retired");
    expect(cache.getReservationCount()).toBe(0);
  });

  test("rejects a second live producer but permits reconnect after disconnect", () => {
    const state = new HunkSessionBrokerState();
    const owner = { send: () => {} };
    const attacker = { send: () => {} };
    const registration = createTestSessionRegistration();
    expect(state.registerSession(owner, registration, createTestSessionSnapshot())).toBe(true);
    expect(state.registerSession(attacker, registration, createTestSessionSnapshot())).toBe(false);
    expect(state.ownsSession(owner, registration.sessionId)).toBe(true);

    state.unregisterSocket(owner);
    expect(state.registerSession(attacker, registration, createTestSessionSnapshot())).toBe(true);
    expect(state.ownsSession(attacker, registration.sessionId)).toBe(true);
  });

  test("rejects snapshot notes and selections outside the registered manifest graph", () => {
    const registration = createTestSessionRegistration();
    const invalidNote = createTestSessionSnapshot();
    invalidNote.state.review.notes.push({
      id: "note:invalid-owner",
      source: "user",
      origin: "user",
      fileKey: registration.info.reviewManifest.files[0]!.key,
      anchor: { intersectingHunkIndices: [], ownerHunkIndex: 2 },
      summary: "Invalid owner",
      editable: true,
    });
    expect(
      new HunkSessionBrokerState().registerSession({ send: () => {} }, registration, invalidNote),
    ).toBe(false);

    const invalidSelection = createTestSessionSnapshot();
    invalidSelection.state.review.selection.hunkIndex = 2;
    invalidSelection.state.selectedHunkIndex = 2;
    expect(
      new HunkSessionBrokerState().registerSession(
        { send: () => {} },
        registration,
        invalidSelection,
      ),
    ).toBe(false);
  });

  test("rejects missing, extra, and mismatched compatibility note projections", () => {
    const registrationWithStatic = createTestSessionRegistration();
    const manifestFile = registrationWithStatic.info.reviewManifest.files[0]!;
    manifestFile.notes.push({
      id: "note:static",
      source: "agent",
      origin: "sidecar",
      fileKey: manifestFile.key,
      anchor: { intersectingHunkIndices: [], ownerHunkIndex: 0 },
      summary: "Static note",
      editable: false,
    });
    expect(
      new HunkSessionBrokerState().registerSession(
        { send: () => {} },
        registrationWithStatic,
        createTestSessionSnapshot(),
      ),
    ).toBe(false);

    const registration = createTestSessionRegistration();
    const canonical = createTestSessionSnapshot();
    canonical.state.review.notes.push({
      id: "note:live",
      source: "agent",
      origin: "live-agent",
      fileKey: registration.info.reviewManifest.files[0]!.key,
      anchor: {
        newRange: [1, 1],
        preferred: { side: "new", line: 1 },
        intersectingHunkIndices: [0],
        ownerHunkIndex: 0,
      },
      summary: "Live note",
      editable: false,
    });
    const compatibility = projectManifestReviewCompatibility(
      registration.info.reviewManifest,
      canonical.state.review,
    );
    canonical.state.liveComments = compatibility.liveComments;
    canonical.state.liveCommentCount = compatibility.liveComments.length;
    canonical.state.reviewNotes = compatibility.reviewNotes;
    canonical.state.reviewNoteCount = compatibility.reviewNotes.length;
    expect(
      new HunkSessionBrokerState().registerSession({ send: () => {} }, registration, canonical),
    ).toBe(true);

    const mismatched = structuredClone(canonical);
    mismatched.state.liveComments[0]!.summary = "Contradiction";
    expect(
      new HunkSessionBrokerState().registerSession({ send: () => {} }, registration, mismatched),
    ).toBe(false);

    const state = new HunkSessionBrokerState();
    const socket = { send: () => {} };
    expect(state.registerSession(socket, registration, createTestSessionSnapshot())).toBe(true);
    const extra = createTestSessionSnapshot({ stateRevision: 1 });
    extra.state.review.stateRevision = 1;
    extra.state.reviewNotes = [
      {
        noteId: "note:extra",
        source: "user",
        filePath: manifestFile.path,
        body: "Extra",
        createdAt: "2026-01-01T00:00:00.000Z",
        editable: true,
      },
    ];
    extra.state.reviewNoteCount = 1;
    expect(state.updateSnapshot(socket, registration.sessionId, extra)).toBe("invalid");
  });

  test("rejects an empty-review compatibility hunk contradiction", () => {
    const registration = createTestSessionRegistration({ files: [] });
    const snapshot = createTestSessionSnapshot({
      review: {
        documentGeneration: registration.info.documentGeneration,
        stateRevision: 0,
        selection: { fileKey: null, hunkIndex: 0 },
        filter: "",
        showAgentNotes: false,
        notes: [],
      },
      selectedHunkIndex: 99,
      selectedHunkOldRange: undefined,
      selectedHunkNewRange: undefined,
    });
    delete snapshot.state.selectedFileId;
    delete snapshot.state.selectedFilePath;
    delete snapshot.state.selectedHunkOldRange;
    delete snapshot.state.selectedHunkNewRange;
    expect(
      new HunkSessionBrokerState().registerSession({ send: () => {} }, registration, snapshot),
    ).toBe(false);
  });

  test("rejects same-generation registration rollback", () => {
    const state = new HunkSessionBrokerState();
    const socket = { send: () => {} };
    const registration = createTestSessionRegistration();
    expect(state.registerSession(socket, registration, createTestSessionSnapshot())).toBe(true);
    const advanced = createTestSessionSnapshot({ stateRevision: 2 });
    advanced.state.review.stateRevision = 2;
    expect(state.updateSnapshot(socket, registration.sessionId, advanced)).toBe("updated");
    expect(state.registerSession(socket, registration, createTestSessionSnapshot())).toBe(false);
  });

  test("rejects descriptor changes within an immutable cached generation", () => {
    const cache = new ReviewResourceCache();
    const state = new HunkSessionBrokerState(cache);
    const socket = { send: () => {} };
    const registration = createTestSessionRegistration();
    expect(state.registerSession(socket, registration, createTestSessionSnapshot())).toBe(true);
    const descriptor = registration.info.reviewManifest.resources[0]!;
    cache.setComplete(
      registration.sessionId,
      registration.info.documentGeneration,
      descriptor,
      Buffer.from("@@ -1,1 +1,1 @@"),
    );

    const conflicting = structuredClone(registration);
    conflicting.info.reviewManifest.resources[0]!.digest = "0".repeat(64);
    expect(state.registerSession(socket, conflicting, createTestSessionSnapshot())).toBe(false);
    expect(
      cache.get(registration.sessionId, registration.info.documentGeneration, descriptor.id),
    ).toBeDefined();
  });

  test("releases reservations when resource allocation fails", async () => {
    const cache = new ReviewResourceCache();
    const state = new HunkSessionBrokerState(cache, () => {
      throw new Error("simulated allocation failure");
    });
    const registration = createTestSessionRegistration();
    state.registerSession({ send: () => {} }, registration, createTestSessionSnapshot());

    await expect(
      state.getSessionReviewWithResources(
        { sessionId: registration.sessionId },
        { includePatch: true },
      ),
    ).rejects.toThrow("simulated allocation failure");
    expect(cache.getReservationCount()).toBe(0);
    expect(cache.getTotalBytes()).toBe(0);
  });

  test("rejects registration when manifest and snapshot generations are not atomic", () => {
    const state = new HunkSessionBrokerState();
    const registration = createTestSessionRegistration();
    const snapshot = createTestSessionSnapshot({ documentGeneration: "generation:other" });
    snapshot.state.review.documentGeneration = "generation:other";
    expect(state.registerSession({ send: () => {} }, registration, snapshot)).toBe(false);
    expect(state.listSessions()).toEqual([]);
  });
});
