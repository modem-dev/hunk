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
 *   (`docs/browser-review-seam-audit.md`, C2). Each session holds at most half of that
 *   budget, so one session's reader cannot starve every other session's reads.
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

/**
 * How many assemblies one session may hold at once: half the daemon's, so a capability holder
 * hammering one session's reads always leaves the other half for every other session.
 */
export const MAX_REVIEW_SESSION_INFLIGHT_RESOURCES = MAX_REVIEW_DAEMON_INFLIGHT_RESOURCES / 2;

/**
 * How many in-flight bytes one session may hold at once, alongside other loads of its own.
 *
 * Half the daemon's budget. A single load may still take more when it is the session's only
 * one, because one resource can legitimately be as large as the whole budget
 * (`MAX_REVIEW_RESOURCE_BYTES`); what the share stops is many concurrent loads from one session.
 */
export const MAX_REVIEW_SESSION_INFLIGHT_BYTES = MAX_REVIEW_DAEMON_INFLIGHT_BYTES / 2;

export interface ReviewResourceCacheLimits {
  cacheBytes: number;
  inFlightBytes: number;
  inFlightResources: number;
  sessionInFlightBytes: number;
  sessionInFlightResources: number;
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

  /**
   * @param retryable True when the budget is merely occupied right now (a slot or bytes will
   * free up as other loads settle); false when this load could never fit.
   * @param scope What is occupied: the daemon-wide budget every session shares, this
   * session's own share of it, or this one resource's key (an earlier load of it is running).
   */
  constructor(
    message: string,
    readonly retryable = false,
    readonly scope: "daemon" | "session" | "resource" = "daemon",
  ) {
    super(message);
  }
}

/** Raised to a reservation waiter whose caller gave up before a slot freed. */
export class ReviewResourceWaitAbortedError extends Error {
  override readonly name = "ReviewResourceWaitAbortedError";

  constructor() {
    super("The review resource read was abandoned before it started.");
  }
}

/** One load waiting for an in-flight slot, in arrival order. */
interface ReservationWaiter {
  key: ReviewResourceKey;
  byteLength: number;
  lastError: ReviewResourceBudgetError;
  resolve: (reservation: ReviewResourceReservation) => void;
  reject: (error: Error) => void;
  /** Detach the waiter's timer and abort listener. */
  dispose: () => void;
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
  /** Loads waiting for a slot, oldest first; woken whenever a reservation goes away. */
  private readonly waiters: ReservationWaiter[] = [];

  constructor(limits: Partial<ReviewResourceCacheLimits> = {}) {
    this.limits = {
      cacheBytes: limits.cacheBytes ?? MAX_REVIEW_DAEMON_CACHE_BYTES,
      inFlightBytes: limits.inFlightBytes ?? MAX_REVIEW_DAEMON_INFLIGHT_BYTES,
      inFlightResources: limits.inFlightResources ?? MAX_REVIEW_DAEMON_INFLIGHT_RESOURCES,
      sessionInFlightBytes: limits.sessionInFlightBytes ?? MAX_REVIEW_SESSION_INFLIGHT_BYTES,
      sessionInFlightResources:
        limits.sessionInFlightResources ?? MAX_REVIEW_SESSION_INFLIGHT_RESOURCES,
    };
  }

