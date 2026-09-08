/**
 * How every review boundary checks what it was handed.
 *
 * Three primitives that the prototype re-declared at roughly twenty sites, with the drift
 * that implies: byte measurement done in two units, digest patterns whose case sensitivity
 * disagreed between the writer and the reader, and an exact-key check inlined once per
 * parsed shape (`docs/browser-review-seam-audit.md`, D1/D5). They live here, in the shared
 * model, because the producer, the wire protocol, and later a browser client must all
 * agree — and because none of them may reach for a platform encoder or a hashing runtime
 * to answer these questions.
 *
 * Hashing itself is *not* here: computing a SHA-256 needs a platform primitive, so it
 * arrives as an injected `ReviewDigestFn` from whichever tier owns bytes. Core only names
 * the algorithm, validates the shape, and compares two values.
 */

/**
 * Number of UTF-8 bytes one string encodes to.
 *
 * Computed from code units rather than through `TextEncoder`, so measurement never
 * depends on a platform global and always answers the same for the same string. Lone
 * surrogates count as the three bytes their replacement character encodes to, which is
 * what any conforming encoder would actually emit.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Narrows one untrusted value to a plain object, or undefined when it is not one.
 *
 * Arrays and `null` are excluded because both pass a bare `typeof value === "object"`, and
 * a parser that accepted either would then read named keys off a value that has none.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Whether one parsed record carries exactly the allowed keys — none missing, none extra.
 *
 * The one strictness rule for untrusted input crossing a review boundary. Rejecting extra
 * keys is what keeps a field added on one side from being silently ignored on the other.
 */
export function hasExactKeys(record: Record<string, unknown>, allowed: readonly string[]) {
  const keys = Object.keys(record);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

/** The one content-integrity digest algorithm every review resource is addressed by. */
export const REVIEW_DIGEST_ALGORITHM = "sha256" as const;

/**
 * A platform's content digest, injected rather than imported.
 *
 * Implementations must return the canonical lowercase hex form. The producer supplies
 * Node's, and a browser bundle would supply Web Crypto's; the shared model never carries
 * either.
 */
export type ReviewDigestFn = (bytes: Uint8Array) => string;

/** Canonical digest form: lowercase hex, exactly the algorithm's output width. */
const REVIEW_SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Whether one value is a digest in canonical form.
 *
 * Case-sensitive: there is one canonical spelling, and accepting both spellings is how a
 * writer and a reader come to disagree about whether two digests matched. Anything from
 * outside is normalized on the way in rather than validated leniently.
 */
export function isReviewSha256Digest(value: unknown): value is string {
  return typeof value === "string" && REVIEW_SHA256_DIGEST_PATTERN.test(value);
}

/** Compare two digests with both operands normalized, never just one. */
export function reviewDigestsEqual(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}
