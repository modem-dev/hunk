/**
 * The daemon's bounded store of review resource bytes.
 *
 * The daemon brokers resources it does not own: a session publishes a generation, and the
 * daemon reads slices of that generation's resources on behalf of agents (and later a
 * browser). Two things have to be true for that to be safe with many sessions attached.
 *
 * - **What is held is bounded.** Completed bytes live in one daemon-wide LRU with a byte
 *   budget, and are evicted whole-resource-at-a-time when it is exceeded. Bytes belonging
 *   to a retired generation or a departed session are dropped immediately rather than
 *   waiting to age out — they can never be asked for again.
 * - **What is *being* read is bounded too.** A reservation is taken before a load starts
 *   and released when it settles, so concurrent assemblies cannot collectively allocate
 *   more than the in-flight budget however many callers arrive at once. The prototype
 *   bounded only the completed side and let assemblies pile up
 *   (`docs/browser-review-seam-audit.md`, C2).
 *
 * The cache stores and bounds; it never fetches, never verifies, and never decides what a
 * resource is — the load loop assembles and verifies through the shared
 * `ReviewChunkAssembler`, and hands the finished bytes here.
 */

/** How many resource bytes the daemon retains across every session. */
export const MAX_REVIEW_DAEMON_CACHE_BYTES = 64 * 1024 * 1024;

/** How many resource bytes may be under assembly at one moment, across every session. */
export const MAX_REVIEW_DAEMON_INFLIGHT_BYTES = 32 * 1024 * 1024;

/** How many assemblies may run at one moment, whatever their declared sizes. */
export const MAX_REVIEW_DAEMON_INFLIGHT_RESOURCES = 8;

export interface ReviewResourceCacheLimits {
  cacheBytes: number;
  inFlightBytes: number;
  inFlightResources: number;
}

/** One resource's place in the cache: which session, which generation, which resource. */
export interface ReviewResourceKey {
  sessionId: string;
  generation: string;
  resourceId: string;
}

/** One accepted in-flight reservation, released exactly once by the loader that took it. */
export interface ReviewResourceReservation extends ReviewResourceKey {
  /** Bytes currently committed to this load; raised once the writer declares the real size. */
  byteLength: number;
}

/** Raised when a load cannot start because the daemon's in-flight budget is full. */
export class ReviewResourceBudgetError extends Error {
  override readonly name = "ReviewResourceBudgetError";
}

interface CacheEntry {
  key: ReviewResourceKey;
  bytes: Uint8Array;
}

/** Build one map key that cannot collide between two sessions or two generations. */
function cacheKey({ sessionId, generation, resourceId }: ReviewResourceKey) {
  return JSON.stringify([sessionId, generation, resourceId]);
}

export class ReviewResourceCache {
  private readonly limits: ReviewResourceCacheLimits;
  /** Completed bytes in least-recently-used order, which is plain insertion order here. */
  private readonly entries = new Map<string, CacheEntry>();
  private readonly reservations = new Map<string, ReviewResourceReservation>();
  private cachedBytes = 0;
  private reservedBytes = 0;

  constructor(limits: Partial<ReviewResourceCacheLimits> = {}) {
    this.limits = {
      cacheBytes: limits.cacheBytes ?? MAX_REVIEW_DAEMON_CACHE_BYTES,
      inFlightBytes: limits.inFlightBytes ?? MAX_REVIEW_DAEMON_INFLIGHT_BYTES,
      inFlightResources: limits.inFlightResources ?? MAX_REVIEW_DAEMON_INFLIGHT_RESOURCES,
    };
  }

  /** Return one completed resource, promoting it to the young end of the eviction order. */
  get(key: ReviewResourceKey): Uint8Array | undefined {
    const mapKey = cacheKey(key);
    const entry = this.entries.get(mapKey);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(mapKey);
    this.entries.set(mapKey, entry);
    return entry.bytes;
  }

  /**
   * Take one in-flight slot before a load starts.
   *
   * `byteLength` is what the assembly is expected to hold: a measured descriptor's exact
   * size, or one chunk when the producer has not measured it yet and `resize` will settle
   * it. Refusing here is what keeps a burst of readers from committing the daemon to
   * memory it does not have; a refused caller retries rather than being served a partial
   * resource.
   */
  reserve(key: ReviewResourceKey, byteLength: number): ReviewResourceReservation {
    const mapKey = cacheKey(key);
    if (this.reservations.has(mapKey)) {
      throw new ReviewResourceBudgetError(
        `Review resource ${key.resourceId} is already being loaded.`,
      );
    }
    if (this.reservations.size >= this.limits.inFlightResources) {
      throw new ReviewResourceBudgetError(
        `The daemon is already assembling ${this.limits.inFlightResources} review resources.`,
      );
    }
    if (byteLength > this.limits.inFlightBytes) {
      throw new ReviewResourceBudgetError(
        `Review resource ${key.resourceId} declares ${byteLength} bytes, over the daemon's in-flight budget.`,
      );
    }
    if (this.reservedBytes + byteLength > this.limits.inFlightBytes) {
      throw new ReviewResourceBudgetError(
        "Review resource loads already fill the daemon's in-flight budget.",
      );
    }

    const reservation: ReviewResourceReservation = { ...key, byteLength };
    this.reservations.set(mapKey, reservation);
    this.reservedBytes += byteLength;
    return reservation;
  }

