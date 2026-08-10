import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import type { AppBootstrap } from "../../core/types";
import { SESSION_BROKER_REGISTRATION_VERSION, utf8ByteLength } from "@hunk/session-broker-core";
import { MAX_REVIEW_MANIFEST_BYTES, MAX_REVIEW_PRODUCER_METADATA_BYTES } from "../reviewProtocol";
import { parseSessionRegistration, parseSessionSnapshot } from "../broker/wire";
import {
  assertSessionRegistrationEnvelopeWithinBounds,
  createInitialSessionSnapshot,
  createSessionRegistration,
  updateSessionRegistration,
} from "./registration";

function createBootstrap(overrides: Partial<AppBootstrap> = {}): AppBootstrap {
  const file = createTestDiffFile({
    id: "file-1",
    path: "src/example.ts",
    previousPath: "src/old-example.ts",
    before: "export const value = 1;\n",
    after: "export const value = 2;\n",
  });

  return {
    input: { kind: "vcs", staged: false, options: {} },
    changeset: {
      id: "changeset-1",
      title: "working tree",
      sourceLabel: "/repo",
      files: [
        {
          ...file,
          patch: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        },
      ],
    },
    initialMode: "split",
    initialShowAgentNotes: true,
    ...overrides,
    reloadContext: overrides.reloadContext ?? { cwd: "/repo" },
  };
}

