/**
 * The shared-state route and change signal, driven with a real server and `fetch`.
 *
 * A real host and producer publish a real generation, a real broker state mirrors it and reads
 * the snapshot through its resource loop, and the review surface serves it. Expectations are
 * the contract a browser client codes against: the body shape, the codes each failure reports,
 * and which changes do and do not announce a new `sharedStateRevision`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { reviewProcessCapability } from "../../app/review/capability";
import { ReviewSessionHost } from "../../app/review/reviewSessionHost";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import { connectReviewSession } from "../../../../../test/helpers/review-session-harness";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  reviewHttpPath,
  type HunkReviewHttpRoute,
  type HunkReviewStateBodyV1,
} from "../reviewHttpProtocol";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../reviewProtocol";
import { parseReviewSharedState } from "../reviewSharedState";
import { BrowserReviewServer } from "./browserReviewServer";

const SESSION_ID = "session-state-1";
const running: Array<{ review: BrowserReviewServer; server: { stop: (force?: boolean) => void } }> =
  [];

afterEach(() => {
  for (const entry of running.splice(0)) {
    entry.review.close();
    entry.server.stop(true);
  }
});

/** Build one file with a single changed line 8. */
function createTestStateFile(id: string) {
  const before = Array.from({ length: 12 }, (_unused, index) => `const v${index + 1} = ${index};`);
  const after = [...before];
  after[7] = "const v8 = 800;";
  return createTestDiffFile({
    after: lines(...after),
    before: lines(...before),
    context: 3,
    id,
    path: `src/${id}.ts`,
  });
}

/** Connect a host-backed session, register it, report its revisions, and serve it. */
function start() {
  const files = [createTestStateFile("alpha"), createTestStateFile("beta")];
  const host = new ReviewSessionHost({ files, sourceLabel: "/repo" });
  const harness = connectReviewSession(files, { sessionId: SESSION_ID, host });
  harness.register();
  harness.publishSnapshot();
  const review = new BrowserReviewServer(harness.state);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => (await review.handle(request)) ?? new Response(null, { status: 404 }),
  });
  running.push({ review, server });
  return { host, harness, origin: `http://127.0.0.1:${server.port}` };
}

/** Request one route with the session's capability, unless told not to. */
function request(
  origin: string,
  route: HunkReviewHttpRoute,
  init: RequestInit & { token?: string | null } = {},
) {
  const { token = reviewProcessCapability().token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== null) headers.set(HUNK_REVIEW_CAPABILITY_HEADER, token);
  return fetch(`${origin}${reviewHttpPath(route)}`, { ...rest, headers });
}

const STATE_ROUTE = { kind: "state", sessionId: SESSION_ID } as const;
const PUBLICATION_ROUTE = { kind: "publication", sessionId: SESSION_ID } as const;

describe("browser review surface: shared state", () => {
  test("serves the snapshot with the position and shared revision it describes", async () => {
    const { host, harness, origin } = start();
    host.addLiveComment({ filePath: "src/beta.ts", hunkIndex: 0, summary: "Look" }, "mcp:1");
    harness.publishSnapshot();

    const response = await request(origin, STATE_ROUTE);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as HunkReviewStateBodyV1;

    expect(body.protocolVersion).toBe(HUNK_REVIEW_PROTOCOL_VERSION);
    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.publication).toEqual(harness.producer.getPublicationAddress());
    expect(body.sharedStateRevision).toBe(host.getSharedStateRevision());
    expect(parseReviewSharedState(body.state)).toEqual(body.state);
    expect(body.state.notes.map((entry) => entry.note.id)).toEqual(["mcp:1"]);
    expect(body.state.files.map((file) => file.path)).toEqual(["src/alpha.ts", "src/beta.ts"]);
    expect(body.state.presentation.title).toBe("working tree");
  });

  test("refuses an unauthorized caller and the wrong method", async () => {
    const { origin } = start();
    const unauthorized = await request(origin, STATE_ROUTE, { token: null });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ code: "unauthorized" });

    const post = await request(origin, STATE_ROUTE, { method: "POST" });
    expect(post.status).toBe(405);
    expect(await post.json()).toMatchObject({ code: "method-not-allowed" });
  });

  test("answers a stale mirror with the producer's current state", async () => {
    const { host, origin } = start();
    // Shared content moves without the daemon being told: the read still returns the current
    // snapshot, addressed by its own revision.
    host.setFilter("beta");
    const body = (await (await request(origin, STATE_ROUTE)).json()) as HunkReviewStateBodyV1;
    expect(body.state.filter).toBe("beta");
    expect(body.sharedStateRevision).toBe(host.getSharedStateRevision());
  });

  test("coalesces concurrent reads of one position into one assembly", async () => {
    const { harness } = start();
    const before = harness.sent.filter((message) => message.command === "read_review_resource");
    const loads = Array.from({ length: 4 }, () => harness.state.loadReviewSharedState(SESSION_ID));
    expect(new Set(loads).size).toBe(1);
    const states = await Promise.all(loads);
    const reads = harness.sent.filter((message) => message.command === "read_review_resource");
    expect(new Set(states.map((state) => JSON.stringify(state))).size).toBe(1);
    expect(reads.length - before.length).toBe(1);
  });

  test("refuses a snapshot over the envelope bound with state-too-large", async () => {
    const { host, harness, origin } = start();
    // A 4 KiB note body, a thousand-odd times, is past the 4 MiB envelope bound.
    for (let index = 0; index < 1100; index += 1) {
      host.addLiveComment(
        { filePath: "src/alpha.ts", hunkIndex: 0, summary: "x".repeat(4000) },
        `mcp:big-${index}`,
      );
    }
    harness.publishSnapshot();
    const response = await request(origin, STATE_ROUTE);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "state-too-large" });
  });

  test("announces a new shared revision for content, not for selection", async () => {
    const { host, harness, origin } = start();
    const read = async () =>
      (await (await request(origin, PUBLICATION_ROUTE)).json()) as {
        publication: { stateRevision: number };
        sharedStateRevision?: number;
      };
    const initial = await read();
    expect(initial.sharedStateRevision).toBe(host.getSharedStateRevision());

    host.selectHunk("beta", 0);
    harness.publishSnapshot();
    const afterSelection = await read();
    expect(afterSelection.publication.stateRevision).toBeGreaterThan(
      initial.publication.stateRevision,
    );
    expect(afterSelection.sharedStateRevision).toBe(initial.sharedStateRevision);

    // A mark moves no store revision, yet the publication still announces it.
    host.addAgentLineHighlight({ filePath: "src/beta.ts", side: "new", line: 8, start: 0, end: 2 });
    harness.publishSnapshot();
    const afterMark = await read();
    expect(afterMark.publication).toEqual(afterSelection.publication);
    expect(afterMark.sharedStateRevision).toBeGreaterThan(afterSelection.sharedStateRevision!);
  });
});
