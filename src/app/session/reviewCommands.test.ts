import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import { ReviewProducer } from "../review/producer";
import { reviewGapId } from "../../core/review/expansion";
import { reviewResourceId } from "../../core/review/resources";
import { createReviewStore } from "../../core/review/store";
import {
  HUNK_REVIEW_PROTOCOL_VERSION,
  type HunkReviewActionV1,
} from "../../session/reviewProtocol";
import { applySessionReviewAction, readSessionReviewResource } from "./reviewCommands";

const ACTOR = { clientId: "browser-1", kind: "browser" as const };

/**
 * One producer with a store attached, the way a mounted host wires it.
 *
 * The file has leading context before its second hunk, so it offers a real collapsed gap
 * whose lines can be addressed with a proof.
 */
function createTestProducer() {
  const after = `${Array.from({ length: 20 }, (_unused, index) =>
    index === 1 || index === 17 ? `changed ${index + 1}` : `line ${index + 1}`,
  ).join("\n")}\n`;
  const file = createTestDiffFile({
    id: "file-1",
    path: "src/example.ts",
    before: `${Array.from({ length: 20 }, (_unused, index) => `line ${index + 1}`).join("\n")}\n`,
    after,
    context: 1,
    // A reader behind the file is what gives it an expandable source identity, which an
    // expanded-line proof is stated against.
    sourceFetcher: { cacheKey: "test-source", getFullText: async () => after },
  });
  const producer = new ReviewProducer(
    { files: [file], sourceLabel: "/repo" },
    { producerId: "test" },
  );
  const publication = producer.getPublication();
  const store = createReviewStore(publication.document);
  producer.attachStore(store);
  return { producer, publication, store, file: publication.document.files[0]! };
}

function envelope(action: HunkReviewActionV1, generation: string, expectedStateRevision?: number) {
  return {
    protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
    generation,
    actor: ACTOR,
    action,
    ...(expectedStateRevision !== undefined ? { expectedStateRevision } : {}),
  };
}