  /** One session's current reservations: how many, and how many bytes. */
  private sessionUsage(sessionId: string, except?: ReviewResourceReservation) {
    let count = 0;
    let bytes = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.sessionId !== sessionId || reservation === except) continue;
      count += 1;
      bytes += reservation.byteLength;
    }
    return { count, bytes };
  }

  /** Whether one session may hold `byteLength` more bytes beside its other loads. */
  private fitsSessionShare(usage: { count: number; bytes: number }, byteLength: number) {
    return usage.count === 0 || usage.bytes + byteLength <= this.limits.sessionInFlightBytes;
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
        // The slot frees when that load settles. Shared state reuses one key per generation
        // for every revision, so a read for a newer revision can overlap an older one.
        true,
        "resource",
      );
    }
    if (this.reservations.size >= this.limits.inFlightResources) {
      throw new ReviewResourceBudgetError(
        `The daemon is already assembling ${this.limits.inFlightResources} review resources.`,
        // A slot frees up as loads settle, unless the daemon allows none at all.
        this.limits.inFlightResources > 0,
      );
    }
    const usage = this.sessionUsage(key.sessionId);
    if (usage.count >= this.limits.sessionInFlightResources) {
      throw new ReviewResourceBudgetError(
        `This session already has ${this.limits.sessionInFlightResources} review resources loading.`,
        this.limits.sessionInFlightResources > 0,
        "session",
      );
    }
    if (!this.fitsSessionShare(usage, byteLength)) {
      throw new ReviewResourceBudgetError(
        "This session's resource loads already fill its share of the in-flight budget.",
        true,
        "session",
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
        true,
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
    if (
      delta > 0 &&
      !this.fitsSessionShare(this.sessionUsage(reservation.sessionId, reservation), byteLength)
    ) {
      throw new ReviewResourceBudgetError(
        `Review resource ${reservation.resourceId} declares ${byteLength} bytes, over this session's share of the in-flight budget.`,
      );
    }
    if (this.reservedBytes + delta > this.limits.inFlightBytes) {
      throw new ReviewResourceBudgetError(
        `Review resource ${reservation.resourceId} declares ${byteLength} bytes, over the daemon's remaining in-flight budget.`,
      );
    }
    this.reservedBytes += delta;
    reservation.byteLength = byteLength;
  }

  /**
   * Reserve one load's slot, waiting in arrival order while the budget is only occupied.
   *
   * A page legitimately issues more reads than one session's share at once (its file loads,
   * then image previews and gap source), so a full budget is a queue, not a refusal. Waiters
   * are woken when a reservation is released or evicted, never by polling, and are served in
   * arrival order: a waiter blocked by the daemon-wide budget holds back everyone behind it,
   * one blocked by its session's share holds back that session's later waiters only, and one
   * whose key an earlier load still holds (a newer shared-state revision overlapping an older
   * one) waits for that load alone, so no read is starved and one session cannot hold up
   * another. A load that could never fit
   * fails at once; one still waiting after `waitMs` fails with the budget error; and one whose
   * `signal` aborts leaves the queue immediately and never reserves anything.
   */
  reserveWhenFree(
    key: ReviewResourceKey,
    byteLength: number,
    options: { waitMs: number; signal?: AbortSignal },
  ): Promise<ReviewResourceReservation> {
    const { signal, waitMs } = options;
    if (signal?.aborted) return Promise.reject(new ReviewResourceWaitAbortedError());
    if (this.waiters.length === 0) {
      try {
        return Promise.resolve(this.reserve(key, byteLength));
      } catch (error) {
        if (!(error instanceof ReviewResourceBudgetError) || !error.retryable || waitMs <= 0) {
          return Promise.reject(error);
        }
        return this.enqueue(key, byteLength, error, waitMs, signal);
      }
    }
    // Others are already waiting: join the back of the queue rather than overtaking them.
    const placeholder = new ReviewResourceBudgetError(
      "Review resource loads already fill the daemon's in-flight budget.",
      true,
    );
    const waiting = this.enqueue(key, byteLength, placeholder, waitMs, signal);
    this.drainWaiters();
    return waiting;
  }

  /** Add one waiter at the back of the queue with its deadline and abort listener. */
  private enqueue(
    key: ReviewResourceKey,
    byteLength: number,
    lastError: ReviewResourceBudgetError,
    waitMs: number,
    signal: AbortSignal | undefined,
  ) {
    return new Promise<ReviewResourceReservation>((resolve, reject) => {
      const leave = (error: Error) => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        waiter.dispose();
        reject(error);
        // Whoever was held back behind this waiter may fit now.
        this.drainWaiters();
      };
      const timer = setTimeout(() => leave(waiter.lastError), waitMs);
      const onAbort = () => leave(new ReviewResourceWaitAbortedError());
      const waiter: ReservationWaiter = {
        key,
        byteLength,
        lastError,
        resolve,
        reject,
        dispose: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Grant slots to waiters in arrival order, as far as the budget now allows. */
  private drainWaiters() {
    const blockedSessions = new Set<string>();
    for (const waiter of Array.from(this.waiters)) {
      if (blockedSessions.has(waiter.key.sessionId)) continue;
      let reservation: ReviewResourceReservation;
      try {
        reservation = this.reserve(waiter.key, waiter.byteLength);
      } catch (error) {
        if (error instanceof ReviewResourceBudgetError && error.retryable) {
          waiter.lastError = error;
          if (error.scope === "daemon") return;
          if (error.scope === "session") blockedSessions.add(waiter.key.sessionId);
          continue;
        }
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.dispose();
        waiter.reject(error as Error);
        continue;
      }
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.dispose();
      waiter.resolve(reservation);
    }
  }

  /** How many loads are waiting for a slot, for lifecycle assertions. */
  getWaiterCount() {
    return this.waiters.length;
  }

  /** Give one in-flight slot back, whether the load succeeded or failed. */
  release(reservation: ReviewResourceReservation) {
    const mapKey = cacheKey(reservation);
    if (this.reservations.get(mapKey) !== reservation) {
      return;
    }
    this.reservations.delete(mapKey);
    this.reservedBytes -= reservation.byteLength;
    this.drainWaiters();
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
    // A cleared cache belongs to a daemon shutting down; nobody is left to serve its waiters.
    for (const waiter of this.waiters.splice(0)) {
      waiter.dispose();
      waiter.reject(new ReviewResourceWaitAbortedError());
    }
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
    let released = false;
    for (const [mapKey, reservation] of this.reservations) {
      if (matches(reservation)) {
        this.reservations.delete(mapKey);
        this.reservedBytes -= reservation.byteLength;
        released = true;
      }
    }
    if (released) this.drainWaiters();
  }
}
