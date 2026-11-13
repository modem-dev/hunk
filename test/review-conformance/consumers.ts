/**
 * Every consumer registered against the review conformance corpus.
 *
 * A rebuild phase joins by appending its adapter here, and from that moment the whole
 * corpus — including every earlier phase's adversarial fixtures — runs against it. The
 * plan's gate for a phase is that all previously registered consumers still pass and its
 * own has joined (`docs/browser-review-rebuild.md` § "Per-phase seam verification").
 */
import { brokerMirrorOrderingConsumer } from "./consumers/brokerMirror";
import { browserEventReaderConsumer } from "./consumers/browserEventReader";
import { browserMirrorOrderingConsumer } from "./consumers/browserMirror";
import { browserNavigationConsumer } from "./consumers/browserNavigation";
import { browserProjectionConsumer } from "./consumers/browserProjection";
import { browserReviewSurfaceEventConsumer } from "./consumers/browserReviewSurface";
import { reviewEventProtocolConsumer } from "./consumers/reviewEventProtocol";
import { coreModelConsumer } from "./consumers/coreModel";
import { extensionReviewSnapshotConsumer } from "./consumers/extensionReviewSnapshot";
import { coreOrderingConsumer } from "./consumers/coreOrdering";
import { intentPlannerNavigationConsumer } from "./consumers/intentPlanner";
import { reviewProducerConsumer } from "./consumers/reviewProducer";
import {
  browserSurfaceActorPolicyConsumer,
  producerActorPolicyConsumer,
} from "./consumers/actorPolicy";
import type { ReviewActorPolicyConsumer } from "./actorPolicyFixtures";
import {
  brokerSharedStateConsumer,
  browserClientSharedStateConsumer,
  browserSurfaceSharedStateConsumer,
  reviewProducerSharedStateConsumer,
} from "./consumers/sharedState";
import type { ReviewSharedStateConsumer } from "./sharedStateFixtures";
import { reviewSessionHostNavigationConsumer } from "./consumers/reviewSessionHost";
import { reviewWireConsumer } from "./consumers/reviewWire";
import { terminalReviewNavigationConsumer } from "./consumers/terminalReview";
import { terminalRenderPlanConsumer } from "./consumers/terminalRenderPlan";
import type {
  ReviewEventConsumer,
  ReviewGeometryConsumer,
  ReviewNavigationConsumer,
  ReviewOrderingConsumer,
  ReviewSnapshotConsumer,
  ReviewWireConsumer,
} from "./types";

export const REVIEW_GEOMETRY_CONSUMERS: readonly ReviewGeometryConsumer[] = [
  coreModelConsumer,
  terminalRenderPlanConsumer,
  reviewProducerConsumer,
  browserProjectionConsumer,
];

/** Consumers that export complete authoritative saved-note state. */
export const REVIEW_SNAPSHOT_CONSUMERS: readonly ReviewSnapshotConsumer[] = [
  extensionReviewSnapshotConsumer,
];

/**
 * Consumers of the shared navigation semantics.
 *
 * A separate registry because navigation answers different questions than geometry, under
 * the same contract: the browser's projection and the wire join these fixtures in later
 * phases, and every earlier consumer keeps running.
 */
export const REVIEW_NAVIGATION_CONSUMERS: readonly ReviewNavigationConsumer[] = [
  intentPlannerNavigationConsumer,
  terminalReviewNavigationConsumer,
  reviewSessionHostNavigationConsumer,
  browserNavigationConsumer,
];

/**
 * Consumers of the publication-ordering contract.
 *
 * The contract itself answers first, and every tier that orders publications joins beside
 * it: the broker's mirror here, a browser client's in Phase 5. A tier with a rule of its
 * own disagrees with the reference on the fixtures the C1 finding contributed.
 */
export const REVIEW_ORDERING_CONSUMERS: readonly ReviewOrderingConsumer[] = [
  coreOrderingConsumer,
  brokerMirrorOrderingConsumer,
  browserMirrorOrderingConsumer,
];

/**
 * Consumers of the wire schema.
 *
 * One so far — the protocol module itself — with the HTTP surface and the browser client
 * joining in later phases, so what an action means cannot fork between the tier that
 * validates it and the tier that sends it.
 */
export const REVIEW_WIRE_CONSUMERS: readonly ReviewWireConsumer[] = [reviewWireConsumer];

/**
 * Consumers of the event contract.
 *
 * The shared protocol answers first and the HTTP surface answers beside it, over a real
 * listener — which is what proves the surface has no framing of its own. A browser
 * client's reader joins in Phase 5, closing the loop the C4 finding is about.
 */
export const REVIEW_EVENT_CONSUMERS: readonly ReviewEventConsumer[] = [
  reviewEventProtocolConsumer,
  browserReviewSurfaceEventConsumer,
  browserEventReaderConsumer,
];

/**
 * Consumers of the shared-state snapshot.
 *
 * The producer that materializes it, the broker that reads it back through its verified
 * resource loop, and the HTTP surface that serves it; the browser client joins in M4.
 */
export const REVIEW_SHARED_STATE_CONSUMERS: readonly ReviewSharedStateConsumer[] = [
  reviewProducerSharedStateConsumer,
  brokerSharedStateConsumer,
  browserSurfaceSharedStateConsumer,
  browserClientSharedStateConsumer,
];

/**
 * Consumers of the multi-surface action policy (G2) and shared viewed files (G1).
 *
 * The producer's action handler applies the policy; the HTTP surface is how a browser reaches
 * it. The browser client joins in M4, where it resolves the refused selection moves locally.
 */
export const REVIEW_ACTOR_POLICY_CONSUMERS: readonly ReviewActorPolicyConsumer[] = [
  producerActorPolicyConsumer,
  browserSurfaceActorPolicyConsumer,
];
