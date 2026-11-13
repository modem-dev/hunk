/**
 * The tiers that apply remote review actions, as conformance consumers of the actor policy.
 *
 * The producer's action handler is where the policy lives; the HTTP surface is how a browser
 * reaches it. Both drive the real path over a real host, so a tier that applied a browser's
 * selection move, lost a note's author default, or kept a stale viewed mark disagrees with
 * the fixtures.
 */
import { reviewProcessCapability } from "../../../packages/hunk/src/app/review/capability";
import { ReviewProducer } from "../../../packages/hunk/src/app/review/producer";
import { ReviewSessionHost } from "../../../packages/hunk/src/app/review/reviewSessionHost";
import {
  buildReviewPresentationDefaults,
  buildReviewSharedState,
} from "../../../packages/hunk/src/app/review/sharedState";
import { applySessionReviewAction } from "../../../packages/hunk/src/app/session/reviewCommands";
import {
  selectIsReviewFileViewed,
  selectNormalizedSelection,
} from "../../../packages/hunk/src/core/review/selectors";
import { BrowserReviewServer } from "../../../packages/hunk/src/session/broker/browserReviewServer";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  reviewHttpPath,
} from "../../../packages/hunk/src/session/reviewHttpProtocol";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../../../packages/hunk/src/session/reviewProtocol";
import {
  connectReviewSession,
  createTestReviewBootstrap,
} from "../../helpers/review-session-harness";
import type {
  ReviewActorPolicyConsumer,
  ReviewActorPolicyFixture,
  ReviewActorPolicyOutcome,
  ReviewActorPolicyProjection,
} from "../actorPolicyFixtures";

/** Report the review a fixture left behind, with files named by index. */
function projectReview(
  host: ReviewSessionHost,
  outcomes: ReviewActorPolicyOutcome[],
): ReviewActorPolicyProjection {
  const state = host.getSnapshot();
  const files = state.document.files;
  const indexOf = (fileKey: string | null) => files.findIndex((file) => file.key === fileKey);
  const selection = selectNormalizedSelection(state);
  return {
    outcomes,
    selection: { file: indexOf(selection.fileKey), hunkIndex: selection.hunkIndex },
    viewed: files.flatMap((file, index) =>
      selectIsReviewFileViewed(state, file.key) ? [index] : [],
    ),
    notes: [...state.liveNotes, ...state.userNotes].map(({ note }) => ({
      file: indexOf(note.fileKey),
      ...(note.author !== undefined ? { author: note.author } : {}),
      summary: note.summary,
      ...(note.anchor.ownerHunkIndex !== undefined
        ? { ownerHunkIndex: note.anchor.ownerHunkIndex }
        : {}),
    })),
  };
}

/** Fill a review with agent live comments, as `hunk session comment apply` would. */
function seedTestLiveNotes(host: ReviewSessionHost, count: number) {
  const filePath = host.getFiles()[0]!.path;
  host.addLiveCommentBatch(
    Array.from({ length: count }, () => ({ filePath, hunkIndex: 0, summary: "seed" })),
    "seed",
  );
}

/** Attach one host to one producer the way a mounted session does. */
function attachTestHost(
  producer: ReviewProducer,
  host: ReviewSessionHost,
  files: ReturnType<ReviewActorPolicyFixture["build"]>,
) {
  const presentation = buildReviewPresentationDefaults(createTestReviewBootstrap(files));
  producer.attachStore(host.store, {
    getSharedStateRevision: () => host.getSharedStateRevision(),
    build: (generation) => buildReviewSharedState(host, { generation, presentation }),
    recordAgentReveal: (target) => host.recordAgentReveal(target),
  });
}

export const producerActorPolicyConsumer: ReviewActorPolicyConsumer = {
  name: "producer action handler",
  phase: "M2b",
  async project(fixture) {
    const files = fixture.build();
    const host = new ReviewSessionHost({ files, sourceLabel: "/repo" });
    const producer = new ReviewProducer(
      { files, sourceLabel: "/repo" },
      { producerId: "policy", surface: fixture.surface },
    );
    attachTestHost(producer, host, files);
    const outcomes: ReviewActorPolicyOutcome[] = [];
    for (const step of fixture.steps) {
      if (step.kind === "reload") {
        host.replaceFiles(step.build());
        outcomes.push("applied");
        continue;
      }
      if (step.kind === "seed-live-notes") {
        seedTestLiveNotes(host, step.count);
        outcomes.push("applied");
        continue;
      }
      const before = host.getSnapshot().stateRevision;
      const result = applySessionReviewAction(producer, {
        protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
        generation: producer.getPublication().generation,
        actor: step.actor,
        action: step.action(host.getDocument()),
      });
      outcomes.push(
        !result.ok
          ? { code: result.code }
          : host.getSnapshot().stateRevision === before
            ? "no-op"
            : "applied",
      );
    }
    return projectReview(host, outcomes);
  },
};

export const browserSurfaceActorPolicyConsumer: ReviewActorPolicyConsumer = {
  name: "browser review HTTP surface",
  phase: "M2b",
  async project(fixture) {
    const files = fixture.build();
    const host = new ReviewSessionHost({ files, sourceLabel: "/repo" });
    const harness = connectReviewSession(files, {
      sessionId: "conformance-policy",
      host,
      surface: fixture.surface,
    });
    harness.register();
    harness.publishSnapshot();
    const review = new BrowserReviewServer(harness.state);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) =>
        (await review.handle(request)) ?? new Response(null, { status: 404 }),
    });
    try {
      const outcomes: ReviewActorPolicyOutcome[] = [];
      for (const step of fixture.steps) {
        if (step.kind === "reload") {
          host.replaceFiles(step.build());
          outcomes.push("applied");
          continue;
        }
        if (step.kind === "seed-live-notes") {
          seedTestLiveNotes(host, step.count);
          outcomes.push("applied");
          continue;
        }
        const before = host.getSnapshot().stateRevision;
        const response = await fetch(
          `http://127.0.0.1:${server.port}${reviewHttpPath({ kind: "actions", sessionId: "conformance-policy" })}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [HUNK_REVIEW_CAPABILITY_HEADER]: reviewProcessCapability().token,
            },
            body: JSON.stringify({
              protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
              generation: harness.producer.getPublication().generation,
              actor: step.actor,
              action: step.action(host.getDocument()),
            }),
          },
        );
        const body = (await response.json()) as { ok: boolean; code?: string };
        outcomes.push(
          !body.ok
            ? { code: body.code! }
            : host.getSnapshot().stateRevision === before
              ? "no-op"
              : "applied",
        );
      }
      return projectReview(host, outcomes);
    } finally {
      review.close();
      server.stop(true);
    }
  },
};
