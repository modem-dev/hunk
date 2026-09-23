/**
 * Builds the fullest deterministic session registration and snapshot payload for every review
 * launch mode, so a wire-shape change is visible as a fixture diff.
 *
 * The corpus goes through the real `createSessionRegistration` / `updateSessionRegistration`
 * builders and then pins the volatile envelope facts (ids, pids, timestamps, digests) to fixed
 * values. Every optional field is populated, and each exported object type is covered by an
 * exhaustive key list that the compiler checks against the type, so adding a field to a
 * session type without adding it here fails `bun run typecheck` before it can slip past the
 * fixture.
 */
import type { AppBootstrap } from "../../packages/hunk/src/core/bootstrap";
import type { CliInput } from "../../packages/hunk/src/core/run/commandInputs";
import type {
  ExtensionChangeRequestReviewDescriptor,
  ExtensionCommitReviewDescriptor,
  ExtensionComparisonCommitDescriptor,
  ExtensionComparisonReviewDescriptor,
  ExtensionReviewDescriptor,
} from "../../packages/hunk/src/extension-api/types";
import { buildReviewPublication } from "../../packages/hunk/src/app/review/publication";
import {
  createInitialSessionSnapshot,
  createSessionRegistration,
  updateSessionRegistration,
} from "../../packages/hunk/src/app/session/registration";
import type {
  HunkSessionInfo,
  HunkSessionRegistration,
  HunkSessionSnapshot,
  HunkSessionState,
  SessionLiveCommentSummary,
  SessionReviewFile,
  SessionReviewHunk,
  SessionReviewNoteSummary,
} from "../../packages/hunk/src/session/types";
import { createTestDiffFile } from "./diff-helpers";

/** Compile-time exhaustive key tuple for one object type; the runtime value is the same tuple. */
function exhaustiveKeys<T extends object>() {
  return <const K extends readonly (keyof T)[]>(
    keys: K & ([keyof T] extends [K[number]] ? unknown : never),
  ) => keys;
}

const REGISTRATION_KEYS = exhaustiveKeys<HunkSessionRegistration>()([
  "registrationVersion",
  "sessionId",
  "pid",
  "cwd",
  "repoRoot",
  "launchedAt",
  "terminal",
  "info",
]);
const INFO_KEYS = exhaustiveKeys<HunkSessionInfo>()([
  "inputKind",
  "title",
  "sourceLabel",
  "experimentalFeatures",
  "review",
  "files",
  "reviewCatalog",
  "reviewCapabilityDigest",
]);
const FILE_KEYS = exhaustiveKeys<SessionReviewFile>()([
  "id",
  "path",
  "previousPath",
  "additions",
  "deletions",
  "hunkCount",
  "patch",
  "hunks",
]);
const HUNK_KEYS = exhaustiveKeys<SessionReviewHunk>()(["index", "header", "oldRange", "newRange"]);
const SNAPSHOT_KEYS = exhaustiveKeys<HunkSessionSnapshot>()(["updatedAt", "state"]);
const STATE_KEYS = exhaustiveKeys<HunkSessionState>()([
  "selectedFileId",
  "selectedFilePath",
  "selectedHunkIndex",
  "selectedHunkOldRange",
  "selectedHunkNewRange",
  "showAgentNotes",
  "noteMarkupWidth",
  "liveCommentCount",
  "liveComments",
  "reviewNoteCount",
  "reviewNotes",
  "reviewPublication",
]);
const LIVE_COMMENT_KEYS = exhaustiveKeys<SessionLiveCommentSummary>()([
  "commentId",
  "parentId",
  "filePath",
  "hunkIndex",
  "side",
  "line",
  "summary",
  "rationale",
  "author",
  "createdAt",
]);
const REVIEW_NOTE_KEYS = exhaustiveKeys<SessionReviewNoteSummary>()([
  "noteId",
  "parentId",
  "source",
  "filePath",
  "hunkIndex",
  "oldRange",
  "newRange",
  "body",
  "title",
  "author",
  "createdAt",
  "updatedAt",
  "editable",
]);
const CHANGE_REQUEST_KEYS = exhaustiveKeys<ExtensionChangeRequestReviewDescriptor>()([
  "kind",
  "provider",
  "title",
  "url",
  "id",
  "repository",
  "author",
  "base",
  "head",
  "state",
  "draft",
]);
const COMMIT_KEYS = exhaustiveKeys<ExtensionCommitReviewDescriptor>()([
  "kind",
  "provider",
  "title",
  "url",
  "revision",
  "displayRevision",
  "author",
  "authoredAt",
]);
const COMPARISON_KEYS = exhaustiveKeys<ExtensionComparisonReviewDescriptor>()([
  "kind",
  "provider",
  "title",
  "url",
  "base",
  "head",
  "commitCount",
  "commits",
]);
const COMPARISON_COMMIT_KEYS = exhaustiveKeys<ExtensionComparisonCommitDescriptor>()([
  "title",
  "author",
  "authoredAt",
  "revision",
  "displayRevision",
]);

