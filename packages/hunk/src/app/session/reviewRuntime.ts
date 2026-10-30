import { createNativeSessionBrokerLifecycleClock } from "@hunk/session-broker";
import type { AppBootstrap } from "../../core/bootstrap";
import { SessionBrokerClient } from "../../session/broker/brokerClient";
import { reportHunkSessionBrokerLifecycleDefect } from "../../session/broker/lifecycleDefect";
import { ReviewProducer } from "../review/producer";
import { createInitialSessionSnapshot, createSessionRegistration } from "./registration";

export interface ReviewSessionRuntime {
  hostClient: SessionBrokerClient;
  reviewProducer: ReviewProducer;
  stop(): void;
}

/** Create broker and producer resources for one independently mountable review surface. */
export function createReviewSessionRuntime(
  bootstrap: AppBootstrap,
  cwd = process.cwd(),
): ReviewSessionRuntime {
  const reviewProducer = new ReviewProducer({
    files: bootstrap.changeset.files,
    sourceLabel: bootstrap.changeset.sourceLabel,
  });
  const publication = reviewProducer.getPublication();
  const lifecycleClock = createNativeSessionBrokerLifecycleClock();
  const hostClient = new SessionBrokerClient(
    createSessionRegistration(bootstrap, publication, cwd),
    createInitialSessionSnapshot(bootstrap, publication),
    { lifecycleClock, onDefect: reportHunkSessionBrokerLifecycleDefect },
  );
  hostClient.start();
  let stopped = false;
  return {
    hostClient,
    reviewProducer,
    stop() {
      if (stopped) return;
      hostClient.stop();
      stopped = true;
    },
  };
}
