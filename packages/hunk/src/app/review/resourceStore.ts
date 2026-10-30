/**
 * Materializing and serving one generation's resources.
 *
 * Three rules shape this module:
 *
 * - **Single flight per resource.** A resource is produced at most once per generation,
 *   and concurrent readers share that one production. It is not a cache bolted on top: a
 *   read has no path to the underlying reader except through the in-flight map, so a
 *   double read is not something a caller can cause.
 * - **Bounded parallelism.** Loading many resources runs through an explicit concurrency
 *   limit rather than an unbounded `Promise.all`, so reconstructing every patch in a large
 *   review cannot open one file handle per file at once.
 * - **Distinct failures.** Every way a read can fail has its own code, and bytes that
 *   disagree with the digest they were measured under report `resource-integrity` — never
 *   `unknown-resource`, which would present corruption as a routine miss
 *   (`docs/browser-review-seam-audit.md`, C2).
 *
 * The store belongs to one publication, so a new generation starts with nothing cached and
 * the previous generation's bytes become collectable as soon as it is retired.
 */
import { SourceTextTooLargeError } from "../../core/changeset/fileSource";
import {
  isMaterializedReviewResource,
  isReviewResourceRange,
  REVIEW_RESOURCE_LOAD_CONCURRENCY,
  reviewResourceCeiling,
  reviewResourceFailure,
  type ReviewResourceChunkV1,
  type ReviewResourceDescriptorV1,
  type ReviewResourceFailure,
  type ReviewResourceRange,
} from "../../core/review/resources";
import { reviewDigestsEqual, type ReviewDigestFn } from "../../core/review/validation";
import { assertCanonicalFileMatchesManifest } from "../../core/review/canonicalFile";
import { buildReviewContentManifestFile } from "../../core/review/contentManifest";
import type { ReviewFileV1 } from "../../core/review/types";
import {
  reviewPublicationFile,
  reviewPublicationResource,
  type ReviewPublication,
} from "./publication";

/** How many materialized bytes one generation retains before evicting its oldest. */
export const MAX_REVIEW_PRODUCER_RESOURCE_BYTES = 64 * 1024 * 1024;

export interface MaterializedReviewResource {
  bytes: Uint8Array;
  byteLength: number;
  digest: string;
}

export type { ReviewResourceFailure };

export type ReviewResourceLoad =
  | { ok: true; resource: MaterializedReviewResource }
  | ReviewResourceFailure;

export type ReviewResourceRead = { ok: true; chunk: ReviewResourceChunkV1 } | ReviewResourceFailure;

/**
 * Serialize one canonical file, self-checking it against the manifest first.
 *
 * The check runs where the bytes are produced rather than where they are read, so a
 * projection that lost or reordered content fails here instead of surfacing as a reader's
 * unexplained mismatch.
 */
function encodeCanonicalFile(file: ReviewFileV1) {
  assertCanonicalFileMatchesManifest(file, buildReviewContentManifestFile(file));
  return JSON.stringify(file);
}

export interface ReviewResourceStoreOptions {
  publication: ReviewPublication;
  digest: ReviewDigestFn;
  concurrency?: number;
  maxCacheBytes?: number;
}

export class ReviewResourceStore {
  private readonly publication: ReviewPublication;
  private readonly digest: ReviewDigestFn;
  private readonly concurrency: number;
  private readonly maxCacheBytes: number;
  /** Settled bytes, oldest first, so eviction is a plain iteration order. */
  private readonly materialized = new Map<string, MaterializedReviewResource>();
  /** One production per resource id; concurrent readers await this exact promise. */
  private readonly inFlight = new Map<string, Promise<ReviewResourceLoad>>();
  private cachedBytes = 0;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor({
    publication,
    digest,
    concurrency = REVIEW_RESOURCE_LOAD_CONCURRENCY,
    maxCacheBytes = MAX_REVIEW_PRODUCER_RESOURCE_BYTES,
  }: ReviewResourceStoreOptions) {
    this.publication = publication;
    this.digest = digest;
    this.concurrency = Math.max(1, concurrency);
    this.maxCacheBytes = maxCacheBytes;
  }

