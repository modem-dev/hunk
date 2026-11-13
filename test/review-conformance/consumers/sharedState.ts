/**
 * Every tier that serves the shared-state snapshot, as conformance consumers.
 *
 * The producer materializes it, the broker reads it back through its chunked, verified resource
 * loop, and the HTTP surface serves what the broker read. Each consumer drives the real code
 * path over a real host and reports the snapshot it ended up with, so a tier that reordered,
 * dropped, or re-derived anything disagrees with the hand-written fixtures.
 */
import { reviewProcessCapability } from "../../../packages/hunk/src/app/review/capability";
import { ReviewProducer } from "../../../packages/hunk/src/app/review/producer";
import { ReviewSessionHost } from "../../../packages/hunk/src/app/review/reviewSessionHost";
import {
  buildReviewPresentationDefaults,
  buildReviewSharedState,
} from "../../../packages/hunk/src/app/review/sharedState";
import { BrowserReviewServer } from "../../../packages/hunk/src/session/broker/browserReviewServer";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  reviewHttpPath,
  type HunkReviewStateBodyV1,
} from "../../../packages/hunk/src/session/reviewHttpProtocol";
import {
  parseReviewSharedState,
  REVIEW_SHARED_STATE_CURRENT_RESOURCE_ID,
  type ReviewSharedStateV1,
} from "../../../packages/hunk/src/session/reviewSharedState";
import { ReviewSharedStateMirror } from "../../../packages/hunk/src/web/mirror/sharedStateMirror";
import { ReviewApiClient } from "../../../packages/hunk/src/web/transport/apiClient";
import {
  connectReviewSession,
  createTestReviewBootstrap,
} from "../../helpers/review-session-harness";
import type {
  ReviewSharedStateConsumer,
  ReviewSharedStateFixture,
  ReviewSharedStateProjection,
} from "../sharedStateFixtures";

/** Build the fixture's host and drive it. */
function actedHost(fixture: ReviewSharedStateFixture) {
  const files = fixture.build();
  const host = new ReviewSessionHost({ files, sourceLabel: "/repo", now: () => 1 });
  fixture.act(host);
  return { files, host };
}

/** Name files by index, including inside ids that embed a file key. */
function projectSharedState(state: ReviewSharedStateV1): ReviewSharedStateProjection {
  const indexByKey = new Map(state.files.map((file, index) => [file.key, index] as const));
  const neutralId = (id: string) =>
    [...indexByKey].reduce((value, [key, index]) => value.replaceAll(key, `@${index}`), id);
  const reveal = state.agentReveal;
  return {
    files: state.files.map((file) => file.path),
    notes: state.notes.map((entry) => ({
      origin: entry.origin,
      id: neutralId(entry.note.id),
      file: indexByKey.get(entry.note.fileKey) ?? -1,
      resolution: entry.resolution,
    })),
    filter: state.filter,
    showAgentNotes: state.showAgentNotes,
    highlights: Object.fromEntries(
      Object.entries(state.agentHighlights).map(([fileKey, marks]) => [
        indexByKey.get(fileKey) ?? -1,
        marks.map(({ side, line, start, end }) => ({ side, line, start, end })),
      ]),
    ),
    agentReveal: reveal
      ? {
          token: reveal.token,
          file: indexByKey.get(reveal.fileKey) ?? -1,
          hunkIndex: reveal.hunkIndex,
          ...(reveal.side !== undefined ? { side: reveal.side, line: reveal.line } : {}),
          ...(reveal.noteId !== undefined ? { noteId: reveal.noteId } : {}),
        }
      : null,
  };
}

export const reviewProducerSharedStateConsumer: ReviewSharedStateConsumer = {
  name: "review producer",
  phase: "M2a",
  async project(fixture) {
    const { files, host } = actedHost(fixture);
    const producer = new ReviewProducer({ files, sourceLabel: "/repo" }, { producerId: "c" });
    const presentation = buildReviewPresentationDefaults(createTestReviewBootstrap(files));
    producer.attachStore(host.store, {
      getSharedStateRevision: () => host.getSharedStateRevision(),
      build: (generation) => buildReviewSharedState(host, { generation, presentation }),
    });
    const read = await producer.readResource({
      generation: producer.getPublication().generation,
      resourceId: REVIEW_SHARED_STATE_CURRENT_RESOURCE_ID,
      offset: 0,
      length: 256 * 1024,
    });
    if (!read.ok || !read.chunk.eof) throw new Error("expected one whole shared-state chunk");
    const state = parseReviewSharedState(
      JSON.parse(Buffer.from(read.chunk.data, "base64").toString("utf8")),
    );
    if (!state) throw new Error("producer served an unparseable snapshot");
    return projectSharedState(state);
  },
};

export const brokerSharedStateConsumer: ReviewSharedStateConsumer = {
  name: "broker shared-state read",
  phase: "M2a",
  async project(fixture) {
    const { files, host } = actedHost(fixture);
    const harness = connectReviewSession(files, { sessionId: "conformance-state", host });
    harness.register();
    harness.publishSnapshot();
    return projectSharedState(await harness.state.loadReviewSharedState("conformance-state"));
  },
};

export const browserSurfaceSharedStateConsumer: ReviewSharedStateConsumer = {
  name: "browser review HTTP surface",
  phase: "M2a",
  async project(fixture) {
    const { files, host } = actedHost(fixture);
    const harness = connectReviewSession(files, { sessionId: "conformance-http", host });
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
      const response = await fetch(
        `http://127.0.0.1:${server.port}${reviewHttpPath({ kind: "state", sessionId: "conformance-http" })}`,
        { headers: { [HUNK_REVIEW_CAPABILITY_HEADER]: reviewProcessCapability().token } },
      );
      const body = (await response.json()) as HunkReviewStateBodyV1;
      return projectSharedState(body.state);
    } finally {
      review.close();
      server.stop(true);
    }
  },
};

/**
 * The browser client's shared-state mirror, reading the same HTTP surface the page reads.
 *
 * The page's real client (`ReviewApiClient`, with the capability header) and its real mirror
 * (`ReviewSharedStateMirror`): the publication is offered exactly as the event stream offers
 * it, the mirror decides to fetch and validates the body with the shared parser, and the
 * snapshot it accepted is what this projects.
 */
export const browserClientSharedStateConsumer: ReviewSharedStateConsumer = {
  name: "browser client shared-state mirror",
  phase: "M4 state",
  async project(fixture) {
    const { files, host } = actedHost(fixture);
    const harness = connectReviewSession(files, { sessionId: "conformance-client", host });
    harness.register();
    harness.publishSnapshot();
    const review = new BrowserReviewServer(harness.state);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) =>
        (await review.handle(request)) ?? new Response(null, { status: 404 }),
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const client = new ReviewApiClient({
      sessionId: "conformance-client",
      capability: reviewProcessCapability().token,
      fetch: (input, init) => fetch(`${origin}${input}`, init),
    });
    const mirror = new ReviewSharedStateMirror({ client });
    try {
      const publication = await client.publication();
      mirror.observe(publication);
      const state = await mirror.forGeneration(publication.publication.generation);
      if (!state) throw new Error("the browser mirror accepted no shared state");
      return projectSharedState(state);
    } finally {
      mirror.close();
      review.close();
      server.stop(true);
    }
  },
};
