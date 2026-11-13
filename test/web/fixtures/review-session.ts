#!/usr/bin/env bun

/**
 * Runs one real Hunk review session without a terminal UI and prints its browser review URL.
 *
 * The browser tests need a live session whose capability they know, and only the process
 * that owns a session ever holds the clear capability. Until the headless review host lands,
 * this script is that owner: it loads a review (a patch through the real bootstrap loader,
 * or the rich scenario in `rich-review.ts`), registers through the real
 * `createReviewSessionRuntime` with the daemon on `HUNK_MCP_PORT`, and answers review
 * commands through the real session bridge. It prints one JSON line, `{ "url": … }`, then
 * serves until terminated. A `reload` line on stdin publishes the next generation, the way a
 * terminal session's reload does.
 *
 * Usage: bun test/web/fixtures/review-session.ts <patch-file | --rich | --many=N>
 */

import path from "node:path";
import { createInterface } from "node:readline";
import { reviewProcessUrl } from "../../../packages/hunk/src/app/review/capability";
import { createHunkSessionBridge } from "../../../packages/hunk/src/app/session/bridge";
import {
  createInitialSessionSnapshot,
  updateSessionRegistration,
} from "../../../packages/hunk/src/app/session/registration";
import { createReviewSessionRuntime } from "../../../packages/hunk/src/app/session/reviewRuntime";
import type { AppBootstrap } from "../../../packages/hunk/src/core/bootstrap";
import { loadAppBootstrap } from "../../../packages/hunk/src/core/changeset/loaders";
import type { DiffFile } from "../../../packages/hunk/src/core/changeset/model";
import { createReviewStore } from "../../../packages/hunk/src/core/review/store";
import { resolveSessionBrokerConfig } from "../../../packages/hunk/src/session/broker/brokerConfig";
import { buildManyReviewFiles, buildRichReviewFiles } from "./rich-review";

const input = process.argv[2];
if (!input) {
  throw new Error(
    "Usage: bun test/web/fixtures/review-session.ts <patch-file | --rich | --many=N>",
  );
}

/** A bootstrap around a given file list, as the rich scenario builds its files directly. */
function bootstrapFor(files: DiffFile[]): AppBootstrap {
  return {
    input: { kind: "patch", text: "", options: {} },
    changeset: { id: "rich", title: "Rich review", sourceLabel: "/rich", files },
    initialMode: "auto",
    reloadContext: { cwd: process.cwd() },
  };
}

const rich = input === "--rich";
const many = /^--many=(\d+)$/.exec(input);
let generation = 0;
let bootstrap = rich
  ? bootstrapFor(await buildRichReviewFiles(generation))
  : many
    ? bootstrapFor(buildManyReviewFiles(Number(many[1])))
    : await loadAppBootstrap(
        { kind: "patch", file: path.resolve(input), options: {} },
        { cwd: path.dirname(path.resolve(input)) },
      );
const runtime = createReviewSessionRuntime(bootstrap, process.cwd());
runtime.reviewProducer.attachStore(
  createReviewStore(runtime.reviewProducer.getPublication().document),
);

/** Refuse every terminal-only command; the browser tests only read the review. */
function unsupported(): never {
  throw new Error("The browser test session serves review reads only.");
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

/** Publish the next generation of the rich scenario, as a terminal reload would. */
async function reload() {
  generation += 1;
  bootstrap = bootstrapFor(await buildRichReviewFiles(generation));
  const publication = runtime.reviewProducer.publish({
    files: bootstrap.changeset.files,
    sourceLabel: bootstrap.changeset.sourceLabel,
  });
  runtime.reviewProducer.attachStore(createReviewStore(publication.document));
  runtime.hostClient.replaceSession(
    updateSessionRegistration(runtime.hostClient.getRegistration(), bootstrap, publication),
    createInitialSessionSnapshot(bootstrap, publication),
  );
  console.log(JSON.stringify({ reloaded: publication.generation }));
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "reload" && rich) void reload();
});

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
