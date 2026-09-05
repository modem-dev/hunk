/**
 * The whole review-resource path, end to end, with nothing faked but the socket.
 *
 * A real producer publishes a real generation; a real registration and snapshot carry its
 * catalog and position to a real broker state; the broker's load loop reads bounded chunks
 * back through the real session bridge. What the test replaces is only the transport
 * between them, so every rule the phase added — mirror ordering, single flight, bounded
 * parallelism, digest verification, generation eviction — is exercised as it ships.
 */
import { describe, expect, test } from "bun:test";
import {
  connectReviewSession,
  createTestPatchFile,
} from "../../../../../test/helpers/review-session-harness";
import { REVIEW_RESOURCE_CHUNK_BYTES, reviewResourceId } from "../../core/review/resources";
import {
  createSessionRegistration,
  createInitialSessionSnapshot,
} from "../../app/session/registration";
import type { HunkSessionServerMessage } from "../types";
import { ReviewGenerationRetiredError } from "./state";
import { ReviewResourceCache } from "./reviewResourceCache";

const SESSION = { sessionId: "session-1" } as const;

/** Connect one producer to one broker state through the shared review-session harness. */
function connect(
  files: Parameters<typeof connectReviewSession>[0],
  cache = new ReviewResourceCache(),
) {
  return connectReviewSession(files, { cache, sessionId: SESSION.sessionId });
}

/** How many resource reads the broker issued for one resource id. */
function readsFor(sent: HunkSessionServerMessage[], resourceId: string) {
  return sent.filter(
    (message) =>
      message.command === "read_review_resource" && message.input.request.resourceId === resourceId,
  ).length;
}

