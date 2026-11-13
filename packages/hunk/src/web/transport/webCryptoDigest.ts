/**
 * Hashes review bytes with the browser's Web Crypto, as the shared assemblers' async digest.
 *
 * The page is served from a loopback origin, which browsers treat as a secure context, so
 * `crypto.subtle` is always present. The result is the canonical lowercase hex form
 * `isReviewSha256Digest` accepts.
 */
import type { ReviewAsyncDigestFn } from "../../core/review/validation";

/** Hex SHA-256 of one byte array. */
export const webCryptoReviewDigest: ReviewAsyncDigestFn = async (bytes) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  let hex = "";
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
};

/** Decode one base64 string, as a chunk's `data` field carries it. */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
