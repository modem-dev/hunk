/** Encode bytes without padding for wire-safe identifiers and signatures. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decode a base64url value, rejecting non-canonical spellings. */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  if (value.length === 0) return new Uint8Array();
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export interface SessionBrokerCrypto {
  randomBytes(length: number): Uint8Array;
  sha256(value: Uint8Array): Promise<Uint8Array>;
  sign(privateKey: CryptoKey, value: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: CryptoKey, signature: Uint8Array, value: Uint8Array): Promise<boolean>;
}

/** Use the runtime WebCrypto implementation for Ed25519 proof-of-possession and SHA-256. */
export const webSessionBrokerCrypto: SessionBrokerCrypto = {
  randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  },
  async sha256(value) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", asArrayBuffer(value)));
  },
  async sign(privateKey, value) {
    return new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, asArrayBuffer(value)));
  },
  async verify(publicKey, signature, value) {
    return crypto.subtle.verify(
      "Ed25519",
      publicKey,
      asArrayBuffer(signature),
      asArrayBuffer(value),
    );
  },
};

/** Import an Ed25519 SubjectPublicKeyInfo verifier without exposing private material. */
export function importEd25519PublicKey(spki: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", asArrayBuffer(spki), "Ed25519", false, ["verify"]);
}

/** Import an Ed25519 PKCS#8 signer into non-extractable runtime memory. */
export function importEd25519PrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", asArrayBuffer(pkcs8), "Ed25519", false, ["sign"]);
}
