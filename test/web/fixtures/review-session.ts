#!/usr/bin/env bun

/**
 * Runs one real Hunk review session without a terminal UI and prints its browser review URL.
 *
 * The browser smoke test needs a live session whose capability it knows, and only the
 * process that owns a session ever holds the clear capability. Until the headless review
 * host lands, this script is that owner: it loads a patch through the real bootstrap loader,
 * registers through the real `createReviewSessionRuntime` with the daemon on
 * `HUNK_MCP_PORT`, and answers review commands through the real session bridge. It prints
 * one JSON line, `{ "url": … }`, then serves until it is terminated.
 *
 * Usage: bun test/web/fixtures/review-session.ts <patch-file>
 */

import path from "node:path";
import { reviewProcessUrl } from "../../../packages/hunk/src/app/review/capability";
import { createHunkSessionBridge } from "../../../packages/hunk/src/app/session/bridge";
import { createReviewSessionRuntime } from "../../../packages/hunk/src/app/session/reviewRuntime";
import { loadAppBootstrap } from "../../../packages/hunk/src/core/changeset/loaders";
import { createReviewStore } from "../../../packages/hunk/src/core/review/store";
import { resolveSessionBrokerConfig } from "../../../packages/hunk/src/session/broker/brokerConfig";

const patchFile = process.argv[2];
if (!patchFile) {
  throw new Error("Usage: bun test/web/fixtures/review-session.ts <patch-file>");
}

const bootstrap = await loadAppBootstrap(
  { kind: "patch", file: path.resolve(patchFile), options: {} },
  { cwd: path.dirname(path.resolve(patchFile)) },
);
const runtime = createReviewSessionRuntime(bootstrap, path.dirname(path.resolve(patchFile)));
runtime.reviewProducer.attachStore(
  createReviewStore(runtime.reviewProducer.getPublication().document),
);

/** Refuse every terminal-only command; the smoke test only reads the review. */
function unsupported(): never {
  throw new Error("The browser smoke session serves review reads only.");
}

runtime.hostClient.setBridge(
  createHunkSessionBridge({
    addLiveComment: unsupported,
    addLiveCommentBatch: unsupported,
    clearLiveComments: unsupported,
    navigateToLocation: unsupported,
    addAgentLineHighlight: unsupported,
    clearAgentLineHighlights: unsupported,
    openAgentNotes: () => undefined,
    reloadSession: unsupported,
    removeLiveComment: unsupported,
    reviewProducer: runtime.reviewProducer,
  }),
);

const stop = () => {
  runtime.stop();
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

const { httpOrigin } = resolveSessionBrokerConfig();
console.log(
  JSON.stringify({
    url: reviewProcessUrl(httpOrigin, runtime.hostClient.getRegistration().sessionId),
  }),
);