const FIXED_SESSION_ID = "00000000-0000-4000-8000-000000000000";
const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const FIXED_CAPABILITY_DIGEST = "0".repeat(64);
const FIXED_GENERATION = "generation:wire-corpus:1";

export interface SessionWireCorpusEntry {
  /** The launch mode this entry exercises, plus a qualifier when a mode has several shapes. */
  name: string;
  registration: HunkSessionRegistration;
  snapshot: HunkSessionSnapshot;
}

/** Assert that one object carries every key from its exhaustive list. */
function assertKeys(label: string, value: object, keys: readonly PropertyKey[]) {
  assertKeysAcross(label, [value], keys);
}

/**
 * Assert that a list of objects collectively carries every key from its exhaustive list; some
 * keys are mutually exclusive per item (a root comment has no `parentId`), so coverage is
 * checked across the list rather than per item.
 */
function assertKeysAcross(label: string, values: readonly object[], keys: readonly PropertyKey[]) {
  const missing = keys.filter(
    (key) => !values.some((value) => Object.prototype.hasOwnProperty.call(value, key)),
  );
  if (missing.length > 0) {
    throw new Error(`${label} is missing ${missing.map(String).join(", ")} in the wire corpus.`);
  }
}

const changeRequestDescriptor: ExtensionChangeRequestReviewDescriptor = {
  kind: "change-request",
  provider: "GitHub",
  title: "Improve session wire coverage",
  url: "https://example.com/owner/repo/pull/123",
  id: "#123",
  repository: "owner/repo",
  author: "octocat",
  base: "main",
  head: "feature/wire",
  state: "open",
  draft: true,
};

const commitDescriptor: ExtensionCommitReviewDescriptor = {
  kind: "commit",
  provider: "git",
  title: "feat: add wire corpus",
  url: "https://example.com/owner/repo/commit/0123456789abcdef",
  revision: "0123456789abcdef0123456789abcdef01234567",
  displayRevision: "0123456",
  author: "Ada Lovelace",
  authoredAt: FIXED_TIMESTAMP,
};

const comparisonCommit: ExtensionComparisonCommitDescriptor = {
  title: "feat: first commit",
  author: "Ada Lovelace",
  authoredAt: FIXED_TIMESTAMP,
  revision: "89abcdef0123456789abcdef0123456789abcdef",
  displayRevision: "89abcde",
};

const comparisonDescriptor: ExtensionComparisonReviewDescriptor = {
  kind: "comparison",
  provider: "git",
  title: "main...feature/wire",
  url: "https://example.com/owner/repo/compare/main...feature",
  base: "main",
  head: "feature/wire",
  commitCount: 2,
  commits: [comparisonCommit, { ...comparisonCommit, title: "feat: second commit" }],
};

/** Every review input the session surface registers, each with its own descriptor. */
const LAUNCH_MODES: ReadonlyArray<{
  name: string;
  input: CliInput;
  review: ExtensionReviewDescriptor;
}> = [
  {
    name: "diff",
    input: { kind: "vcs", staged: true, range: "main..HEAD", options: { experimental: true } },
    review: changeRequestDescriptor,
  },
  {
    name: "show",
    input: { kind: "show", ref: "HEAD", pathspecs: ["src"], options: { experimental: true } },
    review: commitDescriptor,
  },
  {
    name: "stash-show",
    input: { kind: "stash-show", ref: "stash@{0}", options: { experimental: true } },
    review: commitDescriptor,
  },
  {
    name: "patch",
    input: { kind: "patch", file: "change.patch", options: { experimental: true } },
    review: comparisonDescriptor,
  },
  {
    name: "difftool",
    input: {
      kind: "difftool",
      left: "/tmp/left",
      right: "/tmp/right",
      path: "src/example.ts",
      options: { experimental: true },
    },
    review: comparisonDescriptor,
  },
  {
    name: "file-diff",
    input: { kind: "diff", left: "/tmp/a.ts", right: "/tmp/b.ts", options: { experimental: true } },
    review: changeRequestDescriptor,
  },
];

