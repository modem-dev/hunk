import { describe, expect, test } from "bun:test";
import {
  MAX_GENERATION_IDENTIFIER_CHARACTERS,
  MAX_REGISTRATION_FILES,
  MAX_REGISTRATION_HUNKS_PER_FILE,
  MAX_SNAPSHOT_LIVE_COMMENTS,
  MAX_SNAPSHOT_REVIEW_NOTES,
} from "@hunk/session-broker-core";
import {
  createTestSessionRegistration,
  createTestSessionSnapshot,
} from "../../../test/helpers/session-daemon-fixtures";
import { MAX_REVIEW_RESOURCE_BYTES } from "../reviewProtocol";
import { parseSessionRegistration, parseSessionSnapshot } from "./wire";

function createRegistration(files: unknown[]) {
  return createTestSessionRegistration({ files: files as never[] });
}

function createFile(overrides: Record<string, unknown> = {}) {
  return {
    id: "file-1",
    path: "src/example.ts",
    additions: 1,
    deletions: 0,
    hunks: [{ index: 0, header: "@@ -1 +1 @@" }],
    ...overrides,
  };
}

function createRegistrationWithNote() {
  const registration = createRegistration([createFile()]);
  const file = registration.info.reviewManifest.files[0]!;
  file.notes.push({
    id: "note-1",
    source: "agent",
    origin: "live-agent",
    fileKey: file.key,
    anchor: { intersectingHunkIndices: [], ownerHunkIndex: 0 },
    summary: "Summary",
    editable: false,
  });
  return registration;
}

