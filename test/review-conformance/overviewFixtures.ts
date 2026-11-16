/**
 * Hand-authored fixtures for the review overview (`core/review/overview.ts`).
 *
 * Each fixture builds files, drives a review session host, and states — from the policy in
 * `core/review/fileRoles.ts` and the size thresholds, never captured — the figures every
 * surface reporting the review's shape must agree on. Files are named by index.
 */
import type { ReviewSessionHost } from "../../packages/hunk/src/app/review/reviewSessionHost";
import type { DiffFile } from "../../packages/hunk/src/core/changeset/model";
import { createTestDiffFile, lines } from "../helpers/diff-helpers";

/** What one consumer reports of a review's overview, with files named by index. */
export interface ReviewOverviewProjection {
  totals: { files: number; additions: number; deletions: number };
  meaningful: { files: number; additions: number; deletions: number };
  sizeClass: string;
  roles: Record<string, number>;
  topDirectories: string[];
  largestFiles: number[];
  notesByFile: Array<{ file: number; agent: number; reviewer: number }>;
}

export interface ReviewOverviewFixture {
  id: string;
  findings: string[];
  description: string;
  build: () => DiffFile[];
  act: (host: ReviewSessionHost) => void;
  expected: ReviewOverviewProjection;
}

/** One surface that reports the overview. */
export interface ReviewOverviewConsumer {
  name: string;
  phase: string;
  project: (fixture: ReviewOverviewFixture) => ReviewOverviewProjection;
}

/** A file at `path` whose `added` new lines replace `removed` old ones. */
function changedFile(
  path: string,
  added: number,
  removed: number,
  agent: DiffFile["agent"] = null,
) {
  const before = Array.from({ length: removed }, (_unused, index) => `old ${index}`);
  const after = Array.from({ length: added }, (_unused, index) => `new ${index}`);
  return createTestDiffFile({
    id: path.replaceAll(/[^a-z0-9]/gi, "-"),
    path,
    before: lines(...before),
    after: lines(...after),
    agent,
  });
}

export const REVIEW_OVERVIEW_FIXTURES: readonly ReviewOverviewFixture[] = [
  {
    id: "overview-roles-size-and-notes",
    findings: ["OV1"],
    description:
      "A review with source, tests, docs, and a lockfile: the lockfile's churn tops the largest files but leaves the meaningful size small, and notes count by origin.",
    build: () => [
      changedFile("src/app.ts", 12, 3, {
        path: "src/app.ts",
        annotations: [{ newRange: [1, 1], summary: "Sidecar", source: "ai" }],
      }),
      changedFile("src/app.test.ts", 20, 1),
      changedFile("docs/guide.md", 4, 4),
      changedFile("bun.lock", 60, 50),
    ],
    act: (host) => {
      host.addLiveComment({ filePath: "src/app.ts", hunkIndex: 0, summary: "Live" }, "mcp:1");
      host.addLiveComment({ filePath: "docs/guide.md", hunkIndex: 0, summary: "Doc" }, "mcp:2");
      host.startUserNote({ fileId: "src-app-test-ts", hunkIndex: 0 });
      host.updateDraftNote("Mine");
      host.saveDraftNote();
    },
    expected: {
      totals: { files: 4, additions: 96, deletions: 58 },
      meaningful: { files: 1, additions: 12, deletions: 3 },
      sizeClass: "S",
      roles: { source: 1, test: 1, docs: 1, generated: 1, config: 0 },
      topDirectories: ["src", "docs"],
      largestFiles: [3, 1, 0, 2],
      notesByFile: [
        { file: 0, agent: 2, reviewer: 0 },
        { file: 1, agent: 0, reviewer: 1 },
        { file: 2, agent: 1, reviewer: 0 },
      ],
    },
  },
];