  /**
   * Describe one resource, including its measurements once it has been materialized.
   *
   * A descriptor starts unmeasured because measuring means producing the bytes; a reader
   * that has already asked for a chunk sees the length and digest it can verify against.
   */
  describe(resourceId: string): ReviewResourceDescriptorV1 | undefined {
    const descriptor = reviewPublicationResource(this.publication, resourceId);
    const measured = descriptor && this.materialized.get(resourceId);
    return measured
      ? { ...descriptor!, byteLength: measured.byteLength, digest: measured.digest }
      : descriptor;
  }

  /** Every descriptor in this generation, measured where it has been produced. */
  describeAll(): ReviewResourceDescriptorV1[] {
    return this.publication.resources.map((resource) => this.describe(resource.id) ?? resource);
  }

  /**
   * Produce one resource, or return the single production already under way.
   *
   * Settled bytes are returned directly; failures are not retained, because an unreadable
   * source may become readable and a permanently poisoned entry would be worse than a
   * second attempt.
   */
  materialize(resourceId: string): Promise<ReviewResourceLoad> {
    const settled = this.materialized.get(resourceId);
    if (settled) {
      this.touch(resourceId, settled);
      return Promise.resolve({ ok: true, resource: settled });
    }
    const running = this.inFlight.get(resourceId);
    if (running) {
      return running;
    }

    const production = this.produce(resourceId)
      .then((load) => {
        if (load.ok) {
          this.retain(resourceId, load.resource);
        }
        return load;
      })
      .finally(() => {
        this.inFlight.delete(resourceId);
      });
    this.inFlight.set(resourceId, production);
    return production;
  }

  /**
   * Produce several resources under the store's concurrency limit.
   *
   * Duplicate ids collapse onto one production by construction, so a caller may pass the
   * whole review's worth of patch ids without deduplicating first.
   */
  async materializeAll(resourceIds: readonly string[]): Promise<Map<string, ReviewResourceLoad>> {
    const results = new Map<string, ReviewResourceLoad>();
    await Promise.all(
      [...new Set(resourceIds)].map(async (resourceId) => {
        await this.acquire();
        try {
          results.set(resourceId, await this.materialize(resourceId));
        } finally {
          this.release();
        }
      }),
    );
    return results;
  }

  /** Read one verified byte window of a resource. */
  async readChunk(resourceId: string, range: ReviewResourceRange): Promise<ReviewResourceRead> {
    if (!isReviewResourceRange(range)) {
      return reviewResourceFailure(
        "invalid-range",
        `Resource reads take a non-negative offset and a length within the shared chunk bound.`,
      );
    }

    const load = await this.materialize(resourceId);
    if (!load.ok) {
      return load;
    }

    const { bytes, byteLength, digest } = load.resource;
    if (range.offset > byteLength) {
      return reviewResourceFailure(
        "invalid-range",
        `Resource ${resourceId} has ${byteLength} bytes; offset ${range.offset} is past its end.`,
      );
    }
    const end = Math.min(byteLength, range.offset + range.length);
    const chunk = bytes.subarray(range.offset, end);
    return {
      ok: true,
      chunk: {
        generation: this.publication.generation,
        resourceId,
        offset: range.offset,
        byteLength: chunk.byteLength,
        encoding: "base64",
        data: Buffer.from(chunk).toString("base64"),
        contentDigest: digest,
        contentSize: byteLength,
        eof: end === byteLength,
      },
    };
  }

  /** Produce one resource's bytes from whatever backs its kind. */
  private async produce(resourceId: string): Promise<ReviewResourceLoad> {
    const descriptor = reviewPublicationResource(this.publication, resourceId);
    if (!descriptor) {
      return reviewResourceFailure(
        "unknown-resource",
        `Review resource ${resourceId} is not part of generation ${this.publication.generation}.`,
      );
    }
    const file = reviewPublicationFile(this.publication, descriptor.fileKey);
    if (!file) {
      return reviewResourceFailure(
        "unknown-resource",
        `Review resource ${resourceId} names a file this generation does not have.`,
      );
    }

    if (descriptor.kind === "source") {
      return this.produceSource(descriptor, file);
    }
    const text = descriptor.kind === "canonical-file" ? encodeCanonicalFile(file) : file.patch;
    return this.measure(descriptor, Buffer.from(text, "utf8"));
  }

