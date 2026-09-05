/**
 * The Node implementation of the shared review digest (`ReviewDigestFn`), injected by
 * whichever tier owns bytes.
 *
 * The shared review model names the algorithm and validates the shape of a digest but
 * never computes one, so that it stays importable without a hashing runtime. This is the
 * one place the Node implementation is supplied, and it is injected rather than reached
 * for — which is what lets a test drive the producer with a deterministic stand-in and a
 * browser bundle supply Web Crypto's instead.
 */
import { createHash } from "node:crypto";
import { REVIEW_DIGEST_ALGORITHM, type ReviewDigestFn } from "./review/validation";

/** Digest bytes with Node's implementation of the shared algorithm, in canonical form. */
export const nodeReviewDigest: ReviewDigestFn = (bytes) =>
  createHash(REVIEW_DIGEST_ALGORITHM).update(bytes).digest("hex");
