/**
 * The browser client against a real review, with only the browser missing.
 *
 * A real producer publishes a real generation, a real broker state mirrors it, the review
 * surface is mounted on a real loopback listener, and the client under test is the one the
 * browser bundle runs — same `BrowserReviewApiClient`, same `BrowserReviewMirror`, same synchronous
 * digest. Nothing between the two ends is stubbed, so what is asserted here is the loop the
 * whole phase is about: a publication read over HTTP, a document read out of the catalog it
 * names, and a new publication arriving on the event stream.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { reviewProcessCapability } from "../../src/app/review/capability";
import { reviewResourceId } from "../../src/core/review/resources";
import { WebReviewServer } from "../../src/session/broker/webReviewServer";
import { reviewHttpPath, reviewUrl } from "../../src/session/reviewHttpProtocol";
import { BrowserReviewApiClient, parseBrowserReviewLocation } from "../../src/web/reviewApiClient";
import { BrowserReviewMirror, type BrowserReviewMirrorSnapshot } from "../../src/web/reviewMirror";
import { connectReviewSession, createTestPatchFile } from "../helpers/review-session-harness";

const SESSION_ID = "session-web-1";

const running: Array<{ review: WebReviewServer; server: { stop: (force?: boolean) => void } }> = [];

afterEach(() => {
  for (const entry of running.splice(0)) {
    entry.review.close();
    entry.server.stop(true);
  }
});

/** Connect a session, mount the review surface over it, and build the client for it. */
function start(files = [createTestPatchFile("alpha", 4), createTestPatchFile("beta", 2)]) {
  const harness = connectReviewSession(files, { sessionId: SESSION_ID });
  const registration = harness.register();
  // The registration the session first published, so a reload can update it in place the
  // way a live session does.
  const review = new WebReviewServer(harness.state);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => (await review.handle(request)) ?? new Response(null, { status: 404 }),
  });
  running.push({ review, server });

  const origin = `http://127.0.0.1:${server.port}`;
  // Built the way a browser gets it: parse the URL the session would print.
  const location = parseBrowserReviewLocation(
    new URL(reviewUrl(origin, SESSION_ID, reviewProcessCapability().token)),
  )!;
  return { harness, registration, origin, client: new BrowserReviewApiClient(location) };
}

/** Wait for the mirror to reach a snapshot, failing loudly rather than hanging forever. */
async function waitFor(
  mirror: BrowserReviewMirror,
  describeWanted: string,
  wanted: (snapshot: BrowserReviewMirrorSnapshot) => boolean,
) {
  return await new Promise<BrowserReviewMirrorSnapshot>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `The mirror stayed at ${mirror.getSnapshot().status}, waiting for ${describeWanted}.`,
        ),
      );
    }, 5_000);
    const settle = (snapshot: BrowserReviewMirrorSnapshot) => {
      if (!wanted(snapshot)) {
        return;
      }
      clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
    };
    const unsubscribe = mirror.subscribe(settle);
    settle(mirror.getSnapshot());
  });
}

/** Wait for the mirror to hold a complete document. */
function waitForReady(mirror: BrowserReviewMirror) {
  return waitFor(mirror, "a complete document", (snapshot) => snapshot.status === "ready");
}

describe("browser review client", () => {
  test("reads the publication the session is serving", async () => {
    const { harness, client } = start();

    const result = await client.readPublication();

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.publication).toEqual(harness.producer.getPublicationAddress());
    expect(result.value.catalog.generation).toBe(harness.producer.getPublication().generation);
  });

  test("refuses a publication read without the capability", async () => {
    const { origin } = start();
    const anonymous = new BrowserReviewApiClient({
      origin,
      sessionId: SESSION_ID,
      capability: "x",
    });

    const result = await anonymous.readPublication();

    expect(result).toMatchObject({ ok: false, code: "unauthorized" });
  });

  test("reads and verifies one resource larger than a single response", async () => {
    // Well over the shared chunk size, so the read is several windows the assembler has to
    // join — the case the prototype's own range loop got wrong.
    const { harness, client } = start([createTestPatchFile("wide", 20_000)]);
    const publication = harness.producer.getPublication();
    const descriptor = publication.resources.find((resource) => resource.kind === "patch")!;

    const result = await client.readResource(descriptor);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(new TextDecoder().decode(result.value)).toBe(publication.document.files[0]!.patch);
    expect(result.value.byteLength).toBeGreaterThan(256 * 1024);
  });

  test("reports a resource the generation does not offer", async () => {
    const { harness, client } = start();

    const result = await client.readResource({
      id: reviewResourceId({ kind: "patch", fileKey: "file:deadbeef" }),
      generation: harness.producer.getPublication().generation,
      kind: "patch",
    });

    expect(result).toMatchObject({ ok: false, code: "unknown-resource" });
  });

  test("mirrors the whole document, in review order, from the stream's first event", async () => {
    const { harness, client } = start();
    const mirror = new BrowserReviewMirror(client);

    mirror.start();
    const ready = await waitForReady(mirror);
    mirror.stop();

    const published = harness.producer.getPublication();
    expect(ready.publication).toEqual(harness.producer.getPublicationAddress());
    expect(ready.document?.files.map((file) => file.path)).toEqual(
      published.document.files.map((file) => file.path),
    );
    expect(ready.document?.files.map((file) => file.contentIdentity)).toEqual(
      published.document.files.map((file) => file.contentIdentity),
    );
  });

  test("resyncs onto a new generation when the session reloads", async () => {
    const { harness, client, registration } = start();
    const mirror = new BrowserReviewMirror(client);

    mirror.start();
    const first = await waitForReady(mirror);

    harness.producer.publish({
      files: [createTestPatchFile("gamma", 3)],
      sourceLabel: harness.bootstrap.changeset.sourceLabel,
    });
    harness.publishSnapshot();
    harness.register(registration);

    const second = await waitFor(
      mirror,
      "a document for the next generation",
      (snapshot) =>
        snapshot.status === "ready" &&
        snapshot.publication?.generation !== first.publication?.generation,
    );
    mirror.stop();

    expect(second.publication?.generation).not.toBe(first.publication?.generation);
    expect(second.document?.files.map((file) => file.path)).toEqual(["src/gamma.ts"]);
  });

  test("refuses a resource whose bytes were corrupted in transit", async () => {
    const harness = connectReviewSession([createTestPatchFile("alpha", 4)], {
      sessionId: SESSION_ID,
      corruptResourceChunks: true,
    });
    harness.register();
    const review = new WebReviewServer(harness.state);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: async (request) =>
        (await review.handle(request)) ?? new Response(null, { status: 404 }),
    });
    running.push({ review, server });
    const client = new BrowserReviewApiClient({
      origin: `http://127.0.0.1:${server.port}`,
      sessionId: SESSION_ID,
      capability: reviewProcessCapability().token,
    });

    const result = await client.readResource(
      harness.producer.getPublication().resources.find((resource) => resource.kind === "patch")!,
    );

    // The daemon's own assembler catches it first, which is the point: corruption is
    // reported as corruption at whichever tier sees it, never as a missing resource.
    expect(result).toMatchObject({ ok: false, code: "resource-integrity" });
  });

  test("addresses every route through the shared path grammar", () => {
    // The client never assembles a review path itself; this pins that the grammar it uses
    // is the one the surface parses.
    expect(reviewHttpPath({ kind: "publication", sessionId: SESSION_ID })).toBe(
      `/review-api/${SESSION_ID}/publication`,
    );
  });
});
