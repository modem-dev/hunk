/**
 * The publication-ordering corpus: what is ahead, what is behind, and what needs a resnap.
 *
 * The rule these fixtures pin lives in `packages/hunk/src/core/review/generationOrder.ts`
 * (`docs/browser-review-seam-audit.md`, C1). They pin it from both ends: the
 * classification itself, and the transitions a real producer actually emits.
 *
 * Verdicts are written by hand from the invariant, never captured from the classifier.
 */
import type { ReviewPublicationOrder } from "../../packages/hunk/src/core/review/generationOrder";

/** One arriving publication judged against the position a receiver already holds. */
export interface ReviewPublicationOrderFixture {
  id: string;
  /** Audit finding ids this fixture guards. */
  findings: string[];
  description: string;
  current: { generation: string; stateRevision: number };
  incoming: { generation: string; stateRevision: number };
  /** Hand-written from the invariant. */
  expected: ReviewPublicationOrder;
}

const p1 = (sequence: number) => `generation:p1:${sequence}`;
const p2 = (sequence: number) => `generation:p2:${sequence}`;

export const REVIEW_PUBLICATION_ORDER_FIXTURES: readonly ReviewPublicationOrderFixture[] = [
  {
    id: "next-revision",
    findings: ["C1"],
    description: "The ordinary case: one more revision of the generation being served.",
    current: { generation: p1(3), stateRevision: 7 },
    incoming: { generation: p1(3), stateRevision: 8 },
    expected: "accepted",
  },
  {
    id: "non-contiguous-revision",
    findings: ["C1"],
    description:
      "A revision that skipped ahead, as a late join or a replayed log produces — legal, and the case the prototype's client rejected.",
    current: { generation: p1(3), stateRevision: 7 },
    incoming: { generation: p1(3), stateRevision: 41 },
    expected: "accepted",
  },
  {
    id: "replayed-revision",
    findings: ["C1"],
    description: "The same position again: a replay, never an update.",
    current: { generation: p1(3), stateRevision: 7 },
    incoming: { generation: p1(3), stateRevision: 7 },
    expected: "stale",
  },
  {
    id: "earlier-revision",
    findings: ["C1"],
    description: "A publication from before the receiver's position.",
    current: { generation: p1(3), stateRevision: 7 },
    incoming: { generation: p1(3), stateRevision: 6 },
    expected: "stale",
  },
  {
    id: "generation-swap",
    findings: ["C1"],
    description:
      "The next generation, whose revisions restart — nothing carries over, so the receiver must resnapshot rather than apply.",
    current: { generation: p1(3), stateRevision: 7 },
    incoming: { generation: p1(4), stateRevision: 0 },
    expected: "gap",
  },
  {
    id: "generation-swap-with-lower-revision",
    findings: ["C1"],
    description:
      "The same swap stated adversarially: the arriving revision is far below the current one, and the generation still wins.",
    current: { generation: p1(3), stateRevision: 900 },
    incoming: { generation: p1(4), stateRevision: 1 },
    expected: "gap",
  },
  {
    id: "skipped-generation",
    findings: ["C1"],
    description: "Two generations ahead: still a gap, and still not applicable incrementally.",
    current: { generation: p1(3), stateRevision: 7 },
    incoming: { generation: p1(6), stateRevision: 0 },
    expected: "gap",
  },
  {
    id: "retired-generation",
    findings: ["C1"],
    description:
      "An earlier generation at a higher revision — the retired-generation replay the prototype's mirror needed a memory of retired ids to reject.",
    current: { generation: p1(4), stateRevision: 1 },
    incoming: { generation: p1(3), stateRevision: 900 },
    expected: "stale",
  },
  {
    id: "foreign-producer",
    findings: ["C1"],
    description:
      "Another producer's sequence: unrelated, so neither supersedes the other however the numbers compare.",
    current: { generation: p1(3), stateRevision: 7 },
    incoming: { generation: p2(9), stateRevision: 900 },
    expected: "stale",
  },
  {
    id: "unparseable-identity",
    findings: ["C1"],
    description: "An identity outside the grammar is never accepted, whatever it claims.",
    current: { generation: p1(3), stateRevision: 7 },
    incoming: { generation: "generation:p1", stateRevision: 900 },
    expected: "stale",
  },
];

/**
 * One step in a producer's life, and how the publication it emits relates to the last one.
 *
 * `state` changes the review a producer is serving; `reload` publishes the next generation.
 */
export interface ReviewProducerOrderStep {
  kind: "state" | "reload";
  /** Hand-written from the invariant: how this step's address relates to the previous. */
  expected: ReviewPublicationOrder;
}

export interface ReviewProducerOrderFixture {
  id: string;
  findings: string[];
  description: string;
  steps: readonly ReviewProducerOrderStep[];
}

export const REVIEW_PRODUCER_ORDER_FIXTURES: readonly ReviewProducerOrderFixture[] = [
  {
    id: "revisions-then-reload",
    findings: ["C1"],
    description:
      "Every state change moves the producer forward within its generation, and the reload after them is a generation swap rather than another revision.",
    steps: [
      { kind: "state", expected: "accepted" },
      { kind: "state", expected: "accepted" },
      { kind: "reload", expected: "gap" },
      { kind: "state", expected: "accepted" },
    ],
  },
  {
    id: "back-to-back-reloads",
    findings: ["C1"],
    description:
      "Consecutive reloads each advance exactly one generation, so a receiver sees a swap per reload and never a skip.",
    steps: [
      { kind: "reload", expected: "gap" },
      { kind: "reload", expected: "gap" },
      { kind: "reload", expected: "gap" },
    ],
  },
];
