/**
 * Hand-authored fixtures for the shared-state snapshot (`ReviewSharedStateV1`).
 *
 * Each fixture builds files, drives a review session host the way agents and the reviewer do,
 * and states — written from the contract, never captured — what every tier serving the
 * snapshot must report: which notes in which order, the filter and note-layer visibility,
 * agent marks by file, and the agent reveal request. Files are named by index so a consumer's
 * own file keys never leak into an expectation.
 */
import type { ReviewSessionHost } from "../../packages/hunk/src/app/review/reviewSessionHost";
import type { DiffFile } from "../../packages/hunk/src/core/changeset/model";
import { createTestDiffFile, lines } from "../helpers/diff-helpers";

/** What one consumer made of a shared-state snapshot, with files named by index. */
export interface ReviewSharedStateProjection {
  files: string[];
  notes: Array<{
    origin: string;
    id: string;
    file: number;
    resolution: string;
    /** Present when the note carries an STML body the snapshot shows. */
    markup?: true;
  }>;
  filter: string;
  showAgentNotes: boolean;
  highlights: Record<number, Array<{ side: string; line: number; start: number; end: number }>>;
  agentReveal: {
    token: number;
    file: number;
    hunkIndex: number;
    side?: string;
    line?: number;
    noteId?: string;
  } | null;
}

export interface ReviewSharedStateFixture {
  id: string;
  findings: string[];
  description: string;
  build: () => DiffFile[];
  /** Drive the host as agents and the reviewer would; may replace the file set. */
  act: (host: ReviewSessionHost) => void;
  expected: ReviewSharedStateProjection;
}

/** One serving tier of the shared-state snapshot. */
export interface ReviewSharedStateConsumer {
  name: string;
  phase: string;
  project: (fixture: ReviewSharedStateFixture) => Promise<ReviewSharedStateProjection>;
}

/** A twelve-line file whose line 8 changed, so it has one hunk. */
function oneHunkFile(id: string, agent: DiffFile["agent"] = null, changed = "800") {
  const before = Array.from({ length: 12 }, (_unused, index) => `const v${index + 1} = ${index};`);
  const after = [...before];
  after[7] = `const v8 = ${changed};`;
  return createTestDiffFile({
    after: lines(...after),
    before: lines(...before),
    context: 3,
    id,
    path: `src/${id}.ts`,
    agent,
  });
}

/** A forty-line file whose lines 8 and 32 changed, so it has two hunks. */
function twoHunkFile(id: string) {
  const before = Array.from({ length: 40 }, (_unused, index) => `const v${index + 1} = ${index};`);
  const after = [...before];
  after[7] = "const v8 = 800;";
  after[31] = "const v32 = 3200;";
  return createTestDiffFile({
    after: lines(...after),
    before: lines(...before),
    context: 3,
    id,
    path: `src/${id}.ts`,
  });
}

