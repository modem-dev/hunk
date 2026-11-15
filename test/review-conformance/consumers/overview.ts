/**
 * The surfaces that report a review's overview, as conformance consumers.
 *
 * The core selector over a live host's document and notes, and the browser page's input path:
 * the shared-state snapshot's file index and notes through `selectWebReviewOverview`. A surface
 * that counted a note twice, lost a sidecar note, or classified a file differently disagrees.
 */
import { ReviewSessionHost } from "../../../packages/hunk/src/app/review/reviewSessionHost";
import {
  buildReviewPresentationDefaults,
  buildReviewSharedState,
} from "../../../packages/hunk/src/app/review/sharedState";
import { reviewNoteSource } from "../../../packages/hunk/src/core/review/annotations";
import {
  reviewOverviewNoteOrigin,
  selectReviewOverview,
  type ReviewOverview,
} from "../../../packages/hunk/src/core/review/overview";
import { isRenderableStoredReviewNote } from "../../../packages/hunk/src/core/review/state";
import { selectWebReviewOverview } from "../../../packages/hunk/src/web/panel/overviewInput";
import { createTestReviewBootstrap } from "../../helpers/review-session-harness";
import type {
  ReviewOverviewConsumer,
  ReviewOverviewFixture,
  ReviewOverviewProjection,
} from "../overviewFixtures";

/** Build the fixture's host and drive it. */
function actedHost(fixture: ReviewOverviewFixture) {
  const files = fixture.build();
  const host = new ReviewSessionHost({ files, sourceLabel: "/repo", now: () => 1 });
  fixture.act(host);
  return { files, host };
}

/** Name files by index. */
function project(overview: ReviewOverview, keys: readonly string[]): ReviewOverviewProjection {
  const index = (key: string) => keys.indexOf(key);
  const plain = ({ files, additions, deletions }: ReviewOverview["totals"]) => ({
    files,
    additions,
    deletions,
  });
  return {
    totals: plain(overview.totals),
    meaningful: plain(overview.meaningful),
    sizeClass: overview.sizeClass,
    roles: Object.fromEntries(
      Object.entries(overview.roles).map(([role, totals]) => [role, totals.files]),
    ),
    topDirectories: overview.directories.children.map((child) => child.name),
    largestFiles: overview.largestFiles.map((file) => index(file.fileKey)),
    notesByFile: overview.notesByFile.map((entry) => ({
      file: index(entry.fileKey),
      agent: entry.agent,
      reviewer: entry.reviewer,
    })),
  };
}

export const coreOverviewConsumer: ReviewOverviewConsumer = {
  name: "core overview selector",
  phase: "M6 tools",
  project(fixture) {
    const { files, host } = actedHost(fixture);
    const document = host.getDocument();
    const state = host.getSnapshot();
    const stored = [...state.liveNotes, ...state.userNotes]
      .filter(isRenderableStoredReviewNote)
      .map((entry) => ({
        fileKey: entry.note.fileKey,
        origin: reviewOverviewNoteOrigin(entry.note.source),
      }));
    const sidecar = files.flatMap((file) =>
      (file.agent?.annotations ?? []).map((annotation) => ({
        fileKey: host.fileKeyFor(file.id)!,
        origin: reviewOverviewNoteOrigin(reviewNoteSource(annotation)),
      })),
    );
    const overview = selectReviewOverview({
      files: document.files,
      notes: [...sidecar, ...stored],
    });
    return project(
      overview,
      document.files.map((file) => file.key),
    );
  },
};

export const browserOverviewConsumer: ReviewOverviewConsumer = {
  name: "browser overview tab",
  phase: "M6 tools",
  project(fixture) {
    const { files, host } = actedHost(fixture);
    const shared = buildReviewSharedState(host, {
      generation: "conformance",
      presentation: buildReviewPresentationDefaults(createTestReviewBootstrap(files)),
    });
    return project(
      selectWebReviewOverview(shared.files, shared),
      shared.files.map((file) => file.key),
    );
  },
};
