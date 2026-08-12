/**
 * Every consumer registered against the review conformance corpus.
 *
 * A rebuild phase joins by appending its adapter here, and from that moment the whole
 * corpus — including every earlier phase's adversarial fixtures — runs against it. The
 * plan's gate for a phase is that all previously registered consumers still pass and its
 * own has joined (`docs/browser-review-rebuild.md` § "Per-phase seam verification").
 */
import { coreModelConsumer } from "./consumers/coreModel";
import { terminalRenderPlanConsumer } from "./consumers/terminalRenderPlan";
import type { ReviewConformanceConsumer } from "./types";

export const REVIEW_CONFORMANCE_CONSUMERS: readonly ReviewConformanceConsumer[] = [
  coreModelConsumer,
  terminalRenderPlanConsumer,
];