export const REVIEW_SHARED_STATE_FIXTURES: readonly ReviewSharedStateFixture[] = [
  {
    id: "shared-notes-in-terminal-order",
    findings: ["G1"],
    description:
      "Sidecar annotations precede stored notes within a file, files keep document order, and a reply follows its parent rather than arrival order.",
    build: () => [
      oneHunkFile("alpha", {
        path: "src/alpha.ts",
        annotations: [{ newRange: [8, 8], summary: "From the sidecar", source: "ai" }],
      }),
      oneHunkFile("beta"),
    ],
    act: (host) => {
      host.addLiveComment({ filePath: "src/beta.ts", hunkIndex: 0, summary: "Root" }, "mcp:root");
      host.addLiveComment({ filePath: "src/alpha.ts", hunkIndex: 0, summary: "Later" }, "mcp:a");
      host.addLiveComment({ replyTo: "mcp:root", summary: "Reply" }, "mcp:reply");
    },
    expected: {
      files: ["src/alpha.ts", "src/beta.ts"],
      notes: [
        { origin: "sidecar", id: "ai:@0:0", file: 0, resolution: "active" },
        { origin: "live", id: "mcp:a", file: 0, resolution: "active" },
        { origin: "live", id: "mcp:root", file: 1, resolution: "active" },
        { origin: "live", id: "mcp:reply", file: 1, resolution: "active" },
      ],
      filter: "",
      showAgentNotes: false,
      highlights: {},
      agentReveal: null,
    },
  },
  {
    id: "shared-agent-marks-and-reveal",
    findings: ["G2"],
    description:
      "Agent marks travel by file, and only agent navigation records a reveal: the reviewer's own selection leaves the token alone.",
    build: () => [oneHunkFile("alpha"), oneHunkFile("beta")],
    act: (host) => {
      host.addAgentLineHighlight({
        filePath: "src/beta.ts",
        side: "new",
        line: 8,
        start: 2,
        end: 6,
      });
      host.navigateToLocation({ filePath: "src/beta.ts", side: "new", line: 8 });
      host.selectHunk("alpha", 0);
      host.setFilter("beta");
    },
    expected: {
      files: ["src/alpha.ts", "src/beta.ts"],
      notes: [],
      filter: "beta",
      showAgentNotes: false,
      highlights: { 1: [{ side: "new", line: 8, start: 2, end: 6 }] },
      agentReveal: { token: 1, file: 1, hunkIndex: 0, side: "new", line: 8 },
    },
  },
  {
    id: "shared-state-after-reload",
    findings: ["G1"],
    description:
      "A reload that drops a file drops its notes and marks from the snapshot; a file whose content changed loses its marks and keeps its notes, marked stale at their last anchor.",
    build: () => [oneHunkFile("alpha"), oneHunkFile("beta")],
    act: (host) => {
      host.addLiveComment({ filePath: "src/alpha.ts", hunkIndex: 0, summary: "Kept" }, "mcp:a");
      host.addLiveComment({ filePath: "src/beta.ts", hunkIndex: 0, summary: "Gone" }, "mcp:b");
      host.addAgentLineHighlight({
        filePath: "src/alpha.ts",
        side: "new",
        line: 8,
        start: 0,
        end: 1,
      });
      host.setShowAgentNotes(true);
      host.replaceFiles([oneHunkFile("alpha", null, "900")]);
    },
    expected: {
      files: ["src/alpha.ts"],
      notes: [{ origin: "live", id: "mcp:a", file: 0, resolution: "stale" }],
      filter: "",
      showAgentNotes: true,
      highlights: {},
      agentReveal: null,
    },
  },
  {
    id: "stale-and-orphaned-notes-after-reload",
    findings: ["G1"],
    description:
      "A reload that changes a two-hunk file into a one-hunk file keeps the first hunk's note as stale and orphans the second hunk's note, replies included; an unchanged file's note stays active.",
    build: () => [twoHunkFile("alpha"), oneHunkFile("beta")],
    act: (host) => {
      host.addLiveComment({ filePath: "src/alpha.ts", hunkIndex: 0, summary: "First" }, "mcp:1");
      host.addLiveComment({ filePath: "src/alpha.ts", hunkIndex: 1, summary: "Second" }, "mcp:2");
      host.addLiveComment({ replyTo: "mcp:2", summary: "Reply" }, "mcp:3");
      host.addLiveComment({ filePath: "src/beta.ts", hunkIndex: 0, summary: "Same" }, "mcp:4");
      host.replaceFiles([oneHunkFile("alpha", null, "900"), oneHunkFile("beta")]);
    },
    expected: {
      files: ["src/alpha.ts", "src/beta.ts"],
      notes: [
        { origin: "live", id: "mcp:1", file: 0, resolution: "stale" },
        { origin: "live", id: "mcp:4", file: 1, resolution: "active" },
      ],
      filter: "",
      showAgentNotes: false,
      highlights: {},
      agentReveal: null,
    },
  },
  {
    id: "sidecar-markup-follows-the-experimental-launch",
    findings: ["G1"],
    description:
      "A sidecar annotation's STML body reaches the snapshot only when the session enabled STML, as the terminal only shows it then; its plain summary is served either way.",
    build: () => [
      oneHunkFile("alpha", {
        path: "src/alpha.ts",
        annotations: [{ newRange: [8, 8], summary: "Plain", markup: "<b>Bold</b>", source: "ai" }],
      }),
      oneHunkFile("beta", {
        path: "src/beta.ts",
        annotations: [{ newRange: [8, 8], summary: "Plain", markup: "<b>Bold</b>", source: "ai" }],
      }),
    ],
    act: () => {},
    expected: {
      files: ["src/alpha.ts", "src/beta.ts"],
      notes: [
        { origin: "sidecar", id: "ai:@0:0", file: 0, resolution: "active" },
        { origin: "sidecar", id: "ai:@1:0", file: 1, resolution: "active" },
      ],
      filter: "",
      showAgentNotes: false,
      highlights: {},
      agentReveal: null,
    },
  },
  {
    id: "sidecar-markup-with-stml-enabled",
    findings: ["G1"],
    description: "The same sidecar body in a session that enabled STML carries its markup.",
    build: () => [
      oneHunkFile("alpha", {
        path: "src/alpha.ts",
        annotations: [{ newRange: [8, 8], summary: "Plain", markup: "<b>Bold</b>", source: "ai" }],
      }),
    ],
    act: (host) => host.setStmlEnabled(true),
    expected: {
      files: ["src/alpha.ts"],
      notes: [{ origin: "sidecar", id: "ai:@0:0", file: 0, resolution: "active", markup: true }],
      filter: "",
      showAgentNotes: false,
      highlights: {},
      agentReveal: null,
    },
  },
];
