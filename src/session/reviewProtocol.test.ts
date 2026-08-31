import { describe, expect, test } from "bun:test";
import { REVIEW_INTENT_TYPES, type ReviewIntent } from "../core/review/intents";
import { MAX_REVIEW_NOTE_BYTES, reviewNoteWithinSizeLimit } from "../core/review/noteSize";
import {
  REVIEW_CANONICAL_FILE_CONTENT_TYPE,
  REVIEW_PATCH_CONTENT_TYPE,
  REVIEW_SOURCE_CONTENT_TYPE,
  reviewResourceId,
} from "../core/review/resources";
import type { ReviewNoteV1 } from "../core/review/types";
import {
  HUNK_REVIEW_ACTION_TYPES,
  HUNK_REVIEW_PROTOCOL_VERSION,
  parseHunkReviewAction,
  parseHunkReviewActionEnvelope,
  parseHunkReviewActor,
  parseHunkReviewExpandedLineProof,
  parseHunkReviewResourceCatalog,
  parseHunkReviewResourceDescriptor,
  parseHunkReviewResourceReadEnvelope,
  parseHunkReviewPublicationAddress,
  toReviewIntent,
} from "./reviewProtocol";

const GENERATION = "generation:p1:3";
const FILE_KEY = "file:0123456789abcdef";
const ACTOR = { clientId: "client-1", kind: "browser" as const };

function envelope(action: unknown, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
    generation: GENERATION,
    actor: ACTOR,
    action,
    ...overrides,
  };
}

