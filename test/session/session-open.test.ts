/**
 * `hunk session open` against a terminal-surface session, through the real session API.
 *
 * The harness runs a real producer, bridge, and broker state; the session API handler and the
 * browser review surface are mounted on one loopback listener the way the daemon mounts them.
 * The session builds the URL from the capability only it holds, so what is asserted is that the
 * URL `--no-open` prints authorizes the review API, and that opening hands the launcher exactly
 * that URL without returning it. The headless session's end-to-end coverage lives in
 * `test/session/headless.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { openSessionReview } from "../../packages/hunk/src/app/session/openReview";
import { formatOpenReviewOutput } from "../../packages/hunk/src/session/agent/cliClient";
import { handleSessionApiRequest } from "../../packages/hunk/src/session/broker/brokerServer";
import { BrowserReviewServer } from "../../packages/hunk/src/session/broker/browserReviewServer";
import { HUNK_SESSION_API_PATH } from "../../packages/hunk/src/session/protocol";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  parseReviewCapabilityFragment,
} from "../../packages/hunk/src/session/reviewHttpProtocol";
import type { OpenedReviewResult } from "../../packages/hunk/src/session/types";
import { connectReviewSession, createTestPatchFile } from "../helpers/review-session-harness";

const SESSION_ID = "session-open-1";
const running: Array<{ stop: (force?: boolean) => void; close: () => void }> = [];

afterEach(() => {
  for (const entry of running.splice(0)) {
    entry.close();
    entry.stop(true);
  }
});

/** Serve one terminal-surface session's session API and review surface on a real listener. */
function startTestTerminalSession() {
  const opened: string[] = [];
  let env: NodeJS.ProcessEnv = {};
  const harness = connectReviewSession([createTestPatchFile("alpha", 4)], {
    sessionId: SESSION_ID,
    surface: "terminal",
    openReview: ({ open }) =>
      openSessionReview(SESSION_ID, {
        open,
        env,
        openUrl: async (url) => {
          opened.push(url);
          return { ok: true };
        },
      }),
  });
  harness.register();

  const review = new BrowserReviewServer(harness.state);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      new URL(request.url).pathname === HUNK_SESSION_API_PATH
        ? handleSessionApiRequest(harness.state, request)
        : ((await review.handle(request)) ?? new Response(null, { status: 404 })),
  });
  running.push({ stop: (force) => server.stop(force), close: () => review.close() });
  env = { HUNK_MCP_PORT: String(server.port) };
  return { origin: `http://127.0.0.1:${server.port}`, opened };
}

/** Send `hunk session open`'s daemon request and return the session's answer. */
async function requestTestOpen(origin: string, open: boolean) {
  const response = await fetch(`${origin}${HUNK_SESSION_API_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "open", selector: { sessionId: SESSION_ID }, open }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: OpenedReviewResult }).result;
}

describe("hunk session open against a terminal session", () => {
  test("--no-open prints one URL line whose capability authorizes the review API", async () => {
    const { origin, opened } = startTestTerminalSession();

    const result = await requestTestOpen(origin, false);
    const printed = formatOpenReviewOutput({ sessionId: SESSION_ID }, result);

    expect(printed).toBe(`${result.url}\n`);
    expect(printed.trim()).toStartWith(`${origin}/review/${SESSION_ID}/#capability=`);
    expect(opened).toEqual([]);

    const capability = parseReviewCapabilityFragment(new URL(printed.trim()).hash)!;
    const authorized = await fetch(`${origin}/review-api/${SESSION_ID}/publication`, {
      headers: { [HUNK_REVIEW_CAPABILITY_HEADER]: capability },
    });
    expect(authorized.status).toBe(200);
    expect((await fetch(`${origin}/review-api/${SESSION_ID}/publication`)).status).toBe(401);
  });

  test("opening launches the browser in the session and returns no URL", async () => {
    const { origin, opened } = startTestTerminalSession();

    const result = await requestTestOpen(origin, true);

    expect(result).toEqual({ opened: true });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toStartWith(`${origin}/review/${SESSION_ID}/#capability=`);
    expect(formatOpenReviewOutput({ sessionId: SESSION_ID }, result)).toBe(
      "Opened session session-open-1 in your browser.\n",
    );
  });
});