describe("session registration", () => {
  // Intent: registration preserves ordered metadata while patch bodies remain resources.
  test("createSessionRegistration exports bounded review metadata and repo-root selection", () => {
    const registration = createSessionRegistration(createBootstrap());

    expect(registration).toMatchObject({
      registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
      pid: process.pid,
      cwd: process.cwd(),
      repoRoot: "/repo",
      info: {
        inputKind: "vcs",
        title: "working tree",
        sourceLabel: "/repo",
        experimentalFeatures: [],
        files: [
          {
            id: "file-1",
            path: "src/example.ts",
            previousPath: "src/old-example.ts",
            additions: 1,
            deletions: 1,
            hunkCount: 1,
          },
        ],
      },
    });
    expect(registration.sessionId).toBeString();
    expect(registration.launchedAt).toBeString();
    expect(registration.info.files[0]?.patch).toBeUndefined();
    expect(registration.info.reviewManifest.resources[0]).toMatchObject({
      kind: "patch",
      byteLength: expect.any(Number),
      digest: expect.any(String),
    });
    expect(
      registration.info.reviewManifest.resources.find(
        (resource) => resource.kind === "canonical-file",
      ),
    ).toMatchObject({
      fileKey: registration.info.reviewManifest.files[0]!.key,
      byteLength: expect.any(Number),
      digest: expect.any(String),
    });
    expect(registration.info.files[0]?.hunks[0]).toMatchObject({
      index: 0,
      oldRange: [1, 1],
      newRange: [1, 1],
    });
  });

  test("pure additions and deletions omit zero-line sentinel ranges on the broker wire", () => {
    const bootstrap = createBootstrap();
    const addition = createTestDiffFile({
      id: "added-file",
      path: "src/added.ts",
      before: "",
      after: "export const added = true;\n",
    });
    const deletion = createTestDiffFile({
      id: "deleted-file",
      path: "src/deleted.ts",
      before: "export const deleted = true;\n",
      after: "",
    });
    bootstrap.changeset.files = [
      {
        ...addition,
        patch: "@@ -0,0 +1 @@\n+export const added = true;\n",
      },
      {
        ...deletion,
        patch: "@@ -1 +0,0 @@\n-export const deleted = true;\n",
      },
    ];

    const registration = createSessionRegistration(bootstrap);
    const snapshot = createInitialSessionSnapshot(bootstrap);

    expect(registration.info.reviewManifest.files[0]?.hunks[0]).toMatchObject({
      newRange: [1, 1],
    });
    expect(registration.info.reviewManifest.files[0]?.hunks[0]).not.toHaveProperty("oldRange");
    expect(registration.info.reviewManifest.files[1]?.hunks[0]).toMatchObject({
      oldRange: [1, 1],
    });
    expect(registration.info.reviewManifest.files[1]?.hunks[0]).not.toHaveProperty("newRange");
    expect(snapshot.state).not.toHaveProperty("selectedHunkOldRange");
    expect(snapshot.state.selectedHunkNewRange).toEqual([1, 1]);
    expect(parseSessionRegistration(registration)).not.toBeNull();
    expect(parseSessionSnapshot(snapshot)).not.toBeNull();
  });

  test("registration preserves duplicate current paths through distinct semantic keys", () => {
    const bootstrap = createBootstrap();
    const first = bootstrap.changeset.files[0]!;
    bootstrap.changeset.files = [first, { ...first, id: "file-2" }];
    const registration = createSessionRegistration(bootstrap);
    expect(registration.info.reviewManifest.files.map((file) => file.path)).toEqual([
      "src/example.ts",
      "src/example.ts",
    ]);
    expect(new Set(registration.info.reviewManifest.files.map((file) => file.key)).size).toBe(2);
  });

  test("manifest exposes exact stats flags and agent summary for shared filtering", () => {
    const bootstrap = createBootstrap();
    const file = bootstrap.changeset.files[0]!;
    bootstrap.changeset.files = [
      {
        ...file,
        statsTruncated: true,
        isUntracked: true,
        agent: { path: file.path, summary: "needle browser summary", annotations: [] },
      },
    ];
    const manifestFile = createSessionRegistration(bootstrap).info.reviewManifest.files[0]!;
    expect(manifestFile).toMatchObject({
      agentSummary: "needle browser summary",
      additions: 1,
      deletions: 1,
      statsTruncated: true,
      flags: { untracked: true, binary: false, tooLarge: false, partial: false },
    });
  });

  test("registration and initial selection preserve exact Unicode rename paths", () => {
    const bootstrap = createBootstrap();
    const file = bootstrap.changeset.files[0]!;
    bootstrap.changeset.files = [
      { ...file, path: "国際化/한국어-🧪.txt", previousPath: "国際化/日本語.txt" },
    ];

    const registration = createSessionRegistration(bootstrap);
    const snapshot = createInitialSessionSnapshot(bootstrap);

    expect(registration.info.files[0]).toMatchObject({
      path: "国際化/한국어-🧪.txt",
      previousPath: "国際化/日本語.txt",
    });
    expect(snapshot.state.selectedFilePath).toBe("国際化/한국어-🧪.txt");
  });

  // Intent: reloads refresh review metadata without changing the live session identity.
  test("updateSessionRegistration preserves identity while refreshing input metadata", () => {
    const current = createSessionRegistration(createBootstrap(), undefined, {
      browserReviewCapabilityHash: "a".repeat(64),
    });
    const nextBootstrap = createBootstrap({
      input: { kind: "patch", file: "change.patch", options: {} },
      changeset: {
        id: "changeset-2",
        title: "patch file",
        sourceLabel: "change.patch",
        files: [],
      },
    });

    const updated = updateSessionRegistration(current, nextBootstrap);

    expect(updated.sessionId).toBe(current.sessionId);
    expect(updated.pid).toBe(current.pid);
    expect(updated.repoRoot).toBeUndefined();
    expect(updated.info.browserReviewCapabilityHash).toBe("a".repeat(64));
    expect(updated.info).toMatchObject({
      inputKind: "patch",
      title: "patch file",
      sourceLabel: "change.patch",
      experimentalFeatures: [],
      files: [],
    });
    expect(updated.info.documentGeneration).toBe(updated.info.reviewManifest.generation);
  });

  test("manifest preserves complete note DTO metadata without lossy summary projection", () => {
    const bootstrap = createBootstrap({
      input: { kind: "vcs", staged: false, options: { experimental: true } },
    });
    bootstrap.changeset.files[0]!.agent = {
      path: "src/example.ts",
      annotations: [
        {
          id: "note-complete",
          source: "agent",
          summary: "Summary",
          rationale: "Rationale",
          markup: "<p>Markup</p>",
          title: "Title",
          author: "Pi",
          tags: ["risk"],
          confidence: "high",
          newRange: [1, 1],
        },
      ],
    };
    const registration = createSessionRegistration(bootstrap);
    expect(registration.info.reviewManifest.files[0]?.notes[0]).toMatchObject({
      id: "note-complete",
      originalSource: "agent",
      summary: "Summary",
      rationale: "Rationale",
      markup: "<p>Markup</p>",
      title: "Title",
      author: "Pi",
      tags: ["risk"],
      confidence: "high",
    });
    const snapshot = createInitialSessionSnapshot(bootstrap);
    expect(snapshot.state.review.notes).toEqual([]);
    expect(snapshot.state.reviewNotes?.[0]).toMatchObject({ noteId: "note-complete" });
  });

  test("bounds the complete note-heavy registration frame with websocket margin", () => {
    const registration = createSessionRegistration(createBootstrap());
    const snapshot = createInitialSessionSnapshot(createBootstrap());
    const file = registration.info.reviewManifest.files[0]!;
    const rationale = "r".repeat(190_000);
    for (let index = 0; index < 18; index += 1) {
      file.notes.push({
        id: `note-${index}`,
        source: "ai",
        origin: "sidecar",
        fileKey: file.key,
        anchor: { intersectingHunkIndices: [], ownerHunkIndex: 0 },
        summary: "Summary",
        rationale,
        editable: false,
      });
      snapshot.state.reviewNotes!.push({
        noteId: `note-${index}`,
        source: "ai",
        filePath: file.path,
        body: `Summary\n\n${rationale}`,
        createdAt: "1970-01-01T00:00:00.000Z",
        editable: false,
      });
    }
    snapshot.state.reviewNoteCount = snapshot.state.reviewNotes!.length;
    expect(() =>
      assertSessionRegistrationEnvelopeWithinBounds(registration, snapshot),
    ).not.toThrow();

    for (let index = 18; index < 22; index += 1) {
      file.notes.push({
        id: `note-${index}`,
        source: "ai",
        origin: "sidecar",
        fileKey: file.key,
        anchor: { intersectingHunkIndices: [], ownerHunkIndex: 0 },
        summary: "Summary",
        rationale,
        editable: false,
      });
      snapshot.state.reviewNotes!.push({
        noteId: `note-${index}`,
        source: "ai",
        filePath: file.path,
        body: `Summary\n\n${rationale}`,
        createdAt: "1970-01-01T00:00:00.000Z",
        editable: false,
      });
    }
    expect(utf8ByteLength(JSON.stringify(registration.info.reviewManifest))).toBeLessThan(
      MAX_REVIEW_MANIFEST_BYTES,
    );
    expect(utf8ByteLength(JSON.stringify(snapshot))).toBeLessThan(
      MAX_REVIEW_PRODUCER_METADATA_BYTES,
    );
    expect(() => assertSessionRegistrationEnvelopeWithinBounds(registration, snapshot)).toThrow(
      "websocket envelope limit",
    );
  });

  test("registration advertises STML only for opted-in launches", () => {
    const registration = createSessionRegistration(
      createBootstrap({
        input: { kind: "vcs", staged: false, options: { experimental: true } },
      }),
    );

    expect(registration.info.experimentalFeatures).toEqual(["stml"]);
  });

  // Intent: initial snapshots expose first-hunk focus and configured note visibility.
  test("createInitialSessionSnapshot starts with the first hunk and note visibility", () => {
    const snapshot = createInitialSessionSnapshot(createBootstrap());

    expect(snapshot.state).toMatchObject({
      selectedFileId: "file-1",
      selectedFilePath: "src/example.ts",
      selectedHunkIndex: 0,
      selectedHunkOldRange: [1, 1],
      selectedHunkNewRange: [1, 1],
      showAgentNotes: true,
      liveCommentCount: 0,
      liveComments: [],
      reviewNoteCount: 0,
      reviewNotes: [],
    });
  });

  // Intent: empty reviews still publish a valid, explicit daemon snapshot.
  test("createInitialSessionSnapshot handles empty changesets", () => {
    const snapshot = createInitialSessionSnapshot(
      createBootstrap({
        changeset: {
          id: "empty",
          title: "empty",
          sourceLabel: "/repo",
          files: [],
        },
        initialShowAgentNotes: false,
      }),
    );

    expect(snapshot.state).toMatchObject({
      selectedHunkIndex: 0,
      showAgentNotes: false,
      liveCommentCount: 0,
      liveComments: [],
      reviewNoteCount: 0,
      reviewNotes: [],
    });
    expect(snapshot.state).not.toHaveProperty("selectedFileId");
    expect(snapshot.state).not.toHaveProperty("selectedFilePath");
    expect(snapshot.state).not.toHaveProperty("selectedHunkOldRange");
    expect(snapshot.state).not.toHaveProperty("selectedHunkNewRange");
  });
});
