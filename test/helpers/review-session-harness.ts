/**
 * Connects a real review producer to a real broker state, faking only the socket.
 *
 * Every review path worth testing above the producer — mirroring, resource assembly,
 * action forwarding, and the HTTP surface above them — runs against a live session on the
 * other end of a websocket. This builds that pair in-process: a real `ReviewProducer`, a
 * real registration and snapshot, a real `HunkSessionBridge`, and a real
 * `HunkSessionBrokerState`, with a stand-in socket that dispatches commands
 * asynchronously exactly as the websocket does. Nothing else is stubbed, so concurrency
 * and ordering are real rather than collapsed into synchronous calls.
 */
import { ReviewProducer } from "../../packages/hunk/src/app/review/producer";
import { createReviewStore } from "../../packages/hunk/src/core/review/store";
import { createHunkSessionBridge } from "../../packages/hunk/src/app/session/bridge";
import {
  createInitialSessionSnapshot,
  createSessionRegistration,
  updateSessionRegistration,
} from "../../packages/hunk/src/app/session/registration";
import { HunkSessionBrokerState } from "../../packages/hunk/src/session/broker/state";
import { ReviewResourceCache } from "../../packages/hunk/src/session/broker/reviewResourceCache";
import type { AppBootstrap } from "../../packages/hunk/src/core/bootstrap";
import type { DiffFile } from "../../packages/hunk/src/core/changeset/model";
import type {
  HunkSessionRegistration,
  HunkSessionServerMessage,
} from "../../packages/hunk/src/session/types";
import { createTestDiffFile } from "./diff-helpers";

export interface ReviewSessionHarnessOptions {
  sessionId?: string;
  cache?: ReviewResourceCache;
  /**
   * Flip a byte in every resource chunk the session returns.
   *
   * Fault injection at the transport, which is the one place corruption can enter without
   * either end being wrong: the producer measured honest bytes and the reader verifies
   * against that measurement, so this exercises the verification rather than a bug.
   */
  corruptResourceChunks?: boolean;
}

/**
 * Build one file carrying a real patch string of the requested line count.
 *
 * The patch is what the producer publishes as a resource, so a test about chunking needs
 * one genuinely longer than a chunk. It is stated directly rather than parsed from large
 * inputs: the resource path cares about the bytes, and parsing a hundred-thousand-line
 * changeset to obtain them would only make the test slow.
 */
export function createTestPatchFile(id: string, patchLines: number): DiffFile {
  const patch = [
    `--- a/src/${id}.ts`,
    `+++ b/src/${id}.ts`,
    `@@ -1,${patchLines} +1,${patchLines} @@`,
    ...Array.from({ length: patchLines }, (_unused, index) => `-const value${index} = ${index};`),
    ...Array.from(
      { length: patchLines },
      (_unused, index) => `+const value${index} = ${index + 1};`,
    ),
    "",
  ].join("\n");
  return { ...createTestDiffFile({ id, path: `src/${id}.ts` }), patch };
}

/** The bootstrap a working-tree review of these files would have been built from. */
export function createTestReviewBootstrap(files: DiffFile[]): AppBootstrap {
  return {
    input: { kind: "vcs", staged: false, options: {} },
    changeset: { id: "changeset-1", title: "working tree", sourceLabel: "/repo", files },
    initialMode: "split",
    reloadContext: { cwd: "/repo" },
  };
}

/** Corrupt one base64 chunk in place, keeping its length so verification is what fails. */
function corruptChunkData(data: string) {
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  if (bytes.byteLength > 0) {
    bytes[0] = bytes[0]! ^ 0xff;
  }
  return Buffer.from(bytes).toString("base64");
}

/** Connect one producer to one broker state through a socket that runs the real bridge. */
export function connectReviewSession(files: DiffFile[], options: ReviewSessionHarnessOptions = {}) {
  const sessionId = options.sessionId ?? "session-1";
  const bootstrap = createTestReviewBootstrap(files);
  const producer = new ReviewProducer(
    { files, sourceLabel: bootstrap.changeset.sourceLabel },
    { producerId: "integration" },
  );
  producer.attachStore(createReviewStore(producer.getPublication().document));

  const state = new HunkSessionBrokerState(options.cache ?? new ReviewResourceCache());
  const sent: HunkSessionServerMessage[] = [];
  const bridge = createHunkSessionBridge({
    addLiveComment: () => {
      throw new Error("unused");
    },
    addLiveCommentBatch: () => {
      throw new Error("unused");
    },
    clearLiveComments: () => {
      throw new Error("unused");
    },
    navigateToLocation: () => {
      throw new Error("unused");
    },
    addAgentLineHighlight: () => {
      throw new Error("unused");
    },
    clearAgentLineHighlights: () => {
      throw new Error("unused");
    },
    openAgentNotes: () => undefined,
    reloadSession: () => {
      throw new Error("unused");
    },
    removeLiveComment: () => {
      throw new Error("unused");
    },
    reviewProducer: producer,
  });

  const socket = {
    send(data: string) {
      const message = JSON.parse(data) as HunkSessionServerMessage;
      sent.push(message);
      void bridge.dispatchCommand(message).then((result) => {
        const delivered =
          options.corruptResourceChunks &&
          message.command === "read_review_resource" &&
          (result as { ok?: boolean; chunk?: { data: string } }).ok
            ? {
                ...(result as object),
                chunk: {
                  ...(result as { chunk: { data: string } }).chunk,
                  data: corruptChunkData((result as { chunk: { data: string } }).chunk.data),
                },
              }
            : result;
        state.handleCommandResult(socket, {
          requestId: message.requestId,
          ok: true,
          result: delivered as typeof result,
        });
      });
    },
  };

  /** Register the current publication, the way a live session does on connect and reload. */
  function register(registration?: HunkSessionRegistration) {
    const publication = producer.getPublication();
    const next = registration
      ? updateSessionRegistration(registration, bootstrap, publication)
      : { ...createSessionRegistration(bootstrap, publication), sessionId };
    const snapshot = createInitialSessionSnapshot(bootstrap, publication);
    state.registerSession(
      socket,
      JSON.parse(JSON.stringify(next)),
      JSON.parse(JSON.stringify(snapshot)),
    );
    return next;
  }

  /** Publish the session's live position, the way the UI does after a state change. */
  function publishSnapshot() {
    const publication = producer.getPublication();
    const snapshot = createInitialSessionSnapshot(bootstrap, publication);
    state.updateSnapshot(
      socket,
      sessionId,
      JSON.parse(
        JSON.stringify({
          ...snapshot,
          state: {
            ...snapshot.state,
            reviewPublication: producer.getPublicationAddress(),
          },
        }),
      ),
    );
  }

  return { bootstrap, producer, state, socket, sent, sessionId, register, publishSnapshot };
}
