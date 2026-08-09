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

/** Compute a browser-native SHA-256 digest without importing a Node implementation. */
export async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
