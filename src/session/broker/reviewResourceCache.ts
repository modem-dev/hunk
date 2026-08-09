import { createHash } from "node:crypto";
import type { ReviewResourceDescriptorV1 } from "../../core/review/types";
import {
  MAX_REVIEW_DAEMON_CACHE_BYTES,
  MAX_REVIEW_DAEMON_CACHE_RESOURCES,
  MAX_REVIEW_DAEMON_INFLIGHT_BYTES,
  MAX_REVIEW_DAEMON_INFLIGHT_RESOURCES,
  MAX_REVIEW_GENERATION_CACHE_BYTES,
  MAX_REVIEW_RESOURCE_BYTES,
  MAX_REVIEW_SESSION_CACHE_BYTES,
  isReviewSha256Digest,
} from "../reviewProtocol";

export interface ReviewResourceCacheLimits {
  perResourceBytes: number;
  perGenerationBytes: number;
  perSessionBytes: number;
  daemonBytes: number;
  daemonResources: number;
  inFlightBytes: number;
  inFlightResources: number;
}

interface CachedReviewResource {
  descriptor: ReviewResourceDescriptorV1 & { byteLength: number; digest: string };
  bytes: Uint8Array;
}

export interface ReviewResourceReservation {
  key: string;
  sessionId: string;
  generation: string;
  resourceId: string;
  byteLength: number;
}

/** Bounded daemon-wide LRU for verified resources and reserved in-flight assemblies. */
export class ReviewResourceCache {
  private readonly entries = new Map<string, CachedReviewResource>();
  private readonly reservations = new Map<string, ReviewResourceReservation>();
  private readonly limits: ReviewResourceCacheLimits;

  constructor(limits: Partial<ReviewResourceCacheLimits> = {}) {
    this.limits = {
      perResourceBytes: limits.perResourceBytes ?? MAX_REVIEW_RESOURCE_BYTES,
      perGenerationBytes: limits.perGenerationBytes ?? MAX_REVIEW_GENERATION_CACHE_BYTES,
      perSessionBytes: limits.perSessionBytes ?? MAX_REVIEW_SESSION_CACHE_BYTES,
      daemonBytes: limits.daemonBytes ?? MAX_REVIEW_DAEMON_CACHE_BYTES,
      daemonResources: limits.daemonResources ?? MAX_REVIEW_DAEMON_CACHE_RESOURCES,
      inFlightBytes: limits.inFlightBytes ?? MAX_REVIEW_DAEMON_INFLIGHT_BYTES,
      inFlightResources: limits.inFlightResources ?? MAX_REVIEW_DAEMON_INFLIGHT_RESOURCES,
    };
  }

  private key(sessionId: string, generation: string, resourceId: string) {
    return JSON.stringify([sessionId, generation, resourceId]);
  }

  private entryBytes(predicate: (parts: string[]) => boolean) {
    let total = 0;
    for (const [key, entry] of this.entries) {
      if (predicate(JSON.parse(key) as string[])) total += entry.bytes.byteLength;
    }
    return total;
  }

  private reservationBytes(predicate: (reservation: ReviewResourceReservation) => boolean) {
    let total = 0;
    for (const reservation of this.reservations.values()) {
      if (predicate(reservation)) total += reservation.byteLength;
    }
    return total;
  }

  private daemonEntryBytes() {
    return this.entryBytes(() => true);
  }

  private daemonReservationBytes() {
    return this.reservationBytes(() => true);
  }

  /** Evict completed LRU entries until completed plus reserved resource slots fit. */
  private ensureDaemonResourceSlots(additionalSlots: number, protectedKey?: string) {
    while (
      this.entries.size + this.reservations.size + additionalSlots > this.limits.daemonResources &&
      this.entries.size > 0
    ) {
      const candidate = [...this.entries.keys()].find((key) => key !== protectedKey);
      if (!candidate) break;
      this.entries.delete(candidate);
    }
    if (
      this.limits.daemonResources <= 0 ||
      this.entries.size + this.reservations.size + additionalSlots > this.limits.daemonResources
    ) {
      throw new Error("Review resources exceed the daemon cache entry limit.");
    }
  }

  /** Return one complete resource and promote it to the most-recently-used position. */
  get(sessionId: string, generation: string, resourceId: string) {
    const key = this.key(sessionId, generation, resourceId);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.bytes;
  }