describe("applySessionReviewAction", () => {
  // Intent: a brokered action reaches the same planner a key press does, and reports where
  // the review ended up.
  test("plans one action against the live review and reports the new position", () => {
    const { producer, publication } = createTestProducer();
    const before = producer.getPublicationAddress().stateRevision;

    const result = applySessionReviewAction(
      producer,
      envelope({ type: "filter/set", filter: "example" }, publication.generation),
    );

    expect(result).toEqual({
      ok: true,
      generation: publication.generation,
      stateRevision: before + 1,
    });
    expect(producer.getReviewState()?.filter).toBe("example");
  });

  test("refuses an action addressed to a generation the producer is not serving", () => {
    const { producer } = createTestProducer();

    const result = applySessionReviewAction(
      producer,
      envelope({ type: "filter/set", filter: "x" }, "generation:test:9"),
    );

    expect(result).toMatchObject({ ok: false, code: "stale-generation" });
  });

  // Intent: C1 — the revision precondition is the shared classifier's answer, not a local
  // comparison, so a client acting on a review that has since moved is told to reload.
  test("refuses an action whose expected revision the review has already passed", () => {
    const { producer, publication } = createTestProducer();
    applySessionReviewAction(
      producer,
      envelope({ type: "filter/set", filter: "one" }, publication.generation),
    );

    const stale = applySessionReviewAction(
      producer,
      envelope({ type: "filter/set", filter: "two" }, publication.generation, 0),
    );
    expect(stale).toMatchObject({ ok: false, code: "stale-generation" });

    const current = producer.getPublicationAddress().stateRevision;
    expect(
      applySessionReviewAction(
        producer,
        envelope({ type: "filter/set", filter: "two" }, publication.generation, current),
      ).ok,
    ).toBe(true);
  });

  test("reports a semantic rejection with the planner's own code", () => {
    const { producer, publication } = createTestProducer();

    const result = applySessionReviewAction(
      producer,
      envelope(
        { type: "expansion/toggle", fileKey: "file:deadbeef", gapId: "before:0" },
        publication.generation,
      ),
    );

    expect(result).toMatchObject({ ok: false, code: "file-not-found" });
  });

  test("accepts only ranges fully covered by visible patch rows", () => {
    const { producer, publication, file } = createTestProducer();
    const visibleTarget = {
      newRange: [1, 3] as const,
      preferred: { side: "new" as const, line: 2 },
    };

    expect(
      applySessionReviewAction(
        producer,
        envelope(
          {
            type: "notes/start-draft",
            fileKey: file.key,
            hunkIndex: 0,
            target: visibleTarget,
          },
          publication.generation,
        ),
      ).ok,
    ).toBe(true);
    producer.applyIntent(
      { type: "notes/create-user", consumeDraft: true },
      {
        noteId: "discard",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    );

    const collapsed = applySessionReviewAction(
      producer,
      envelope(
        {
          type: "notes/start-draft",
          fileKey: file.key,
          hunkIndex: 0,
          target: { newRange: [3, 17], preferred: { side: "new", line: 3 } },
        },
        publication.generation,
      ),
    );
    expect(collapsed).toMatchObject({ ok: false, code: "invalid-request" });
  });

  test("rejects a range start whose requested hunk differs from its resolved owner", () => {
    const { producer, publication, file } = createTestProducer();

    const result = applySessionReviewAction(
      producer,
      envelope(
        {
          type: "notes/start-draft",
          fileKey: file.key,
          hunkIndex: 0,
          target: { newRange: [17, 19], preferred: { side: "new", line: 18 } },
        },
        publication.generation,
      ),
    );

    expect(result).toMatchObject({ ok: false, code: "invalid-request" });
    expect(producer.getReviewState()!.draftNote).toBeNull();
  });

  test("requires a save precondition to match the draft's exact range", () => {
    const { producer, publication, store, file } = createTestProducer();
    const target = { newRange: [1, 3] as const, preferred: { side: "new" as const, line: 2 } };
    expect(
      applySessionReviewAction(
        producer,
        envelope(
          { type: "notes/start-draft", fileKey: file.key, hunkIndex: 0, target },
          publication.generation,
        ),
      ).ok,
    ).toBe(true);
    store.dispatch({ type: "draft/update", body: "exact range" });

    const competing = applySessionReviewAction(
      producer,
      envelope(
        {
          type: "notes/create-user",
          consumeDraft: true,
          fileKey: file.key,
          hunkIndex: 0,
          target: { newRange: [2, 3], preferred: { side: "new", line: 2 } },
        },
        publication.generation,
      ),
    );
    expect(competing).toMatchObject({ ok: false, code: "draft-missing" });
    expect(producer.getReviewState()!.draftNote).not.toBeNull();

    const identitylessRange = applySessionReviewAction(
      producer,
      envelope({ type: "notes/create-user", consumeDraft: true, target }, publication.generation),
    );
    expect(identitylessRange).toMatchObject({ ok: false, code: "invalid-request" });
    expect(producer.getReviewState()!.draftNote).not.toBeNull();

    const wrongOwner = applySessionReviewAction(
      producer,
      envelope(
        {
          type: "notes/create-user",
          consumeDraft: true,
          fileKey: file.key,
          hunkIndex: 1,
          target,
        },
        publication.generation,
      ),
    );
    expect(wrongOwner).toMatchObject({ ok: false, code: "draft-missing" });
    expect(producer.getReviewState()!.draftNote).not.toBeNull();

    expect(
      applySessionReviewAction(
        producer,
        envelope(
          {
            type: "notes/create-user",
            consumeDraft: true,
            fileKey: file.key,
            hunkIndex: 0,
            target,
          },
          publication.generation,
        ),
      ).ok,
    ).toBe(true);
    expect(producer.getReviewState()!.userNotes.at(-1)!.note.anchor.newRange).toEqual([1, 3]);
  });

  // Intent: B10 — a note on a line inside an expanded gap is expressible remotely, and the
  // hunk that ends up owning it is core's answer through the shared anchor path, never one
  // this tier recomputed (D3).
  test("accepts a draft on an expanded-gap line and anchors it through the shared path", () => {
    const { producer, publication, file } = createTestProducer();
    const gapId = reviewGapId("before", 1);
    const gap = producer.applyIntent({ type: "expansion/toggle", fileKey: file.key, gapId });
    const line = gap.newRange[0];

    const started = applySessionReviewAction(
      producer,
      envelope(
        {
          type: "notes/start-draft",
          fileKey: file.key,
          hunkIndex: 1,
          target: { side: "new", line },
          expandedLineProof: {
            gapId,
            side: "new",
            line,
            sourceIdentity: file.sourceIdentity!,
          },
        },
        publication.generation,
      ),
    );
    expect(started.ok).toBe(true);

    const draft = producer.getReviewState()!.draftNote!;
    expect({ side: draft.side, line: draft.line, hunkIndex: draft.hunkIndex }).toEqual({
      side: "new",
      line,
      hunkIndex: 1,
    });
    expect(draft.expandedLineSource).toEqual({
      sourceIdentity: file.sourceIdentity,
      sourceAttested: true,
    });

    // Remote composition travels through the same semantic body-update intent as the terminal.
    expect(
      applySessionReviewAction(
        producer,
        envelope(
          { type: "notes/update-draft", body: "About this restored line" },
          publication.generation,
        ),
      ).ok,
    ).toBe(true);

    const disguisedRangeSave = applySessionReviewAction(
      producer,
      envelope(
        {
          type: "notes/create-user",
          consumeDraft: true,
          fileKey: file.key,
          hunkIndex: 1,
          target: { newRange: [line, line], preferred: { side: "new", line } },
        },
        publication.generation,
      ),
    );
    expect(disguisedRangeSave).toMatchObject({ ok: false, code: "draft-missing" });
    expect(producer.getReviewState()!.draftNote).not.toBeNull();

    // Saving with the same target as a precondition persists the note; its owner hunk is
    // the fallback the anchor resolver chose, which is the hunk the reviewer was reading.
    const saved = applySessionReviewAction(
      producer,
      envelope(
        {
          type: "notes/create-user",
          consumeDraft: true,
          target: { side: "new", line },
          expandedLineProof: { gapId, side: "new", line, sourceIdentity: file.sourceIdentity! },
        },
        publication.generation,
      ),
    );
    expect(saved.ok).toBe(true);

    const note = producer.getReviewState()!.userNotes.at(-1)!.note;
    expect(note.anchor.preferred).toEqual({ side: "new", line });
    // The line sits in no hunk's own span, so ownership is the fallback the caller
    // declared — the branch the prototype's broker copy dropped (D3).
    expect(note.anchor.intersectingHunkIndices).toEqual([]);
    expect(note.anchor.ownerHunkIndex).toBe(1);
  });

  test("edits a saved note in place and creates a nested reply", () => {
    const { producer, publication, file } = createTestProducer();
    expect(
      applySessionReviewAction(
        producer,
        envelope(
          { type: "notes/start-draft", fileKey: file.key, hunkIndex: 0 },
          publication.generation,
        ),
      ).ok,
    ).toBe(true);
    expect(
      applySessionReviewAction(
        producer,
        envelope({ type: "notes/update-draft", body: "original" }, publication.generation),
      ).ok,
    ).toBe(true);
    expect(
      applySessionReviewAction(
        producer,
        envelope({ type: "notes/create-user", consumeDraft: true }, publication.generation),
      ).ok,
    ).toBe(true);
    const root = producer.getReviewState()!.userNotes[0]!.note;

    expect(
      applySessionReviewAction(
        producer,
        envelope({ type: "notes/start-edit", noteId: root.id }, publication.generation),
      ).ok,
    ).toBe(true);
    applySessionReviewAction(
      producer,
      envelope({ type: "notes/update-draft", body: "edited" }, publication.generation),
    );
    expect(
      applySessionReviewAction(
        producer,
        envelope(
          { type: "notes/update-user", noteId: root.id, consumeDraft: true },
          publication.generation,
        ),
      ).ok,
    ).toBe(true);
    expect(producer.getReviewState()!.userNotes[0]!.note).toMatchObject({
      id: root.id,
      summary: "edited",
      createdAt: root.createdAt,
    });

    applySessionReviewAction(
      producer,
      envelope({ type: "notes/start-reply", noteId: root.id }, publication.generation),
    );
    applySessionReviewAction(
      producer,
      envelope({ type: "notes/update-draft", body: "reply" }, publication.generation),
    );
    applySessionReviewAction(
      producer,
      envelope({ type: "notes/create-user", consumeDraft: true }, publication.generation),
    );
    expect(producer.getReviewState()!.userNotes[1]!.note).toMatchObject({
      parentId: root.id,
      summary: "reply",
    });
  });

  test("refuses a proof whose gap no longer contains the line it names", () => {
    const { producer, publication, file } = createTestProducer();

    const result = applySessionReviewAction(
      producer,
      envelope(
        {
          type: "notes/start-draft",
          fileKey: file.key,
          hunkIndex: 1,
          target: { side: "new", line: 1 },
          expandedLineProof: {
            gapId: reviewGapId("before", 1),
            side: "new",
            line: 1,
            sourceIdentity: file.sourceIdentity!,
          },
        },
        publication.generation,
      ),
    );

    expect(result).toMatchObject({ ok: false, code: "gap-not-found" });
  });

  test("refuses a proof that describes a different line than the target it accompanies", () => {
    const { producer, publication, file } = createTestProducer();
    const gapId = reviewGapId("before", 1);
    const gap = producer.applyIntent({ type: "expansion/toggle", fileKey: file.key, gapId });

    const result = applySessionReviewAction(
      producer,
      envelope(
        {
          type: "notes/start-draft",
          fileKey: file.key,
          hunkIndex: 1,
          target: { side: "new", line: gap.newRange[0] },
          expandedLineProof: {
            gapId,
            side: "new",
            line: gap.newRange[0] + 1,
            sourceIdentity: file.sourceIdentity!,
          },
        },
        publication.generation,
      ),
    );

    expect(result).toMatchObject({ ok: false, code: "invalid-request" });
  });

  // Intent: a stated target on note creation is a precondition, so one surface cannot save
  // a draft another surface opened somewhere else.
  test("refuses to save a draft that is not where the caller believes it is", () => {
    const { producer, publication, file } = createTestProducer();
    producer.applyIntent(
      { type: "notes/start-draft", fileKey: file.key, hunkIndex: 0 },
      { draftId: "draft:1" },
    );

    const result = applySessionReviewAction(
      producer,
      envelope(
        {
          type: "notes/create-user",
          consumeDraft: true,
          fileKey: file.key,
          hunkIndex: 0,
          target: { side: "new", line: 999 },
        },
        publication.generation,
      ),
    );

    expect(result).toMatchObject({ ok: false, code: "draft-missing" });
  });
});

describe("readSessionReviewResource", () => {
  test("serves one verified window of a published resource", async () => {
    const { producer, publication, file } = createTestProducer();

    const result = await readSessionReviewResource(producer, {
      protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
      actor: ACTOR,
      request: {
        generation: publication.generation,
        resourceId: reviewResourceId({ kind: "patch", fileKey: file.key }),
        offset: 0,
        length: 1024,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.ok && Buffer.from(result.chunk.data, "base64").toString("utf8")).toBe(file.patch);
    expect(result.ok && result.chunk.eof).toBe(true);
  });

  test("refuses a read against a retired generation with the current one attached", async () => {
    const { producer } = createTestProducer();

    const result = await readSessionReviewResource(producer, {
      protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
      actor: ACTOR,
      request: {
        generation: "generation:test:9",
        resourceId: "resource:patch:file:deadbeef",
        offset: 0,
        length: 16,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "stale-generation",
      currentGeneration: producer.getPublication().generation,
    });
  });
});
