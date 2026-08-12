/**
 * Every consumer registered against the review conformance corpus.
 *
 * A rebuild phase joins by appending its adapter here, and from that moment the whole
 * corpus — including every earlier phase's adversarial fixtures — runs against it. The
 * plan's gate for a phase is that all previously registered consumers still pass and its
 * own has joined (`docs/browser-review-rebuild.md` § "Per-phase seam verification").
 */
import { coreModelConsumer } from "./consumers/coreModel";
import { intentPlannerNavigationConsumer } from "./consumers/intentPlanner";
import { terminalRenderPlanConsumer } from "./consumers/terminalRenderPlan";
import type { ReviewConformanceConsumer, ReviewNavigationConsumer } from "./types";

export const REVIEW_CONFORMANCE_CONSUMERS: readonly ReviewConformanceConsumer[] = [
  coreModelConsumer,
  terminalRenderPlanConsumer,
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
