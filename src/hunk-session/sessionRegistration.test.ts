import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import type { AppBootstrap } from "../core/types";
import { SESSION_BROKER_REGISTRATION_VERSION } from "@hunk/session-broker-core";
import {
  createInitialSessionSnapshot,
  createSessionRegistration,
  updateSessionRegistration,
} from "./sessionRegistration";

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
  };
}

describe("session registration", () => {
  // Intent: registration preserves daemon-facing repo, file, patch, and hunk metadata.
  test("createSessionRegistration exports review files with hunks and repo-root selection", () => {
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
        files: [
          {
            id: "file-1",
            path: "src/example.ts",
            previousPath: "src/old-example.ts",
            additions: 1,
            deletions: 1,
            hunkCount: 1,
            patch: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
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

  // Intent: reloads refresh review metadata without changing the live session identity.
  test("updateSessionRegistration preserves identity while refreshing input metadata", () => {
    const current = createSessionRegistration(createBootstrap());
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
    expect(updated.info).toEqual({
      inputKind: "patch",
      title: "patch file",
      sourceLabel: "change.patch",
      files: [],
    });
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
    });
  });
});