  /** Reserve declared bytes before fetching or allocating one resource assembly. */
  reserve(
    sessionId: string,
    generation: string,
    descriptor: ReviewResourceDescriptorV1,
  ): ReviewResourceReservation {
    if (
      descriptor.generation !== generation ||
      descriptor.byteLength === undefined ||
      !Number.isInteger(descriptor.byteLength) ||
      descriptor.byteLength < 0 ||
      !isReviewSha256Digest(descriptor.digest)
    ) {
      throw new Error("Review resource descriptor is not complete for this generation.");
    }
    if (descriptor.byteLength > this.limits.perResourceBytes) {
      throw new Error(`Review resource ${descriptor.id} exceeds the per-resource cache limit.`);
    }
    const key = this.key(sessionId, generation, descriptor.id);
    if (this.reservations.has(key)) {
      throw new Error(`Review resource ${descriptor.id} already has an in-flight reservation.`);
    }
    const inFlight = this.daemonReservationBytes();
    if (this.reservations.size >= this.limits.inFlightResources) {
      throw new Error("Review resource assemblies exceed the daemon concurrency limit.");
    }
    if (inFlight + descriptor.byteLength > this.limits.inFlightBytes) {
      throw new Error("Review resource assemblies exceed the daemon in-flight limit.");
    }
    const generationBytes =
      this.entryBytes(
        ([entrySession, entryGeneration]) =>
          entrySession === sessionId && entryGeneration === generation,
      ) +
      this.reservationBytes(
        (reservation) =>
          reservation.sessionId === sessionId && reservation.generation === generation,
      );
    if (generationBytes + descriptor.byteLength > this.limits.perGenerationBytes) {
      throw new Error(`Review generation ${generation} exceeds the generation cache limit.`);
    }
    const sessionBytes =
      this.entryBytes(([entrySession]) => entrySession === sessionId) +
      this.reservationBytes((reservation) => reservation.sessionId === sessionId);
    if (sessionBytes + descriptor.byteLength > this.limits.perSessionBytes) {
      throw new Error(`Review session ${sessionId} exceeds the session cache limit.`);
    }

    // Reservations consume daemon resource slots just like completed cache entries.
    this.ensureDaemonResourceSlots(1);
    while (
      this.entries.size > 0 &&
      this.daemonEntryBytes() + inFlight + descriptor.byteLength > this.limits.daemonBytes
    ) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    if (this.daemonEntryBytes() + inFlight + descriptor.byteLength > this.limits.daemonBytes) {
      throw new Error("Review resources exceed the daemon cache limit.");
    }

    const reservation = {
      key,
      sessionId,
      generation,
      resourceId: descriptor.id,
      byteLength: descriptor.byteLength,
    };
    this.reservations.set(key, reservation);
    return reservation;
  }

  /** Validate and admit a reserved assembly without making another full resource copy. */
  complete(
    reservation: ReviewResourceReservation,
    descriptor: ReviewResourceDescriptorV1,
    bytes: Uint8Array,
  ) {
    if (this.reservations.get(reservation.key) !== reservation) {
      throw new Error(`Review resource ${descriptor.id} has no active reservation.`);
    }
    if (bytes.byteLength !== reservation.byteLength || bytes.byteLength !== descriptor.byteLength) {
      throw new Error(`Review resource ${descriptor.id} size does not match its descriptor.`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== descriptor.digest?.toLowerCase()) {
      throw new Error(`Review resource ${descriptor.id} digest does not match its descriptor.`);
    }
    // Completion replaces one reserved slot with one completed slot. Recheck defensively and evict
    // unrelated completed LRU entries only after the candidate bytes are fully verified.
    this.ensureDaemonResourceSlots(0, reservation.key);
    this.reservations.delete(reservation.key);
    this.entries.delete(reservation.key);
    this.entries.set(reservation.key, {
      descriptor: descriptor as CachedReviewResource["descriptor"],
      bytes,
    });
  }

  /** Convenience admission path used by tests and already-buffered callers. */
  setComplete(
    sessionId: string,
    generation: string,
    descriptor: ReviewResourceDescriptorV1,
    bytes: Uint8Array,
  ) {
    const reservation = this.reserve(sessionId, generation, descriptor);
    try {
      this.complete(reservation, descriptor, bytes);
    } finally {
      this.release(reservation);
    }
  }

  /** Release one failed or cancelled in-flight reservation. */
  release(reservation: ReviewResourceReservation) {
    if (this.reservations.get(reservation.key) === reservation) {
      this.reservations.delete(reservation.key);
    }
  }

  /** Evict complete and reserved resources for one retired generation. */
  evictGeneration(sessionId: string, generation: string) {
    for (const key of this.entries.keys()) {
      const [entrySession, entryGeneration] = JSON.parse(key) as string[];
      if (entrySession === sessionId && entryGeneration === generation) this.entries.delete(key);
    }
    for (const [key, reservation] of this.reservations) {
      if (reservation.sessionId === sessionId && reservation.generation === generation) {
        this.reservations.delete(key);
      }
    }
  }

  /** Evict complete and reserved resources when a producer disconnects. */
  evictSession(sessionId: string) {
    for (const key of this.entries.keys()) {
      const [entrySession] = JSON.parse(key) as string[];
      if (entrySession === sessionId) this.entries.delete(key);
    }
    for (const [key, reservation] of this.reservations) {
      if (reservation.sessionId === sessionId) this.reservations.delete(key);
    }
  }

  getEntryCount() {
    return this.entries.size;
  }

  getReservationCount() {
    return this.reservations.size;
  }

  getTotalBytes() {
    return this.daemonEntryBytes() + this.daemonReservationBytes();
  }
}