describe("brokered review resources", () => {
  // Intent: `hunk session review --include-patch` produces exactly the patch text the
  // producer published, now that the registration no longer carries it.
  test("reconstructs patch text byte for byte from published resources", async () => {
    const files = [createTestPatchFile("alpha", 4), createTestPatchFile("beta", 3)];
    const { state, register, producer } = connect(files);
    register();

    const review = await state.getSessionReviewWithResources(SESSION, { includePatch: true });

    expect(review.files.map((file) => file.patch)).toEqual(
      producer.getPublication().document.files.map((file) => file.patch),
    );
    expect(review.selectedFile?.patch).toBe(producer.getPublication().document.files[0]!.patch);
  });

  test("omits patch text entirely when it was not asked for", async () => {
    const { state, register, sent } = connect([createTestPatchFile("alpha", 3)]);
    register();

    const review = await state.getSessionReviewWithResources(SESSION, {});

    expect(review.files.every((file) => file.patch === undefined)).toBe(true);
    expect(sent).toHaveLength(0);
  });

  // Intent: C2 — a resource larger than one chunk is read as a sequence and verified once.
  test("reads a multi-chunk resource in bounded windows", async () => {
    const files = [createTestPatchFile("alpha", 8_000)];
    const { state, register, producer, sent } = connect(files);
    register();
    const publication = producer.getPublication();
    const patch = publication.document.files[0]!.patch;
    expect(patch.length).toBeGreaterThan(REVIEW_RESOURCE_CHUNK_BYTES);

    const review = await state.getSessionReviewWithResources(SESSION, { includePatch: true });

    expect(review.files[0]!.patch).toBe(patch);
    const resourceId = reviewResourceId({
      kind: "patch",
      fileKey: publication.document.files[0]!.key,
    });
    expect(readsFor(sent, resourceId)).toBeGreaterThan(1);
    for (const message of sent) {
      if (message.command === "read_review_resource") {
        expect(message.input.request.length).toBeLessThanOrEqual(REVIEW_RESOURCE_CHUNK_BYTES);
      }
    }
  });

  // Intent: many files load in parallel under one limit, and the same resource asked for
  // twice at once costs one assembly.
  test("loads many patches in parallel and collapses concurrent reads of one resource", async () => {
    const files = Array.from({ length: 12 }, (_unused, index) =>
      createTestPatchFile(`file${index}`, 3),
    );
    const { state, register, producer, sent } = connect(files);
    register();
    const publication = producer.getPublication();
    const firstResource = reviewResourceId({
      kind: "patch",
      fileKey: publication.document.files[0]!.key,
    });

    const [left, right] = await Promise.all([
      state.getSessionReviewWithResources(SESSION, { includePatch: true }),
      state.getSessionReviewWithResources(SESSION, { includePatch: true }),
    ]);

    expect(left.files.map((file) => file.patch)).toEqual(right.files.map((file) => file.patch));
    // One read per resource, however many callers wanted it at the same moment.
    expect(readsFor(sent, firstResource)).toBe(1);
    expect(state.getReviewResourceUsage().reservedBytes).toBe(0);
  });

  test("serves a second request from the cache without reading again", async () => {
    const { state, register, sent } = connect([createTestPatchFile("alpha", 3)]);
    register();

    await state.getSessionReviewWithResources(SESSION, { includePatch: true });
    const afterFirst = sent.length;
    await state.getSessionReviewWithResources(SESSION, { includePatch: true });

    expect(sent).toHaveLength(afterFirst);
    expect(state.getReviewResourceUsage().entryCount).toBe(1);
  });

  // Intent: C1 — the mirror follows the generation, and everything derived from the old
  // one is dropped rather than served as if it were current.
  test("retires a generation's cached bytes when the session publishes the next one", async () => {
    const files = [createTestPatchFile("alpha", 3)];
    const { state, register, producer, bootstrap } = connect(files);
    const registration = register();
    await state.getSessionReviewWithResources(SESSION, { includePatch: true });
    const first = state.getReviewPublication(SESSION.sessionId)!;
    expect(state.getReviewResourceUsage().entryCount).toBe(1);

    producer.publish({ files, sourceLabel: bootstrap.changeset.sourceLabel });
    register(registration);

    const second = state.getReviewPublication(SESSION.sessionId)!;
    expect(second.address.generation).not.toBe(first.address.generation);
    expect(state.getReviewResourceUsage().entryCount).toBe(0);
    await expect(
      state.loadReviewResource(
        SESSION.sessionId,
        first.address.generation,
        first.catalog.resources[0]!.id,
      ),
    ).rejects.toBeInstanceOf(ReviewGenerationRetiredError);
  });

  test("refuses a resource that is not part of the mirrored generation", async () => {
    const { state, register } = connect([createTestPatchFile("alpha", 3)]);
    register();
    const generation = state.getReviewPublication(SESSION.sessionId)!.address.generation;

    await expect(
      state.loadReviewResource(SESSION.sessionId, generation, "resource:patch:file:deadbeef"),
    ).rejects.toThrow("is not part of generation");
  });

  // Intent: the daemon's own budget is what bounds it, not the caller's patience.
  test("refuses to start a load the daemon has no in-flight budget for", async () => {
    const { state, register } = connect(
      [createTestPatchFile("alpha", 3)],
      new ReviewResourceCache({ inFlightResources: 0 }),
    );
    register();

    await expect(
      state.getSessionReviewWithResources(SESSION, { includePatch: true }),
    ).rejects.toThrow("already assembling");
  });

  // Intent: a session that publishes no review is mirrored as nothing, and its embedded
  // patch text — the shape an older build still sends — is served unchanged.
  test("serves a pre-mirror session's embedded patch text unchanged", async () => {
    const files = [createTestPatchFile("alpha", 3)];
    const { state, socket, producer, bootstrap, sent } = connect(files);
    const publication = producer.getPublication();
    const legacy = {
      ...createSessionRegistration(bootstrap, publication),
      sessionId: SESSION.sessionId,
    };
    // Exactly what a build from before this phase sent: patch text inline, no catalog.
    const legacyInfo = {
      ...legacy.info,
      reviewCatalog: undefined,
      files: legacy.info.files.map((file, index) => ({
        ...file,
        patch: publication.document.files[index]!.patch,
      })),
    };
    const snapshot = createInitialSessionSnapshot(bootstrap, publication);
    state.registerSession(
      socket,
      JSON.parse(JSON.stringify({ ...legacy, info: legacyInfo })),
      JSON.parse(
        JSON.stringify({ ...snapshot, state: { ...snapshot.state, reviewPublication: undefined } }),
      ),
    );

    const review = await state.getSessionReviewWithResources(SESSION, { includePatch: true });

    expect(state.getReviewPublication(SESSION.sessionId)).toBeUndefined();
    expect(review.files[0]!.patch).toBe(publication.document.files[0]!.patch);
    expect(sent).toHaveLength(0);
  });
});

describe("brokered review actions", () => {
  // Intent: the daemon forwards an action and the producer plans it through the shared
  // intent path; the daemon itself decides nothing semantic.
  test("forwards one action to the producer and reports the position it reached", async () => {
    const { state, register, producer } = connect([createTestPatchFile("alpha", 3)]);
    register();
    const generation = state.getReviewPublication(SESSION.sessionId)!.address.generation;

    const result = await state.applyReviewAction(SESSION.sessionId, generation, {
      type: "filter/set",
      filter: "alpha",
    });

    expect(result).toMatchObject({ ok: true, generation });
    expect(producer.getReviewState()?.filter).toBe("alpha");
  });

  test("refuses to forward an action addressed to a retired generation", async () => {
    const { state, register } = connect([createTestPatchFile("alpha", 3)]);
    register();

    await expect(
      state.applyReviewAction(SESSION.sessionId, "generation:integration:9", {
        type: "filter/set",
        filter: "alpha",
      }),
    ).rejects.toBeInstanceOf(ReviewGenerationRetiredError);
  });
});
