/**
 * SHA-256 for the browser review client, computed synchronously.
 *
 * The shared chunk assembler verifies a resource with an injected `ReviewDigestFn`
 * (`src/core/review/validation.ts`), which is synchronous because verification happens
 * inline as chunks arrive — a reader that had to await a hash could accept a chunk it has
 * not yet checked. The platform hash a browser is handed, `crypto.subtle.digest`, is
 * async-only, so the browser tier brings its own implementation rather than reshaping the
 * seam around one runtime's API.
 *
 * That is why this file is here and not in `src/core/review/`: the audit lists platform
 * hashing (`node:crypto` versus Web Crypto) among the things deliberately *not* unified
 * (`docs/browser-review-seam-audit.md`, § A). The session's edge does the same thing on the
 * other side in `src/lib/reviewDigest.ts`, and `reviewDigest.test.ts` holds this one to
 * that implementation's output.
 *
 * It is used for integrity, never for secrecy: nothing here hashes a capability, and the
 * capability the client holds is presented as-is over a loopback connection.
 */
import type { ReviewDigestFn } from "../core/review/validation";

/** The first thirty-two bits of the fractional parts of the cube roots of the first primes. */
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The first thirty-two bits of the fractional parts of the square roots of the first primes. */
const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const BLOCK_BYTES = 64;
const ROUNDS = 64;

/** Rotate one 32-bit word right, which is the only operation this hash needs beyond adds. */
function rotateRight(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits));
}

/** Hash one message into eight 32-bit words of state. */
function sha256State(message: Uint8Array) {
  // One padded copy: the message, a 0x80 terminator, zeroes, and a 64-bit big-endian bit
  // length, rounded up to whole blocks.
  // Exactly the minimum: padding longer than the standard's is a different message.
  const paddedLength = Math.ceil((message.byteLength + 9) / BLOCK_BYTES) * BLOCK_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.byteLength] = 0x80;

  const bitLength = message.byteLength * 8;
  const view = new DataView(padded.buffer);
  // Written as two 32-bit halves because a JavaScript number cannot hold the whole 64-bit
  // length exactly; the high half is the byte count's top bits.
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = new Uint32Array(INITIAL_STATE);
  const schedule = new Uint32Array(ROUNDS);

  for (let offset = 0; offset < paddedLength; offset += BLOCK_BYTES) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < ROUNDS; index += 1) {
      const previous = schedule[index - 15]!;
      const recent = schedule[index - 2]!;
      const s0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const s1 = rotateRight(recent, 17) ^ rotateRight(recent, 19) ^ (recent >>> 10);
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state as unknown as number[];
    for (let index = 0; index < ROUNDS; index += 1) {
      const s1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + s1 + choice + ROUND_CONSTANTS[index]! + schedule[index]!) >>> 0;
      const s0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (s0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    const round = [a!, b!, c!, d!, e!, f!, g!, h!];
    for (let index = 0; index < state.length; index += 1) {
      state[index] = (state[index]! + round[index]!) >>> 0;
    }
  }

  return state;
}

/**
 * Hash one byte array to the canonical lowercase hex digest the review model compares.
 *
 * Lowercase without exception: `isReviewSha256Digest` accepts only that form, because a
 * case-insensitive comparison is what let a writer and a reader disagree about whether two
 * digests matched (`docs/browser-review-seam-audit.md`, D5).
 */
export const browserReviewDigest: ReviewDigestFn = (bytes: Uint8Array) => {
  const state = sha256State(bytes);
  let hex = "";
  for (const word of state) {
    hex += word.toString(16).padStart(8, "0");
  }
  return hex;
};