  /**
   * Adjust one reservation to the size the writer turned out to declare.
   *
   * A read against a descriptor the producer has not measured yet starts by reserving one
   * chunk, because reserving the kind's ceiling instead would let a handful of ordinary
   * patches exhaust the whole budget — which is how the prototype ended up serializing
   * loads it meant to run in parallel. The real size arrives with the first chunk, and is
   * held to the same budget as an exact reservation would have been.
   */
  resize(reservation: ReviewResourceReservation, byteLength: number) {
    const mapKey = cacheKey(reservation);
    if (this.reservations.get(mapKey) !== reservation) {
      return;
    }
    const delta = byteLength - reservation.byteLength;
    if (this.reservedBytes + delta > this.limits.inFlightBytes) {
      throw new ReviewResourceBudgetError(
        `Review resource ${reservation.resourceId} declares ${byteLength} bytes, over the daemon's remaining in-flight budget.`,
      );
    }
    this.reservedBytes += delta;
    reservation.byteLength = byteLength;
  }

  /** Give one in-flight slot back, whether the load succeeded or failed. */
  release(reservation: ReviewResourceReservation) {
    const mapKey = cacheKey(reservation);
    if (this.reservations.get(mapKey) !== reservation) {
      return;
    }
    this.reservations.delete(mapKey);
    this.reservedBytes -= reservation.byteLength;
  }

  /**
   * Admit one verified resource, evicting the oldest until the budget fits.
   *
   * The resource just admitted is never the one evicted: a caller that asked for it is
   * about to use it, and dropping it to make room for itself would guarantee a re-read.
   */
  store(key: ReviewResourceKey, bytes: Uint8Array) {
    const mapKey = cacheKey(key);
    const existing = this.entries.get(mapKey);
    if (existing) {
      this.cachedBytes -= existing.bytes.byteLength;
      this.entries.delete(mapKey);
    }
    this.entries.set(mapKey, { key, bytes });
    this.cachedBytes += bytes.byteLength;

    for (const [oldestKey, oldest] of this.entries) {
      if (this.cachedBytes <= this.limits.cacheBytes || oldestKey === mapKey) {
        break;
      }
      this.entries.delete(oldestKey);
      this.cachedBytes -= oldest.bytes.byteLength;
    }
  }

  /** Drop everything belonging to one retired generation; nothing can ask for it again. */
  evictGeneration(sessionId: string, generation: string) {
    this.evictWhere((key) => key.sessionId === sessionId && key.generation === generation);
  }

  /** Drop everything belonging to one session that is no longer connected. */
  evictSession(sessionId: string) {
    this.evictWhere((key) => key.sessionId === sessionId);
  }

  /** Drop everything, as the daemon shuts down. */
  clear() {
    this.entries.clear();
    this.reservations.clear();
    this.cachedBytes = 0;
    this.reservedBytes = 0;
  }

  /** Bytes currently retained, for lifecycle assertions. */
  getCachedBytes() {
    return this.cachedBytes;
  }

  /** Bytes currently reserved by in-flight loads, for lifecycle assertions. */
  getReservedBytes() {
    return this.reservedBytes;
  }

  /** Completed resources currently retained, for lifecycle assertions. */
  getEntryCount() {
    return this.entries.size;
  }

  /**
   * Forget every completed entry and reservation matching one predicate.
   *
   * Reservations are dropped along with entries so a retired generation stops occupying
   * the in-flight budget; the load that owned one still calls `release`, which is a no-op
   * once the reservation is gone.
   */
  private evictWhere(matches: (key: ReviewResourceKey) => boolean) {
    for (const [mapKey, entry] of this.entries) {
      if (matches(entry.key)) {
        this.entries.delete(mapKey);
        this.cachedBytes -= entry.bytes.byteLength;
      }
    }
    for (const [mapKey, reservation] of this.reservations) {
      if (matches(reservation)) {
        this.reservations.delete(mapKey);
        this.reservedBytes -= reservation.byteLength;
      }
    }
  }
}
