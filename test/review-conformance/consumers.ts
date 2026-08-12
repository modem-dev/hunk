/**
 * Every consumer registered against the review conformance corpus.
 *
 * A rebuild phase joins by appending its adapter here, and from that moment the whole
 * corpus — including every earlier phase's adversarial fixtures — runs against it. The
 * plan's gate for a phase is that all previously registered consumers still pass and its
 * own has joined (`docs/browser-review-rebuild.md` § "Per-phase seam verification").
 */
import { brokerMirrorOrderingConsumer } from "./consumers/brokerMirror";
import { coreModelConsumer } from "./consumers/coreModel";
import { coreOrderingConsumer } from "./consumers/coreOrdering";
import { intentPlannerNavigationConsumer } from "./consumers/intentPlanner";
import { reviewProducerConsumer } from "./consumers/reviewProducer";
import { reviewWireConsumer } from "./consumers/reviewWire";
import { terminalRenderPlanConsumer } from "./consumers/terminalRenderPlan";
import type {
  ReviewConformanceConsumer,
  ReviewNavigationConsumer,
  ReviewOrderingConsumer,
  ReviewWireConsumer,
} from "./types";

export const REVIEW_CONFORMANCE_CONSUMERS: readonly ReviewConformanceConsumer[] = [
  coreModelConsumer,
  terminalRenderPlanConsumer,
  reviewProducerConsumer,
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
];

/**
 * Consumers of the wire schema.
 *
 * One so far — the protocol module itself — with the HTTP surface and the browser client
 * joining in later phases, so what an action means cannot fork between the tier that
 * validates it and the tier that sends it.
 */
export const REVIEW_WIRE_CONSUMERS: readonly ReviewWireConsumer[] = [reviewWireConsumer];