/** Build one bootstrap whose changeset offers every resource kind, including expandable source. */
function createCorpusBootstrap(input: CliInput, review: ExtensionReviewDescriptor): AppBootstrap {
  const renamed = createTestDiffFile({
    id: "file-renamed",
    path: "src/renamed.ts",
    previousPath: "src/original.ts",
    before: "export const value = 1;\nexport const other = 2;\n",
    after: "export const value = 2;\nexport const other = 2;\n",
    sourceFetcher: {
      cacheKey: "wire-corpus:renamed",
      getFullText: async () => null,
    },
  });
  const added = createTestDiffFile({
    id: "file-added",
    path: "src/added.ts",
    before: "",
    after: "export const added = true;\n",
  });
  return {
    input,
    reloadContext: { cwd: "/repo" },
    changeset: {
      id: "changeset:wire-corpus",
      title: "wire corpus",
      sourceLabel: "/repo",
      files: [renamed, added],
    },
    initialMode: "split",
    initialShowAgentNotes: true,
    review,
    reviewSource: "provider",
  };
}

/** Publish one deterministic generation of a bootstrap. */
function publish(bootstrap: AppBootstrap) {
  return buildReviewPublication({
    files: bootstrap.changeset.files,
    generation: FIXED_GENERATION,
    sourceLabel: bootstrap.changeset.sourceLabel,
  });
}

/** Replace process-specific registration facts with fixed values without changing the shape. */
function pinRegistration(registration: HunkSessionRegistration): HunkSessionRegistration {
  return {
    ...registration,
    sessionId: FIXED_SESSION_ID,
    pid: 4242,
    cwd: "/repo",
    launchedAt: FIXED_TIMESTAMP,
    terminal: {
      program: "tmux",
      locations: [
        {
          source: "tmux",
          tty: "/dev/ttys000",
          windowId: "@1",
          tabId: "tab-1",
          paneId: "%1",
          terminalId: "terminal-1",
          sessionId: "$1",
        },
      ],
    },
    info: {
      ...registration.info,
      reviewCapabilityDigest: FIXED_CAPABILITY_DIGEST,
      files: registration.info.files.map((file, index) => ({
        ...file,
        // A session from an older build may still embed patch text; keep the field on the wire.
        patch:
          index === 0
            ? "@@ -1,2 +1,2 @@\n-export const value = 1;\n+export const value = 2;\n"
            : undefined,
      })),
    },
  };
}

/** The fullest live state a session publishes: selection, notes, comments, and its position. */
function createCorpusState(registration: HunkSessionRegistration): HunkSessionState {
  const file = registration.info.files[0]!;
  const rootComment: SessionLiveCommentSummary = {
    commentId: "comment-1",
    filePath: file.path,
    hunkIndex: 0,
    side: "new",
    line: 1,
    summary: "Root live comment",
    rationale: "Explains the change",
    author: "agent",
    createdAt: FIXED_TIMESTAMP,
  };
  const reply: SessionLiveCommentSummary = {
    ...rootComment,
    commentId: "comment-2",
    parentId: "comment-1",
    summary: "Reply live comment",
  };
  const note: SessionReviewNoteSummary = {
    noteId: "note-1",
    source: "user",
    filePath: file.path,
    hunkIndex: 0,
    oldRange: [1, 1],
    newRange: [1, 1],
    body: "A user note",
    title: "Note title",
    author: "reviewer",
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    editable: true,
  };
  const replyNote: SessionReviewNoteSummary = {
    ...note,
    noteId: "note-2",
    parentId: "note-1",
    source: "agent",
    editable: false,
  };
  return {
    selectedFileId: file.id,
    selectedFilePath: file.path,
    selectedHunkIndex: 0,
    selectedHunkOldRange: [1, 1],
    selectedHunkNewRange: [1, 1],
    showAgentNotes: true,
    noteMarkupWidth: 72,
    liveCommentCount: 2,
    liveComments: [rootComment, reply],
    reviewNoteCount: 2,
    reviewNotes: [note, replyNote],
    reviewPublication: { generation: FIXED_GENERATION, stateRevision: 3 },
  };
}

