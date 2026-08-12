import type { BrowserReviewSnapshot } from "./reviewTypes";

export type ReviewMirrorEvent =
  | { type: "snapshot" | "document"; data: BrowserReviewSnapshot }
  | { type: "state"; data: { generation: string; state: BrowserReviewSnapshot["state"] } }
  | { type: "disconnect"; data: unknown };

export interface ReviewMirrorResult {
  kind: "accepted" | "stale" | "gap" | "disconnect";
  snapshot?: BrowserReviewSnapshot;
}

/** Enforce generation replacement and monotonic state-revision ordering. */
export class ReviewSnapshotMirror {
  private current?: BrowserReviewSnapshot;
  private readonly retiredGenerations = new Set<string>();

  getSnapshot() {
    return this.current;
  }

  apply(event: ReviewMirrorEvent): ReviewMirrorResult {
    if (event.type === "disconnect") return { kind: "disconnect", snapshot: this.current };
    if (event.type === "state") return this.applyState(event.data);
    return this.applyComplete(event.data);
  }

  private applyComplete(snapshot: BrowserReviewSnapshot): ReviewMirrorResult {
    if (
      snapshot.generation !== snapshot.manifest.generation ||
      snapshot.generation !== snapshot.state.documentGeneration
    ) {
      return { kind: "stale", snapshot: this.current };
    }
    const previous = this.current;
    if (this.retiredGenerations.has(snapshot.generation)) {
      return { kind: "stale", snapshot: previous };
    }
    if (previous?.generation === snapshot.generation) {
      if (snapshot.state.stateRevision <= previous.state.stateRevision) {
        return { kind: "stale", snapshot: previous };
      }
    } else if (previous) {
      this.retiredGenerations.add(previous.generation);
    }
    this.current = snapshot;
    return { kind: "accepted", snapshot };
  }

  private applyState(
    data: Extract<ReviewMirrorEvent, { type: "state" }>["data"],
  ): ReviewMirrorResult {
    const previous = this.current;
    if (!previous) return { kind: "gap" };
    if (
      data.generation !== previous.generation ||
      data.state.documentGeneration !== previous.generation
    ) {
      return this.retiredGenerations.has(data.generation)
        ? { kind: "stale", snapshot: previous }
        : { kind: "gap", snapshot: previous };
    }
    if (data.state.stateRevision <= previous.state.stateRevision) {
      return { kind: "stale", snapshot: previous };
    }
    if (data.state.stateRevision !== previous.state.stateRevision + 1) {
      return { kind: "gap", snapshot: previous };
    }
    this.current = { ...previous, state: data.state };
    return { kind: "accepted", snapshot: this.current };
  }
}

interface ChunkBegin {
  id: string;
  encoding: "base64";
  byteLength: number;
  chunkCount: number;
  digest: string;
}

interface PendingChunks extends ChunkBegin {
  type: "snapshot" | "document" | "state" | "disconnect";
  chunks: Array<string | undefined>;
}

const MAX_CHUNKED_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const MAX_CHUNKS = 1_024;

/** Reconstruct one complete, digest-checked semantic event from SSE chunk frames. */
export class ReviewSseChunks {
  private readonly pending = new Map<string, PendingChunks>();

  constructor(
    private readonly emit: (event: ReviewMirrorEvent) => void | Promise<void>,
    private readonly recover: () => void | Promise<void> = () => {},
  ) {}

  async accept(type: string, data: unknown) {
    const suffix = type.match(/^(snapshot|document|state|disconnect)-(begin|chunk|end)$/);
    if (!suffix) {
      if (type === "snapshot" || type === "document" || type === "state" || type === "disconnect") {
        await this.emit({ type, data } as ReviewMirrorEvent);
      }
      return;
    }
    const semanticType = suffix[1] as PendingChunks["type"];
    const phase = suffix[2]!;
    const record = asRecord(data);
    const id = typeof record?.id === "string" ? record.id : "";
    if (!id) {
      await this.recover();
      return;
    }

    if (phase === "begin") {
      const byteLength = integer(record?.byteLength);
      const chunkCount = integer(record?.chunkCount);
      const digest = typeof record?.digest === "string" ? record.digest : "";
      if (
        record?.encoding !== "base64" ||
        byteLength === null ||
        byteLength > MAX_CHUNKED_SNAPSHOT_BYTES ||
        chunkCount === null ||
        chunkCount < 1 ||
        chunkCount > MAX_CHUNKS ||
        !/^[a-f\d]{64}$/i.test(digest)
      ) {
        await this.recover();
        return;
      }
      while (this.pending.size >= 4) this.pending.delete(this.pending.keys().next().value!);
      this.pending.set(id, {
        id,
        type: semanticType,
        encoding: "base64",
        byteLength,
        chunkCount,
        digest,
        chunks: Array.from({ length: chunkCount }),
      });
      return;
    }

    const pending = this.pending.get(id);
    if (!pending || pending.type !== semanticType) {
      await this.recover();
      return;
    }
    if (phase === "chunk") {
      const index = integer(record?.index);
      if (index !== null && index < pending.chunkCount && typeof record?.data === "string") {
        pending.chunks[index] = record.data;
      } else {
        this.pending.delete(id);
        await this.recover();
      }
      return;
    }

    this.pending.delete(id);
    if (
      integer(record?.byteLength) !== pending.byteLength ||
      integer(record?.chunkCount) !== pending.chunkCount ||
      record?.digest !== pending.digest ||
      pending.chunks.some((chunk) => chunk === undefined)
    ) {
      await this.recover();
      return;
    }
    const bytes = decodeBase64Chunks(pending.chunks as string[]);
    if (
      bytes.byteLength !== pending.byteLength ||
      (await sha256(bytes)).toLowerCase() !== pending.digest.toLowerCase()
    ) {
      await this.recover();
      return;
    }
    try {
      await this.emit({
        type: semanticType,
        data: JSON.parse(new TextDecoder().decode(bytes)),
      } as ReviewMirrorEvent);
    } catch {
      await this.recover();
    }
  }
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** Hash bytes in browsers where plain-HTTP tailnet origins lack Web Crypto secure-context APIs. */
export function softwareSha256(bytes: Uint8Array) {
  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.byteLength] = 0x80;
  const bitLength = bytes.byteLength * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const before15 = schedule[index - 15]!;
      const before2 = schedule[index - 2]!;
      const sigma0 = rotateRight(before15, 7) ^ rotateRight(before15, 18) ^ (before15 >>> 3);
      const sigma1 = rotateRight(before2, 17) ^ rotateRight(before2, 19) ^ (before2 >>> 10);
      schedule[index] = (schedule[index - 16]! + sigma0 + schedule[index - 7]! + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temporary1 = (h! + sum1 + choice + SHA256_CONSTANTS[index]! + schedule[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    for (let index = 0; index < hash.length; index += 1) {
      hash[index] = (hash[index]! + [a, b, c, d, e, f, g, h][index]!) >>> 0;
    }
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

/** Compute SHA-256 with Web Crypto when available and a deterministic tailnet-safe fallback. */
export async function sha256(bytes: Uint8Array) {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      bytes.slice().buffer as ArrayBuffer,
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  return softwareSha256(bytes);
}

function decodeBase64Chunks(chunks: string[]) {
  const byteChunks = chunks.map((chunk) => {
    const binary = atob(chunk);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  });
  const result = new Uint8Array(byteChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of byteChunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}