  /** Read one file's full source text through the reader the loader attached to it. */
  private async produceSource(
    descriptor: Extract<ReviewResourceDescriptorV1, { kind: "source" }>,
    file: ReviewFileV1,
  ): Promise<ReviewResourceLoad> {
    const fetcher = this.publication.diffFilesByKey.get(descriptor.fileKey)?.sourceFetcher;
    if (!fetcher) {
      return reviewResourceFailure(
        "resource-unavailable",
        `Review file ${file.path} has no source reader in this generation.`,
      );
    }

    let text: string | null;
    try {
      text = await fetcher.getFullText(descriptor.side);
    } catch (error) {
      // A reader that refused because the file is enormous is a different answer than a
      // reader that failed, and a caller offering to expand context needs to tell them
      // apart.
      return error instanceof SourceTextTooLargeError
        ? reviewResourceFailure(
            "resource-too-large",
            `Source for ${file.path} exceeds the readable limit.`,
          )
        : reviewResourceFailure(
            "resource-unavailable",
            `Could not read ${descriptor.side} source for ${file.path}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
    }
    if (text === null) {
      return reviewResourceFailure(
        "resource-unavailable",
        `Review file ${file.path} has no ${descriptor.side} source to read.`,
      );
    }

    // Reported against the path rather than the resource id, because a reviewer asking to
    // expand context needs to know which file refused before the generic measure does.
    const ceiling = reviewResourceCeiling(descriptor.kind);
    const bytes = Buffer.from(text, "utf8");
    return bytes.byteLength > ceiling
      ? reviewResourceFailure(
          "resource-too-large",
          `Source for ${file.path} is ${bytes.byteLength} bytes, over the ${ceiling}-byte source limit.`,
        )
      : this.measure(descriptor, bytes);
  }

  /**
   * Measure produced bytes and verify them against anything already declared.
   *
   * A descriptor that already carries a length and digest — a generation whose
   * measurements were published before the bytes were read again — must still agree with
   * what was produced, and disagreeing is an integrity failure rather than a miss.
   */
  private measure(descriptor: ReviewResourceDescriptorV1, bytes: Buffer): ReviewResourceLoad {
    const ceiling = reviewResourceCeiling(descriptor.kind);
    if (bytes.byteLength > ceiling) {
      return reviewResourceFailure(
        "resource-too-large",
        `Review resource ${descriptor.id} is ${bytes.byteLength} bytes, over the ${ceiling}-byte resource limit.`,
      );
    }
    const digest = this.digest(bytes);
    if (
      isMaterializedReviewResource(descriptor) &&
      (descriptor.byteLength !== bytes.byteLength ||
        !reviewDigestsEqual(descriptor.digest!, digest))
    ) {
      return reviewResourceFailure(
        "resource-integrity",
        `Review resource ${descriptor.id} does not match the length and digest it was published with.`,
      );
    }
    return { ok: true, resource: { bytes, byteLength: bytes.byteLength, digest } };
  }

  /** Record one produced resource, evicting the oldest until the budget fits. */
  private retain(resourceId: string, resource: MaterializedReviewResource) {
    this.materialized.set(resourceId, resource);
    this.cachedBytes += resource.byteLength;
    for (const [oldestId, oldest] of this.materialized) {
      if (this.cachedBytes <= this.maxCacheBytes || oldestId === resourceId) {
        break;
      }
      this.materialized.delete(oldestId);
      this.cachedBytes -= oldest.byteLength;
    }
  }

  /** Move one retained resource to the young end of the eviction order. */
  private touch(resourceId: string, resource: MaterializedReviewResource) {
    this.materialized.delete(resourceId);
    this.materialized.set(resourceId, resource);
  }

  /** Take one of the concurrency limit's slots, waiting when they are all in use. */
  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  /** Give one slot back to the next waiting load. */
  private release() {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}