/** Verify every exhaustive key list against the built payloads. */
function assertCorpusEntry(entry: SessionWireCorpusEntry) {
  const { registration, snapshot } = entry;
  assertKeys(`${entry.name} registration`, registration, REGISTRATION_KEYS);
  assertKeys(`${entry.name} info`, registration.info, INFO_KEYS);
  assertKeysAcross(`${entry.name} files`, registration.info.files, FILE_KEYS);
  assertKeysAcross(
    `${entry.name} hunks`,
    registration.info.files.flatMap((file) => file.hunks),
    HUNK_KEYS,
  );
  const review = registration.info.review!;
  const descriptorKeys =
    review.kind === "change-request"
      ? CHANGE_REQUEST_KEYS
      : review.kind === "commit"
        ? COMMIT_KEYS
        : COMPARISON_KEYS;
  assertKeys(`${entry.name} review descriptor`, review, descriptorKeys);
  if (review.kind === "comparison") {
    assertKeysAcross(
      `${entry.name} comparison commits`,
      review.commits ?? [],
      COMPARISON_COMMIT_KEYS,
    );
  }
  assertKeys(`${entry.name} snapshot`, snapshot, SNAPSHOT_KEYS);
  assertKeys(`${entry.name} state`, snapshot.state, STATE_KEYS);
  assertKeysAcross(`${entry.name} live comments`, snapshot.state.liveComments, LIVE_COMMENT_KEYS);
  assertKeysAcross(
    `${entry.name} review notes`,
    snapshot.state.reviewNotes ?? [],
    REVIEW_NOTE_KEYS,
  );
}

/**
 * Build the deterministic wire corpus: one entry per launch mode from the initial registration,
 * plus one reload entry so `updateSessionRegistration` is covered as well.
 */
export function buildTestSessionWireCorpus(): SessionWireCorpusEntry[] {
  const entries: SessionWireCorpusEntry[] = [];
  for (const mode of LAUNCH_MODES) {
    const bootstrap = createCorpusBootstrap(mode.input, mode.review);
    const publication = publish(bootstrap);
    const registration = pinRegistration(
      createSessionRegistration(bootstrap, publication, "/repo"),
    );
    const initial = createInitialSessionSnapshot(bootstrap, publication);
    entries.push({
      name: `${mode.name}:initial`,
      registration,
      snapshot: { updatedAt: FIXED_TIMESTAMP, state: initial.state },
    });
    entries.push({
      name: `${mode.name}:live`,
      registration,
      snapshot: { updatedAt: FIXED_TIMESTAMP, state: createCorpusState(registration) },
    });
  }

  const first = LAUNCH_MODES[0]!;
  const second = LAUNCH_MODES[1]!;
  const currentBootstrap = createCorpusBootstrap(first.input, first.review);
  const current = createSessionRegistration(currentBootstrap, publish(currentBootstrap), "/repo");
  const nextBootstrap = createCorpusBootstrap(second.input, second.review);
  const reloaded = pinRegistration(
    updateSessionRegistration(current, nextBootstrap, publish(nextBootstrap)),
  );
  entries.push({
    name: `reload:${first.name}->${second.name}`,
    registration: reloaded,
    snapshot: { updatedAt: FIXED_TIMESTAMP, state: createCorpusState(reloaded) },
  });

  // Only the live entries carry every optional state field; the initial ones prove the real
  // first snapshot still round-trips.
  for (const entry of entries) {
    if (entry.name.endsWith(":initial")) continue;
    assertCorpusEntry(entry);
  }
  return entries;
}

/** Serialize the corpus with JSON semantics so undefined fields disappear exactly as on the wire. */
export function serializeTestSessionWireCorpus(corpus: SessionWireCorpusEntry[]) {
  return `${JSON.stringify(corpus, null, 2)}\n`;
}
