/**
 * The multi-surface action policy over HTTP: refused browser selection moves, agent reveals,
 * note authorship from the actor, and viewed files read back from `/state`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { reviewProcessCapability } from "../../app/review/capability";
import { ReviewSessionHost } from "../../app/review/reviewSessionHost";
import { applySessionReviewAction } from "../../app/session/reviewCommands";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import { connectReviewSession } from "../../../../../test/helpers/review-session-harness";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  reviewHttpPath,
  type HunkReviewStateBodyV1,
} from "../reviewHttpProtocol";
import { HUNK_REVIEW_PROTOCOL_VERSION, type HunkReviewActorV1 } from "../reviewProtocol";
import { BrowserReviewServer } from "./browserReviewServer";

const SESSION_ID = "session-policy-1";
const running: Array<{ review: BrowserReviewServer; server: { stop: (force?: boolean) => void } }> =
  [];

afterEach(() => {
  for (const entry of running.splice(0)) {
    entry.review.close();
    entry.server.stop(true);
  }
});

/** One file with a single changed line 8. */
function createTestPolicyFile(id: string) {
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

/** Serve one host-backed terminal session. */
function start() {
  const files = [createTestPolicyFile("alpha"), createTestPolicyFile("beta")];
  const host = new ReviewSessionHost({ files, sourceLabel: "/repo" });
  const harness = connectReviewSession(files, { sessionId: SESSION_ID, host });
  harness.register();
  harness.publishSnapshot();
  const review = new BrowserReviewServer(harness.state);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => (await review.handle(request)) ?? new Response(null, { status: 404 }),
  });
  running.push({ review, server });
  const origin = `http://127.0.0.1:${server.port}`;
  const headers = { [HUNK_REVIEW_CAPABILITY_HEADER]: reviewProcessCapability().token };
  const act = (actor: HunkReviewActorV1, action: Record<string, unknown>) =>
    fetch(`${origin}${reviewHttpPath({ kind: "actions", sessionId: SESSION_ID })}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
        generation: harness.producer.getPublication().generation,
        actor,
        action,
      }),
    });
  const readState = async () =>
    (await (
      await fetch(`${origin}${reviewHttpPath({ kind: "state", sessionId: SESSION_ID })}`, {
        headers,
      })
    ).json()) as HunkReviewStateBodyV1;
  return { host, harness, act, readState };
}

describe("browser review surface: actor policy", () => {
  test("refuses a browser's selection move with selection-is-local and leaves the session alone", async () => {
    const { host, act } = start();
    const before = host.getSnapshot().selection;
    const response = await act(
      { clientId: "tab", kind: "browser" },
      { type: "selection/select-file", fileKey: host.fileKeyFor("beta") },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, code: "selection-is-local" });
    expect(host.getSnapshot().selection).toEqual(before);
  });

  test("refuses a capability caller that declares an agent or terminal kind", async () => {
    const { host, act } = start();
    const before = host.getSnapshot().selection;
    for (const kind of ["agent", "terminal"] as const) {
      const response = await act(
        { clientId: "claimed", kind },
        { type: "selection/select-file", fileKey: host.fileKeyFor("beta") },
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ ok: false, code: "forbidden-actor" });
    }
    expect(host.getSnapshot().selection).toEqual(before);
    expect(host.getAgentReveal()).toBeNull();
  });

  test("records an agent's selection as the reveal every surface honors", async () => {
    const { host, harness, readState } = start();
    // Agents reach the producer through the authenticated session API, not the review link.
    const result = applySessionReviewAction(harness.producer, {
      protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
      generation: harness.producer.getPublication().generation,
      actor: { clientId: "agent", kind: "agent" },
      action: { type: "selection/select-file", fileKey: host.fileKeyFor("beta")! },
    });
    expect(result.ok).toBe(true);
    harness.publishSnapshot();
    expect((await readState()).state.agentReveal).toEqual({
      token: 1,
      fileKey: host.fileKeyFor("beta")!,
      hunkIndex: 0,
    });
  });

  test("defaults a direct note's author from the actor and shares viewed files", async () => {
    const { host, act, readState } = start();
    const browser: HunkReviewActorV1 = { clientId: "tab", kind: "browser", displayName: "Ana" };
    expect(
      (
        await act(browser, {
          type: "notes/add-user",
          fileKey: host.fileKeyFor("alpha"),
          hunkIndex: 0,
          body: "From the browser",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await act(browser, {
          type: "files/set-viewed",
          fileKey: host.fileKeyFor("beta"),
          viewed: true,
        })
      ).status,
    ).toBe(200);

    const { state } = await readState();
    expect(
      state.notes.map((entry) => [entry.origin, entry.note.author, entry.note.summary]),
    ).toEqual([["user", "Ana", "From the browser"]]);
    expect(Object.keys(state.viewedFiles)).toEqual([host.fileKeyFor("beta")!]);
    expect(host.getSnapshot().draftNote).toBeNull();
  });
});