describe("review action vocabulary", () => {
  // Intent: B12 — the wire cannot forget an intent, because it does not list them.
  test("is the intent vocabulary", () => {
    expect([...HUNK_REVIEW_ACTION_TYPES]).toEqual([...REVIEW_INTENT_TYPES]);
  });

  test("names an action outside the vocabulary as unsupported, not malformed", () => {
    expect(parseHunkReviewAction({ type: "session/reload" })).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(parseHunkReviewAction({ filter: "x" })).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("review action round trip", () => {
  const intents: ReviewIntent[] = [
    {
      type: "selection/select",
      fileKey: FILE_KEY,
      hunkIndex: 2,
      reveal: { anchor: "hunk", scrollToNote: false },
    },
    { type: "selection/move", scope: "annotated-hunk", delta: -1 },
    { type: "selection/select-file", fileKey: FILE_KEY },
    { type: "selection/anchor", fileKey: FILE_KEY, hunkIndex: 0 },
    { type: "filter/set", filter: "src/ui" },
    { type: "notes/set-visibility", visible: true },
    { type: "notes/start-draft", fileKey: FILE_KEY, hunkIndex: 1 },
    { type: "notes/start-edit", noteId: "user:1" },
    { type: "notes/start-reply", noteId: "live:1" },
    { type: "notes/update-draft", body: "revised body" },
    { type: "notes/cancel-draft" },
    { type: "notes/create-user", consumeDraft: true },
    { type: "notes/update-user", noteId: "user:1", consumeDraft: true },
    { type: "notes/remove-user", noteId: "user:1" },
    { type: "notes/remove-live", noteId: "live:1" },
    { type: "notes/clear", fileKey: FILE_KEY, includeUser: true },
    { type: "expansion/toggle", fileKey: FILE_KEY, gapId: "before:1" },
  ];

  // Intent: every action type has a worked example, so a new intent that nobody exercised
  // fails here rather than at a client.
  test("exercises every action in the vocabulary", () => {
    expect(new Set(intents.map((intent) => intent.type))).toEqual(
      new Set(HUNK_REVIEW_ACTION_TYPES),
    );
  });

  for (const intent of intents) {
    test(`${intent.type} survives serialization unchanged`, () => {
      const parsed = parseHunkReviewAction(JSON.parse(JSON.stringify(intent)));
      expect(parsed.ok && toReviewIntent(parsed.value)).toEqual(intent);
    });
  }

  test("rejects an action carrying a field the intent does not have", () => {
    expect(parseHunkReviewAction({ type: "filter/set", filter: "x", reveal: true })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("rejects an action missing a field the intent requires", () => {
    expect(
      parseHunkReviewAction({ type: "selection/select", fileKey: FILE_KEY, hunkIndex: 0 }),
    ).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("rejects a scope outside the navigable ones", () => {
    expect(parseHunkReviewAction({ type: "selection/move", scope: "line", delta: 1 })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("expanded-line proof", () => {
  const proof = {
    gapId: "before:1",
    side: "new" as const,
    line: 5,
    sourceIdentity: "source:abc",
  };

  // Intent: B10 — an expanded-line note is expressible remotely at all.
  test("rides along with the draft target it is evidence for", () => {
    const action = {
      type: "notes/start-draft",
      fileKey: FILE_KEY,
      hunkIndex: 1,
      target: { side: "new", line: 5 },
      expandedLineProof: proof,
    };
    const parsed = parseHunkReviewAction(action);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toEqual(action as never);
    // Lowering strips the wire-only evidence; core plans the intent it derives from.
    expect(parsed.ok && toReviewIntent(parsed.value)).toEqual({
      type: "notes/start-draft",
      fileKey: FILE_KEY,
      hunkIndex: 1,
      target: { side: "new", line: 5 },
    });
  });

  test("rides along with the note creation it is a precondition for", () => {
    const parsed = parseHunkReviewAction({
      type: "notes/create-user",
      consumeDraft: true,
      target: { side: "new", line: 5 },
      expandedLineProof: proof,
    });

    expect(parsed.ok && toReviewIntent(parsed.value)).toEqual({
      type: "notes/create-user",
      consumeDraft: true,
    });
  });

  // Intent: evidence about nothing is a malformed action, not a tolerated extra.
  test("is refused without the line it is about", () => {
    expect(
      parseHunkReviewAction({
        type: "notes/start-draft",
        fileKey: FILE_KEY,
        hunkIndex: 1,
        expandedLineProof: proof,
      }),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  test("is refused when incomplete", () => {
    expect(
      parseHunkReviewExpandedLineProof({ ...proof, sourceIdentity: undefined }),
    ).toBeUndefined();
    expect(parseHunkReviewExpandedLineProof({ ...proof, line: 0 })).toBeUndefined();
    expect(parseHunkReviewExpandedLineProof({ ...proof, side: "both" })).toBeUndefined();
  });
});

describe("actor identity", () => {
  // Intent: G2 — actions carry who did them from the protocol's first version.
  test("accepts every declared actor kind, with an optional label", () => {
    for (const kind of ["terminal", "browser", "agent"] as const) {
      expect(parseHunkReviewActor({ clientId: "c", kind })).toEqual({ clientId: "c", kind });
    }
    expect(parseHunkReviewActor({ clientId: "c", kind: "agent", displayName: "Pi" })).toEqual({
      clientId: "c",
      kind: "agent",
      displayName: "Pi",
    });
  });

  test("refuses an unknown kind or a missing identity", () => {
    expect(parseHunkReviewActor({ clientId: "c", kind: "robot" })).toBeUndefined();
    expect(parseHunkReviewActor({ kind: "browser" })).toBeUndefined();
    expect(parseHunkReviewActor({ clientId: "", kind: "browser" })).toBeUndefined();
  });

  test("is required on every action envelope", () => {
    expect(
      parseHunkReviewActionEnvelope(envelope({ type: "notes/set-visibility", visible: true })).ok,
    ).toBe(true);
    const { actor: _actor, ...withoutActor } = envelope({
      type: "notes/set-visibility",
      visible: true,
    });
    expect(parseHunkReviewActionEnvelope(withoutActor)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("action envelope", () => {
  test("carries the position the client acted from", () => {
    const parsed = parseHunkReviewActionEnvelope(
      envelope({ type: "notes/set-visibility", visible: true }, { expectedStateRevision: 7 }),
    );
    expect(parsed.ok && parsed.value.expectedStateRevision).toBe(7);
  });

  test("refuses another protocol version or an unparseable generation", () => {
    const action = { type: "notes/set-visibility", visible: true };
    expect(parseHunkReviewActionEnvelope(envelope(action, { protocolVersion: 2 }))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(parseHunkReviewActionEnvelope(envelope(action, { generation: "gen-3" }))).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("reports an unsupported action through the envelope that carried it", () => {
    expect(parseHunkReviewActionEnvelope(envelope({ type: "trust/decide" }))).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });
});

describe("resource read envelope", () => {
  test("accepts one bounded request", () => {
    const parsed = parseHunkReviewResourceReadEnvelope({
      protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
      actor: ACTOR,
      request: {
        generation: GENERATION,
        resourceId: "resource:patch:" + FILE_KEY,
        offset: 0,
        length: 1024,
      },
    });
    expect(parsed.ok).toBe(true);
  });

  test("refuses a window outside the shared chunk bound", () => {
    expect(
      parseHunkReviewResourceReadEnvelope({
        protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
        actor: ACTOR,
        request: {
          generation: GENERATION,
          resourceId: "resource:patch:" + FILE_KEY,
          offset: 0,
          length: 1024 * 1024,
        },
      }),
    ).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("resource descriptors", () => {
  const patch = {
    id: reviewResourceId({ kind: "patch", fileKey: FILE_KEY }),
    generation: GENERATION,
    fileKey: FILE_KEY,
    kind: "patch",
    contentType: REVIEW_PATCH_CONTENT_TYPE,
  };

  test("accepts an unmeasured descriptor and a fully measured one", () => {
    expect(parseHunkReviewResourceDescriptor(patch)).toEqual(patch as never);
    expect(
      parseHunkReviewResourceDescriptor({ ...patch, byteLength: 12, digest: "a".repeat(64) }),
    ).toBeDefined();
  });

  // Intent: a descriptor with half a measurement cannot be verified when read.
  test("refuses a descriptor carrying a size without a digest", () => {
    expect(parseHunkReviewResourceDescriptor({ ...patch, byteLength: 12 })).toBeUndefined();
    expect(parseHunkReviewResourceDescriptor({ ...patch, digest: "a".repeat(64) })).toBeUndefined();
  });

  // Intent: D5 — one canonical digest form, checked by the shared validator.
  test("refuses a digest outside the canonical lowercase form", () => {
    expect(
      parseHunkReviewResourceDescriptor({ ...patch, byteLength: 1, digest: "A".repeat(64) }),
    ).toBeUndefined();
  });

  test("refuses a descriptor whose id disagrees with its own fields", () => {
    expect(parseHunkReviewResourceDescriptor({ ...patch, kind: "canonical-file" })).toBeUndefined();
    expect(
      parseHunkReviewResourceDescriptor({ ...patch, contentType: REVIEW_SOURCE_CONTENT_TYPE }),
    ).toBeUndefined();
  });

  test("requires a source descriptor to name its side and identity", () => {
    const source = {
      id: reviewResourceId({ kind: "source", fileKey: FILE_KEY, side: "new" }),
      generation: GENERATION,
      fileKey: FILE_KEY,
      kind: "source",
      contentType: REVIEW_SOURCE_CONTENT_TYPE,
      side: "new",
      sourceIdentity: "source:abc",
    };
    expect(parseHunkReviewResourceDescriptor(source)).toEqual(source as never);
    expect(parseHunkReviewResourceDescriptor({ ...source, side: "old" })).toBeUndefined();
    const { sourceIdentity: _identity, ...withoutIdentity } = source;
    expect(parseHunkReviewResourceDescriptor(withoutIdentity)).toBeUndefined();
  });
});

describe("resource catalog", () => {
  const catalog = {
    generation: GENERATION,
    fileKeysByRuntimeId: { "file-1": FILE_KEY },
    resources: [
      {
        id: reviewResourceId({ kind: "canonical-file", fileKey: FILE_KEY }),
        generation: GENERATION,
        fileKey: FILE_KEY,
        kind: "canonical-file",
        contentType: REVIEW_CANONICAL_FILE_CONTENT_TYPE,
      },
      {
        id: reviewResourceId({ kind: "patch", fileKey: FILE_KEY }),
        generation: GENERATION,
        fileKey: FILE_KEY,
        kind: "patch",
        contentType: REVIEW_PATCH_CONTENT_TYPE,
      },
    ],
  };

  test("accepts a catalog whose descriptors all belong to its generation", () => {
    expect(parseHunkReviewResourceCatalog(catalog)).toEqual(catalog as never);
  });

  test("refuses a descriptor from another generation", () => {
    expect(
      parseHunkReviewResourceCatalog({
        ...catalog,
        resources: [{ ...catalog.resources[0]!, generation: "generation:p1:4" }],
      }),
    ).toBeUndefined();
  });

  test("refuses more files than the resource count can account for", () => {
    expect(
      parseHunkReviewResourceCatalog({
        ...catalog,
        fileKeysByRuntimeId: { a: "1", b: "2", c: "3" },
        resources: [catalog.resources[0]!],
      }),
    ).toBeUndefined();
  });
});

describe("publication address", () => {
  test("accepts exactly a generation and a revision", () => {
    expect(parseHunkReviewPublicationAddress({ generation: GENERATION, stateRevision: 4 })).toEqual(
      {
        generation: GENERATION,
        stateRevision: 4,
      },
    );
    expect(
      parseHunkReviewPublicationAddress({ generation: GENERATION, stateRevision: -1 }),
    ).toBeUndefined();
    expect(
      parseHunkReviewPublicationAddress({ generation: GENERATION, stateRevision: 4, extra: 1 }),
    ).toBeUndefined();
  });
});

describe("note transport bounds", () => {
  /** One note whose every text field fits the bound while the note as a whole does not. */
  function oversizedNote(): ReviewNoteV1 {
    const twoThirds = "x".repeat(Math.floor(MAX_REVIEW_NOTE_BYTES * 0.7));
    return {
      id: "user:1",
      source: "user",
      fileKey: FILE_KEY,
      anchor: { intersectingHunkIndices: [0], ownerHunkIndex: 0 },
      summary: twoThirds,
      rationale: twoThirds,
      markup: twoThirds,
      editable: true,
    };
  }

  // Intent: D1 — the case the prototype's two rules disagreed at. Every field passes a
  // per-field check; the note is three times the bound, and the wire tier answers with the
  // shared bound rather than admitting it and poisoning the snapshot that publishes it.
  test("refuses a note whose fields each fit but whose whole does not", () => {
    const note = oversizedNote();
    for (const field of [note.summary, note.rationale!, note.markup!]) {
      expect(field.length).toBeLessThanOrEqual(MAX_REVIEW_NOTE_BYTES);
    }
    expect(reviewNoteWithinSizeLimit(note)).toBe(false);
  });

  test("accepts a note within the shared bound", () => {
    expect(
      reviewNoteWithinSizeLimit({
        id: "user:1",
        source: "user",
        fileKey: FILE_KEY,
        anchor: { intersectingHunkIndices: [0], ownerHunkIndex: 0 },
        summary: "Tighten this wording",
        editable: true,
      }),
    ).toBe(true);
  });
});
