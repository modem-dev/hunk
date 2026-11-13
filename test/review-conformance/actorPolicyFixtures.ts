/**
 * Hand-authored fixtures for the multi-surface action policy (G2) and shared viewed files (G1).
 *
 * Each fixture is a sequence of actions from different actors against one session, with the
 * outcome each must have and the review that results — written from the decisions recorded
 * in `docs/browser-review-seam-audit.md`, never captured from a run. Files are named by index.
 */
import type { DiffFile } from "../../packages/hunk/src/core/changeset/model";
import { MAX_REVIEW_NOTES } from "../../packages/hunk/src/core/review/noteSize";
import type { ReviewDocumentV1 } from "../../packages/hunk/src/core/review/types";
import type {
  HunkReviewActionV1,
  HunkReviewActorV1,
} from "../../packages/hunk/src/session/reviewProtocol";
import { createTestDiffFile, createTestSourceFetcher, lines } from "../helpers/diff-helpers";

/** One step: an action from one actor, or a reload that replaces the files. */
export type ReviewActorPolicyStep =
  | {
      kind: "action";
      actor: HunkReviewActorV1;
      action: (document: ReviewDocumentV1) => HunkReviewActionV1;
      /**
       * How the action reaches the session: through the review link's capability (a browser
       * tab, the HTTP surface) or through the authenticated session API (`hunk session`).
       * Defaults to the capability for a browser actor and the session API otherwise.
       */
      channel?: "capability" | "session";
    }
  | { kind: "reload"; build: () => DiffFile[] }
  /** An agent fills the review with this many live comments on the first file's first hunk. */
  | { kind: "seed-live-notes"; count: number };

/** What one step did: applied (the review moved), a no-op, or refused with a code. */
export type ReviewActorPolicyOutcome = "applied" | "no-op" | { code: string };

export interface ReviewActorPolicyProjection {
  outcomes: ReviewActorPolicyOutcome[];
  selection: { file: number; hunkIndex: number };
  viewed: number[];
  notes: Array<{ file: number; author?: string; summary: string; ownerHunkIndex?: number }>;
}

export interface ReviewActorPolicyFixture {
  id: string;
  findings: string[];
  description: string;
  surface: "terminal" | "headless";
  build: () => DiffFile[];
  steps: ReviewActorPolicyStep[];
  expected: ReviewActorPolicyProjection;
}

/** One consumer of the action policy: a tier that applies remote actions. */
export interface ReviewActorPolicyConsumer {
  name: string;
  phase: string;
  project: (fixture: ReviewActorPolicyFixture) => Promise<ReviewActorPolicyProjection>;
}

const BROWSER: HunkReviewActorV1 = { clientId: "tab-1", kind: "browser", displayName: "Ana" };
const OTHER_BROWSER: HunkReviewActorV1 = { clientId: "tab-2", kind: "browser" };
const AGENT: HunkReviewActorV1 = { clientId: "agent-1", kind: "agent" };

/** A twelve-line file whose line 8 changed, readable in full so its gaps can expand. */
function sourcedFile(id: string, changed = "800") {
  const before = Array.from({ length: 12 }, (_unused, index) => `const v${index + 1} = ${index};`);
  const after = [...before];
  after[7] = `const v8 = ${changed};`;
  return createTestDiffFile({
    after: lines(...after),
    before: lines(...before),
    context: 3,
    id,
    path: `src/${id}.ts`,
    sourceFetcher: createTestSourceFetcher(() => lines(...after)),
  });
}

/** The channel one action step arrives through. */
export function reviewActorPolicyChannel(step: Extract<ReviewActorPolicyStep, { kind: "action" }>) {
  return step.channel ?? (step.actor.kind === "browser" ? "capability" : "session");
}

/** The key of the file at one index. */
const keyAt = (document: ReviewDocumentV1, index: number) => document.files[index]!.key;