function createValidComment(overrides: Record<string, unknown> = {}) {
  return {
    commentId: "comment-1",
    filePath: "src/example.ts",
    hunkIndex: 0,
    side: "new",
    line: 4,
    summary: "Review note",
    createdAt: "2026-03-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("hunk session wire parsing", () => {
  test("snapshot parsing fails closed on malformed comments and contradictory counts", () => {
    const snapshot = parseSessionSnapshot(
      createTestSessionSnapshot({
        showAgentNotes: true,
        liveCommentCount: 5,
        liveComments: [
          createValidComment() as never,
          { filePath: "src/example.ts", summary: "Missing" } as never,
        ],
      }),
    );

    expect(snapshot).toBeNull();

    expect(
      parseSessionSnapshot(
        createTestSessionSnapshot({
          liveCommentCount: 2,
          liveComments: [createValidComment() as never],
        }),
      ),
    ).toBeNull();
  });

  test("snapshot carries valid note markup width and rejects malformed present values", () => {
    const parse = (noteMarkupWidth: unknown) =>
      parseSessionSnapshot(
        createTestSessionSnapshot({ noteMarkupWidth: noteMarkupWidth as never }),
      );

    expect(parse(112)?.state.noteMarkupWidth).toBe(112);
    expect(parse("wide")).toBeNull();
    expect(parse(undefined)).toBeNull();
    expect(
      parseSessionSnapshot(createTestSessionSnapshot())?.state.noteMarkupWidth,
    ).toBeUndefined();
  });

  test("registration parses app info from the nested broker envelope", () => {
    const registration = parseSessionRegistration(createTestSessionRegistration({ files: [] }));

    expect(registration?.info).toMatchObject({
      inputKind: "vcs",
      title: "repo working tree",
      sourceLabel: "/repo",
      experimentalFeatures: [],
      files: [],
    });
  });

  test("rejects oversized or invalid generations across retained producer projections", () => {
    const oversized = "g".repeat(300 * 1024);
    const oversizedRegistration = createTestSessionRegistration();
    oversizedRegistration.info.documentGeneration = oversized;
    oversizedRegistration.info.reviewManifest.generation = oversized;
    for (const resource of oversizedRegistration.info.reviewManifest.resources) {
      resource.generation = oversized;
    }
    expect(parseSessionRegistration(oversizedRegistration)).toBeNull();

    const descriptorGeneration = createTestSessionRegistration();
    descriptorGeneration.info.reviewManifest.resources[0]!.generation = oversized;
    expect(parseSessionRegistration(descriptorGeneration)).toBeNull();

    for (const generation of [
      "generation with spaces",
      "generation:💥",
      "g".repeat(MAX_GENERATION_IDENTIFIER_CHARACTERS + 1),
    ]) {
      const registration = createTestSessionRegistration();
      registration.info.documentGeneration = generation;
      registration.info.reviewManifest.generation = generation;
      for (const resource of registration.info.reviewManifest.resources) {
        resource.generation = generation;
      }
      expect(parseSessionRegistration(registration)).toBeNull();
    }

    const snapshot = createTestSessionSnapshot({
      documentGeneration: oversized,
      review: {
        ...createTestSessionSnapshot().state.review,
        documentGeneration: oversized,
      },
    });
    expect(parseSessionSnapshot(snapshot)).toBeNull();
  });

  test("registration accepts only canonical browser capability verifiers", () => {
    const registration = createTestSessionRegistration();
    registration.info.browserReviewCapabilityHash = "a".repeat(64);
    expect(parseSessionRegistration(registration)?.info.browserReviewCapabilityHash).toBe(
      "a".repeat(64),
    );

    registration.info.browserReviewCapabilityHash = "A".repeat(64);
    expect(parseSessionRegistration(registration)).toBeNull();
    registration.info.browserReviewCapabilityHash = "a".repeat(63);
    expect(parseSessionRegistration(registration)).toBeNull();
  });

  test("registration preserves complete note DTO text without dropping empty optional fields", () => {
    const registration = createRegistration([createFile()]);
    const file = registration.info.reviewManifest.files[0]!;
    file.notes.push({
      id: "note-1",
      source: "agent",
      origin: "live-agent",
      originalSource: "agent-tool",
      fileKey: file.key,
      anchor: { intersectingHunkIndices: [], ownerHunkIndex: 0 },
      summary: "Summary",
      rationale: "",
      markup: "",
      editable: false,
      tags: ["risk"],
      confidence: "medium",
    });
    expect(
      parseSessionRegistration(registration)?.info.reviewManifest.files[0]?.notes[0],
    ).toMatchObject({
      originalSource: "agent-tool",
      summary: "Summary",
      rationale: "",
      markup: "",
      tags: ["risk"],
      confidence: "medium",
    });
  });

  test("rejects every malformed present optional note field instead of normalizing it", () => {
    const mutations = [
      (note: Record<string, unknown>) => {
        (note.anchor as Record<string, unknown>).oldRange = [0, 1];
      },
      (note: Record<string, unknown>) => {
        (note.anchor as Record<string, unknown>).preferred = { side: "middle", line: 1 };
      },
      (note: Record<string, unknown>) => {
        (note.anchor as Record<string, unknown>).ownerHunkIndex = -1;
      },
      (note: Record<string, unknown>) => {
        note.rationale = 42;
      },
      (note: Record<string, unknown>) => {
        note.tags = "risk";
      },
      (note: Record<string, unknown>) => {
        note.confidence = "certain";
      },
    ];
    for (const mutate of mutations) {
      const registration = createRegistrationWithNote();
      mutate(
        registration.info.reviewManifest.files[0]!.notes[0] as unknown as Record<string, unknown>,
      );
      expect(parseSessionRegistration(registration)).toBeNull();
    }
  });

  test("rejects duplicate identities and mismatched source resource references", () => {
    const duplicateResource = createRegistration([createFile()]);
    duplicateResource.info.reviewManifest.resources.push({
      ...duplicateResource.info.reviewManifest.resources[0]!,
    });
    expect(parseSessionRegistration(duplicateResource)).toBeNull();

    const duplicateFile = createRegistration([
      createFile(),
      createFile({ id: "file-2", path: "b.ts" }),
    ]);
    duplicateFile.info.reviewManifest.files[1]!.key =
      duplicateFile.info.reviewManifest.files[0]!.key;
    expect(parseSessionRegistration(duplicateFile)).toBeNull();

    const duplicateNote = createRegistrationWithNote();
    duplicateNote.info.reviewManifest.files[0]!.notes.push({
      ...duplicateNote.info.reviewManifest.files[0]!.notes[0]!,
    });
    expect(parseSessionRegistration(duplicateNote)).toBeNull();

    const wrongSource = createRegistration([createFile()]);
    const file = wrongSource.info.reviewManifest.files[0]!;
    const patch = wrongSource.info.reviewManifest.resources[0]!;
    wrongSource.info.reviewManifest.resources.push({
      id: "resource:source",
      kind: "source",
      generation: patch.generation,
      fileKey: file.key,
      side: "old",
      contentType: "text/plain; charset=utf-8",
      sourceIdentity: "source:test",
    });
    file.sourceResourceIds.new = "resource:source";
    expect(parseSessionRegistration(wrongSource)).toBeNull();
  });

  test("accepts duplicate current paths when semantic entry keys remain distinct", () => {
    const registration = createRegistration([
      createFile({ id: "file-1", path: "duplicate.ts" }),
      createFile({ id: "file-2", path: "duplicate.ts" }),
    ]);
    const parsed = parseSessionRegistration(registration);
    expect(parsed?.info.reviewManifest.files.map((file) => file.path)).toEqual([
      "duplicate.ts",
      "duplicate.ts",
    ]);
    expect(new Set(parsed?.info.reviewManifest.files.map((file) => file.key)).size).toBe(2);
  });

  test("accepts dual partial ranges owned by the preferred side's full intersection", () => {
    const registration = createRegistration([createFile()]);
    const manifestFile = registration.info.reviewManifest.files[0]!;
    const hunks = [
      {
        index: 0,
        header: "@@ first @@",
        oldRange: [1, 3] as [number, number],
        newRange: [1, 1] as [number, number],
      },
      {
        index: 1,
        header: "@@ second @@",
        oldRange: [10, 10] as [number, number],
        newRange: [5, 7] as [number, number],
      },
    ];
    manifestFile.hunks = hunks;
    manifestFile.hunkCount = 2;
    registration.info.files[0]!.hunks = hunks;
    registration.info.files[0]!.hunkCount = 2;
    manifestFile.notes.push({
      id: "dual-partial",
      source: "agent",
      origin: "live-agent",
      fileKey: manifestFile.key,
      anchor: {
        oldRange: [2, 2],
        newRange: [2, 5],
        preferred: { side: "new", line: 2 },
        intersectingHunkIndices: [0, 1],
        ownerHunkIndex: 1,
      },
      summary: "Partial preferred range",
      editable: false,
    });
    expect(parseSessionRegistration(registration)).not.toBeNull();
  });

  test("rejects note anchors that conflict with owning file hunk geometry", () => {
    for (const mutate of [
      (anchor: Record<string, unknown>) => {
        anchor.intersectingHunkIndices = [1];
      },
      (anchor: Record<string, unknown>) => {
        anchor.ownerHunkIndex = 1;
      },
      (anchor: Record<string, unknown>) => {
        anchor.intersectingHunkIndices = [0];
      },
    ]) {
      const registration = createRegistrationWithNote();
      const anchor = registration.info.reviewManifest.files[0]!.notes[0]!
        .anchor as unknown as Record<string, unknown>;
      mutate(anchor);
      expect(parseSessionRegistration(registration)).toBeNull();
    }
  });

  test("rejects conflicting compatibility file projections", () => {
    const mutations = [
      (registration: ReturnType<typeof createRegistration>) => {
        registration.info.files[0]!.additions += 1;
      },
      (registration: ReturnType<typeof createRegistration>) => {
        registration.info.files[0]!.hunks[0] = {
          ...registration.info.files[0]!.hunks[0]!,
          header: "@@ conflicting @@",
        };
      },
      (registration: ReturnType<typeof createRegistration>) => {
        registration.info.files[0]!.flags!.binary = true;
      },
      (registration: ReturnType<typeof createRegistration>) => {
        registration.info.files.reverse();
      },
    ];
    for (const mutate of mutations) {
      const registration = JSON.parse(
        JSON.stringify(
          createRegistration([createFile(), createFile({ id: "file-2", path: "src/second.ts" })]),
        ),
      ) as ReturnType<typeof createRegistration>;
      mutate(registration);
      expect(parseSessionRegistration(registration)).toBeNull();
    }
  });

  test("requires every declared digest to be exactly one SHA-256 hex value", () => {
    for (const digest of ["abc", "g".repeat(64), "0".repeat(63), `${"0".repeat(64)}00`]) {
      const registration = createRegistration([createFile()]);
      registration.info.reviewManifest.resources[0]!.digest = digest;
      expect(parseSessionRegistration(registration)).toBeNull();
    }
  });

  test("registration preserves only recognized experimental feature ids", () => {
    const input = createTestSessionRegistration({ files: [] }) as unknown as {
      info: { experimentalFeatures: unknown[] };
    };
    input.info.experimentalFeatures = ["stml", "future-feature", "stml", 42];
    const registration = parseSessionRegistration(input);

    expect(registration?.info.experimentalFeatures).toEqual(["stml"]);
  });

  test("rejects registrations with more files than the cap", () => {
    const files = Array.from({ length: MAX_REGISTRATION_FILES + 1 }, (_, index) =>
      createFile({ id: `file-${index}`, path: `src/file-${index}.ts` }),
    );

    expect(parseSessionRegistration(createRegistration(files))).toBeNull();
  });

  test("rejects files with more hunks than the per-file cap", () => {
    const hunks = Array.from({ length: MAX_REGISTRATION_HUNKS_PER_FILE + 1 }, (_, index) => ({
      index,
      header: `@@ hunk ${index} @@`,
    }));

    expect(parseSessionRegistration(createRegistration([createFile({ hunks })]))).toBeNull();
  });

  test("rejects oversized resource descriptors", () => {
    const registration = createRegistration([createFile()]);
    registration.info.reviewManifest.resources[0]!.byteLength = MAX_REVIEW_RESOURCE_BYTES + 1;
    expect(parseSessionRegistration(registration)).toBeNull();
  });

  test("rejects eager patch bodies in registration", () => {
    const registration = createRegistration([createFile()]);
    (registration.info.files[0] as { patch?: string }).patch = "eager";
    expect(parseSessionRegistration(registration)).toBeNull();
  });

  test("rejects snapshots with more live comments than the cap", () => {
    const liveComments = Array.from({ length: MAX_SNAPSHOT_LIVE_COMMENTS + 1 }, (_, index) =>
      createValidComment({ commentId: `comment-${index}` }),
    );

    const snapshot = parseSessionSnapshot(
      createTestSessionSnapshot({ liveComments: liveComments as never[] }),
    );

    expect(snapshot).toBeNull();
  });

  test("rejects snapshots with more review notes than the cap", () => {
    const reviewNotes = Array.from({ length: MAX_SNAPSHOT_REVIEW_NOTES + 1 }, (_, index) => ({
      noteId: `note-${index}`,
      source: "user",
      filePath: "src/example.ts",
      body: "Looks good",
      createdAt: "2026-03-22T00:00:00.000Z",
    }));

    const snapshot = parseSessionSnapshot(
      createTestSessionSnapshot({ reviewNotes: reviewNotes as never[] }),
    );

    expect(snapshot).toBeNull();
  });
});
