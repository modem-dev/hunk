import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import { reviewProcessCapability } from "../review/capability";
import { buildReviewPublication } from "../review/publication";
import type { AppBootstrap } from "../../core/bootstrap";
import { SESSION_BROKER_REGISTRATION_VERSION } from "@hunk/session-broker-core";
import {
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

/** Publish one generation of a bootstrap, the way the host does before registering. */
function publish(bootstrap: AppBootstrap) {
  return buildReviewPublication({
    files: bootstrap.changeset.files,
    generation: "generation:test:0",
    sourceLabel: bootstrap.changeset.sourceLabel,
  });
}

describe("session registration", () => {
  // Intent: registration preserves daemon-facing repo, file, and hunk metadata, and
  // advertises the generation's resources instead of embedding patch bodies.
  test("createSessionRegistration exports review files with hunks and repo-root selection", () => {
    const registration = createSessionRegistration(createBootstrap(), publish(createBootstrap()));

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
    expect(registration.info.files[0]?.hunks[0]).toMatchObject({
      index: 0,
      oldRange: [1, 1],
      newRange: [1, 1],
    });
  });

  test("registration and initial selection preserve exact Unicode rename paths", () => {
    const bootstrap = createBootstrap();
    const file = bootstrap.changeset.files[0]!;
    bootstrap.changeset.files = [
      { ...file, path: "国際化/한국어-🧪.txt", previousPath: "国際化/日本語.txt" },
    ];

    const registration = createSessionRegistration(bootstrap, publish(bootstrap));
    const snapshot = createInitialSessionSnapshot(bootstrap, publish(bootstrap));

    expect(registration.info.files[0]).toMatchObject({
      path: "国際化/한국어-🧪.txt",
      previousPath: "国際化/日本語.txt",
    });
    expect(snapshot.state.selectedFilePath).toBe("国際化/한국어-🧪.txt");
  });

  // Intent: reloads refresh review metadata without changing the live session identity.
  test("updateSessionRegistration preserves identity while refreshing input metadata", () => {
    const current = createSessionRegistration(createBootstrap(), publish(createBootstrap()));
    const nextBootstrap = createBootstrap({
      input: { kind: "patch", file: "change.patch", options: {} },
      changeset: {
        id: "changeset-2",
        title: "patch file",
        sourceLabel: "change.patch",
        files: [],
      },
    });

    const updated = updateSessionRegistration(current, nextBootstrap, publish(nextBootstrap));

    expect(updated.sessionId).toBe(current.sessionId);
    expect(updated.pid).toBe(current.pid);
    expect(updated.repoRoot).toBeUndefined();
    expect(updated.info).toEqual({
      inputKind: "patch",
      title: "patch file",
      sourceLabel: "change.patch",
      experimentalFeatures: [],
      files: [],
      reviewCatalog: { generation: "generation:test:0", fileKeysByRuntimeId: {}, resources: [] },
      reviewCapabilityDigest: reviewProcessCapability().digest,
    });
    // A reload replaces the review, not the session, so a review link already opened keeps
    // working across one.
    expect(updated.info.reviewCapabilityDigest).toBe(current.info.reviewCapabilityDigest);
  });

  test("registration create and update project delegated review metadata atomically", () => {
    const review = {
      kind: "change-request" as const,
      provider: "GitHub",
      title: "Add session metadata",
      id: "#123",
      repository: "modem-dev/hunk",
      state: "open" as const,
    };
    const bootstrap = createBootstrap({ review });
    const created = createSessionRegistration(bootstrap, publish(bootstrap));
    expect(created.info.review).toEqual(review);

    const preserved = updateSessionRegistration(created, bootstrap, publish(bootstrap));
    expect(preserved.info.review).toEqual(review);

    const unrelated = createBootstrap();
    const cleared = updateSessionRegistration(preserved, unrelated, publish(unrelated));
    expect(cleared.info.review).toBeUndefined();
    expect(cleared.info.files).toHaveLength(1);
  });

  test("registration advertises STML only for opted-in launches", () => {
    const experimental = createBootstrap({
      input: { kind: "vcs", staged: false, options: { experimental: true } },
    });
    const registration = createSessionRegistration(experimental, publish(experimental));

    expect(registration.info.experimentalFeatures).toEqual(["stml"]);
  });

  // Intent: initial snapshots expose first-hunk focus and configured note visibility.
  test("createInitialSessionSnapshot starts with the first hunk and note visibility", () => {
    const bootstrap = createBootstrap();
    const snapshot = createInitialSessionSnapshot(bootstrap, publish(bootstrap));

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
      reviewPublication: { generation: "generation:test:0", stateRevision: 0 },
    });
  });

  // Intent: empty reviews still publish a valid, explicit daemon snapshot.
  test("createInitialSessionSnapshot handles empty changesets", () => {
    const empty = createBootstrap({
      changeset: { id: "empty", title: "empty", sourceLabel: "/repo", files: [] },
      initialShowAgentNotes: false,
    });
    const snapshot = createInitialSessionSnapshot(empty, publish(empty));

    expect(snapshot.state).toEqual({
      selectedFileId: undefined,
      selectedFilePath: undefined,
      selectedHunkIndex: 0,
      selectedHunkOldRange: undefined,
      selectedHunkNewRange: undefined,
      showAgentNotes: false,
      liveCommentCount: 0,
      liveComments: [],
      reviewNoteCount: 0,
      reviewNotes: [],
      reviewPublication: { generation: "generation:test:0", stateRevision: 0 },
    });
  });

  // Intent: the daemon can address every resource of the generation it mirrors, and can
  // map the renderer file ids the session surface uses onto the semantic keys resources
  // are addressed by.
  test("createSessionRegistration accepts the owning surface's authoritative cwd", () => {
    const bootstrap = createBootstrap();
    const registration = createSessionRegistration(bootstrap, publish(bootstrap), "embedded-cwd");
    expect(registration.cwd).toBe("embedded-cwd");
  });

  test("createSessionRegistration advertises the generation's resource catalog", () => {
    const bootstrap = createBootstrap();
    const publication = publish(bootstrap);
    const registration = createSessionRegistration(bootstrap, publication);
    const catalog = registration.info.reviewCatalog;
    const fileKey = publication.document.files[0]!.key;

    expect(catalog?.generation).toBe("generation:test:0");
    expect(catalog?.fileKeysByRuntimeId).toEqual({ "file-1": fileKey });
    expect(catalog?.resources.map((resource) => resource.kind).sort()).toEqual([
      "canonical-file",
      "patch",
    ]);
    expect(
      catalog?.resources.every((resource) => resource.generation === "generation:test:0"),
    ).toBe(true);
  });
});