export const REVIEW_ACTOR_POLICY_FIXTURES: readonly ReviewActorPolicyFixture[] = [
  {
    id: "two-actors-keep-separate-selections",
    findings: ["G2"],
    description:
      "In a terminal session a browser's selection moves are refused and its anchor is a no-op, while an agent still moves the session.",
    surface: "terminal",
    build: () => [sourcedFile("alpha"), sourcedFile("beta")],
    steps: [
      {
        kind: "action",
        actor: BROWSER,
        action: (document) => ({ type: "selection/select-file", fileKey: keyAt(document, 1) }),
      },
      {
        kind: "action",
        actor: OTHER_BROWSER,
        action: (document) => ({
          type: "selection/anchor",
          fileKey: keyAt(document, 1),
          hunkIndex: 0,
        }),
      },
      {
        kind: "action",
        actor: AGENT,
        action: (document) => ({ type: "selection/select-file", fileKey: keyAt(document, 1) }),
      },
    ],
    expected: {
      outcomes: [{ code: "selection-is-local" }, "no-op", "applied"],
      selection: { file: 1, hunkIndex: 0 },
      viewed: [],
      notes: [],
    },
  },
  {
    id: "headless-adopts-a-browser-anchor",
    findings: ["G2"],
    description:
      "A headless session has no terminal focus, so a browser's anchor becomes what `hunk session context` reports; its select is still refused.",
    surface: "headless",
    build: () => [sourcedFile("alpha"), sourcedFile("beta")],
    steps: [
      {
        kind: "action",
        actor: BROWSER,
        action: (document) => ({
          type: "selection/anchor",
          fileKey: keyAt(document, 1),
          hunkIndex: 0,
        }),
      },
      {
        kind: "action",
        actor: BROWSER,
        action: () => ({ type: "selection/move", scope: "file", delta: -1 }),
      },
    ],
    expected: {
      outcomes: ["applied", { code: "selection-is-local" }],
      selection: { file: 1, hunkIndex: 0 },
      viewed: [],
      notes: [],
    },
  },
  {
    id: "direct-note-inside-an-expanded-gap",
    findings: ["G2", "B10"],
    description:
      "A browser writes a note on a line only an expanded gap shows, in one action with its proof; the author defaults from the actor and the shared draft is never touched.",
    surface: "terminal",
    build: () => [sourcedFile("alpha")],
    steps: [
      {
        kind: "action",
        actor: BROWSER,
        action: (document) => ({
          type: "notes/add-user",
          fileKey: keyAt(document, 0),
          hunkIndex: 0,
          target: { side: "new", line: 2 },
          body: "Why does this line exist?",
          expandedLineProof: {
            gapId: "before:0",
            side: "new",
            line: 2,
            sourceIdentity: document.files[0]!.sourceIdentity!,
          },
        }),
      },
      {
        kind: "action",
        actor: BROWSER,
        action: (document) => ({
          type: "notes/add-user",
          fileKey: keyAt(document, 0),
          hunkIndex: 0,
          target: { side: "new", line: 2 },
          body: "No proof, no note",
        }),
      },
    ],
    expected: {
      outcomes: ["applied", { code: "invalid-request" }],
      selection: { file: 0, hunkIndex: 0 },
      viewed: [],
      notes: [{ file: 0, author: "Ana", summary: "Why does this line exist?", ownerHunkIndex: 0 }],
    },
  },
  {
    id: "viewed-marks-across-a-reload",
    findings: ["G1"],
    description:
      "A viewed mark survives a reload that leaves its file's content alone and is dropped when the content changes.",
    surface: "headless",
    build: () => [sourcedFile("alpha"), sourcedFile("beta")],
    steps: [
      {
        kind: "action",
        actor: BROWSER,
        action: (document) => ({
          type: "files/set-viewed",
          fileKey: keyAt(document, 0),
          viewed: true,
        }),
      },
      {
        kind: "action",
        actor: OTHER_BROWSER,
        action: (document) => ({
          type: "files/set-viewed",
          fileKey: keyAt(document, 1),
          viewed: true,
        }),
      },
      { kind: "reload", build: () => [sourcedFile("alpha"), sourcedFile("beta", "900")] },
    ],
    expected: {
      outcomes: ["applied", "applied", "applied"],
      selection: { file: 0, hunkIndex: 0 },
      viewed: [0],
      notes: [],
    },
  },
  {
    id: "direct-note-past-the-stored-note-bound",
    findings: ["D5"],
    description:
      "A review one note short of its stored-note bound takes one more browser note and refuses the next with too-many-notes, so the snapshots every reader accepts stay within their bounds.",
    surface: "headless",
    build: () => [sourcedFile("alpha")],
    steps: [
      { kind: "seed-live-notes", count: MAX_REVIEW_NOTES - 1 },
      {
        kind: "action",
        actor: BROWSER,
        action: (document) => ({
          type: "notes/add-user",
          fileKey: keyAt(document, 0),
          hunkIndex: 0,
          body: "The last one that fits",
        }),
      },
      {
        kind: "action",
        actor: BROWSER,
        action: (document) => ({
          type: "notes/add-user",
          fileKey: keyAt(document, 0),
          hunkIndex: 0,
          body: "One too many",
        }),
      },
    ],
    expected: {
      outcomes: ["applied", "applied", { code: "too-many-notes" }],
      selection: { file: 0, hunkIndex: 0 },
      viewed: [],
      notes: [
        ...Array.from({ length: MAX_REVIEW_NOTES - 1 }, () => ({
          file: 0,
          summary: "seed",
          ownerHunkIndex: 0,
        })),
        { file: 0, author: "Ana", summary: "The last one that fits", ownerHunkIndex: 0 },
      ],
    },
  },
  {
    id: "capability-holder-claiming-another-kind",
    findings: ["G2"],
    description:
      "A caller holding only the review link declares itself an agent and then a terminal to move every surface; both are refused with forbidden-actor, while the same agent move through the session API applies.",
    surface: "terminal",
    build: () => [sourcedFile("alpha"), sourcedFile("beta")],
    steps: [
      {
        kind: "action",
        actor: AGENT,
        channel: "capability",
        action: (document) => ({ type: "selection/select-file", fileKey: keyAt(document, 1) }),
      },
      {
        kind: "action",
        actor: { clientId: "tab-3", kind: "terminal" },
        channel: "capability",
        action: (document) => ({ type: "selection/select-file", fileKey: keyAt(document, 1) }),
      },
      {
        kind: "action",
        actor: AGENT,
        channel: "session",
        action: (document) => ({ type: "selection/select-file", fileKey: keyAt(document, 1) }),
      },
    ],
    expected: {
      outcomes: [{ code: "forbidden-actor" }, { code: "forbidden-actor" }, "applied"],
      selection: { file: 1, hunkIndex: 0 },
      viewed: [],
      notes: [],
    },
  },
];
