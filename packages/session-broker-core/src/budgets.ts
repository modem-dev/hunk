/** Defines the supported Phase-1 broker resource ceilings and reusable reservations. */

/** Enumerate every broker-owned resource ceiling used by current Phase-1 surfaces. */
export interface SessionBrokerLimits {
  readonly maxSessions: number;
  readonly maxCommandsPerSession: number;
  readonly maxCommandsTotal: number;
  /** Bound producer commands retained while queued or executing through one bridge. */
  readonly maxPreBridgeCommands: number;
  readonly maxCommandInputBytes: number;
  readonly maxCommandResultBytes: number;
  readonly maxQueuedCommandBytes: number;
  readonly maxRetainedSessionBytes: number;
  readonly maxRetainedBytes: number;
  readonly defaultCommandTimeoutMs: number;
  readonly maxCommandTimeoutMs: number;
  readonly maxConcurrentHttpControls: number;
  readonly maxInFlightHttpBodyBytes: number;
  readonly maxHttpBodyBytes: number;
  readonly maxHttpResponseBytes: number;
  readonly maxInFlightHttpResponseBytes: number;
  readonly maxWsMessageBytes: number;
  /** Bound broker-owned processing after native WebSocket delivery, excluding runtime queues. */
  readonly maxInFlightWsBytes: number;
  readonly maxOutboundBytesPerPeer: number;
  readonly maxOutboundBytesTotal: number;
  readonly maxUnauthenticatedSockets: number;
  readonly maxHandshakeDurationMs: number;
  readonly maxIncompleteHandshakes: number;
  readonly maxIncompleteHandshakeBytes: number;
  readonly maxHandshakeProposalBytes: number;
  readonly challengeTtlMs: number;
  readonly callerSessionTtlMs: number;
  readonly maxCallerSessions: number;
  readonly maxCallerSessionBytes: number;
  readonly maxCallerSessionsBytes: number;
}

/** Hold the immutable supported broker ceilings. Hosts may lower these without opting out. */
export const DEFAULT_SESSION_BROKER_LIMITS: Readonly<SessionBrokerLimits> = Object.freeze({
  maxSessions: 256,
  maxCommandsPerSession: 64,
  maxCommandsTotal: 1_024,
  maxPreBridgeCommands: 32,
  maxCommandInputBytes: 1024 * 1024,
  maxCommandResultBytes: 1024 * 1024,
  maxQueuedCommandBytes: 64 * 1024 * 1024,
  maxRetainedSessionBytes: 4 * 1024 * 1024,
  maxRetainedBytes: 256 * 1024 * 1024,
  defaultCommandTimeoutMs: 15_000,
  maxCommandTimeoutMs: 5 * 60_000,
  maxConcurrentHttpControls: 32,
  maxInFlightHttpBodyBytes: 64 * 1024 * 1024,
  maxHttpBodyBytes: 4 * 1024 * 1024,
  maxHttpResponseBytes: 8 * 1024 * 1024,
  maxInFlightHttpResponseBytes: 64 * 1024 * 1024,
  maxWsMessageBytes: 8 * 1024 * 1024,
  maxInFlightWsBytes: 64 * 1024 * 1024,
  maxOutboundBytesPerPeer: 8 * 1024 * 1024,
  maxOutboundBytesTotal: 64 * 1024 * 1024,
  maxUnauthenticatedSockets: 64,
  maxHandshakeDurationMs: 15_000,
  maxIncompleteHandshakes: 128,
  maxIncompleteHandshakeBytes: 4 * 1024 * 1024,
  maxHandshakeProposalBytes: 64 * 1024,
  challengeTtlMs: 15_000,
  callerSessionTtlMs: 5 * 60_000,
  maxCallerSessions: 256,
  maxCallerSessionBytes: 8 * 1024,
  maxCallerSessionsBytes: 2 * 1024 * 1024,
});

export interface SessionBrokerLimitOptions {
  /** Supported configuration may only lower the immutable defaults. */
  readonly limits?: Partial<SessionBrokerLimits>;
  /** Explicitly opts out of supported ceilings. Hosts assume the resulting resource risk. */
  readonly unsafeLimits?: Partial<SessionBrokerLimits>;
}

export type BrokerCapacityCode = "busy" | "queue-full" | "capacity-exceeded";

/** Report a stable resource-admission failure without exposing internal accounting. */
export class BrokerCapacityError extends Error {
  constructor(
    readonly code: BrokerCapacityCode,
    readonly resource: keyof SessionBrokerLimits | string,
  ) {
    super(code);
    this.name = "BrokerCapacityError";
  }
}

function assertLimit(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Session broker limit ${name} must be a non-negative safe integer.`);
  }
}

/** Merge named lowerings and explicit unsafe overrides onto one complete limit snapshot. */
export function mergeSessionBrokerLimits(
  base: Readonly<SessionBrokerLimits>,
  options: SessionBrokerLimitOptions = {},
): Readonly<SessionBrokerLimits> {
  const supported = options.limits ?? {};
  const unsafe = options.unsafeLimits ?? {};
  if (!supported || typeof supported !== "object" || !unsafe || typeof unsafe !== "object") {
    throw new TypeError("Session broker limits must be objects.");
  }

  const resolved = { ...base } as SessionBrokerLimits;
  for (const name of Object.keys(DEFAULT_SESSION_BROKER_LIMITS) as (keyof SessionBrokerLimits)[]) {
    assertLimit(base[name], name);
    const supportedValue = supported[name];
    if (supportedValue !== undefined) {
      assertLimit(supportedValue, name);
      if (supportedValue > base[name]) {
        throw new TypeError(
          `Session broker limit ${name} may only be raised through unsafeLimits.`,
        );
      }
      (resolved as Record<keyof SessionBrokerLimits, number>)[name] = supportedValue;
    }
    const unsafeValue = unsafe[name];
    if (unsafeValue !== undefined) {
      assertLimit(unsafeValue, name);
      (resolved as Record<keyof SessionBrokerLimits, number>)[name] = unsafeValue;
    }
  }

  for (const key of [...Object.keys(supported), ...Object.keys(unsafe)]) {
    if (!(key in DEFAULT_SESSION_BROKER_LIMITS)) {
      throw new TypeError(`Unknown session broker limit ${key}.`);
    }
  }
  if (resolved.defaultCommandTimeoutMs > resolved.maxCommandTimeoutMs) {
    throw new TypeError(
      "Session broker defaultCommandTimeoutMs must not exceed maxCommandTimeoutMs.",
    );
  }
  if (resolved.maxRetainedSessionBytes > resolved.maxRetainedBytes) {
    throw new TypeError("Session broker per-session retained bytes must not exceed daemon bytes.");
  }
  if (resolved.maxCallerSessionBytes > resolved.maxCallerSessionsBytes) {
    throw new TypeError("Session broker per-caller retained bytes must not exceed daemon bytes.");
  }
  if (resolved.maxHttpBodyBytes > Math.floor(resolved.maxInFlightHttpBodyBytes / 2)) {
    throw new TypeError(
      "Session broker in-flight HTTP body bytes must cover the source-plus-copy peak.",
    );
  }
  if (resolved.maxHttpResponseBytes > Math.floor(resolved.maxInFlightHttpResponseBytes / 2)) {
    throw new TypeError(
      "Session broker in-flight HTTP response bytes must cover the source-plus-copy peak.",
    );
  }
  if (resolved.maxWsMessageBytes > resolved.maxInFlightWsBytes) {
    throw new TypeError("Session broker WebSocket message bytes must not exceed in-flight bytes.");
  }
  return Object.freeze(resolved);
}

/** Validate and snapshot limits relative to the immutable supported defaults. */
export function resolveSessionBrokerLimits(
  options: SessionBrokerLimitOptions = {},
): Readonly<SessionBrokerLimits> {
  return mergeSessionBrokerLimits(DEFAULT_SESSION_BROKER_LIMITS, options);
}

/** Release one successful budget reservation at most once. */
export interface BudgetReservation {
  readonly amount: number;
  readonly released: boolean;
  release(): void;
}

/** Track one count or byte budget with reserve-before-work admission. */
export class ResourceBudget {
  private reserved = 0;
  private readonly reservationStates = new WeakMap<
    BudgetReservation,
    { amount: number; released: boolean }
  >();

  constructor(
    readonly capacity: number,
    private readonly resource: string,
    private readonly code: BrokerCapacityCode = "capacity-exceeded",
  ) {
    assertLimit(capacity, resource);
  }

  get used(): number {
    return this.reserved;
  }

  tryReserve(amount = 1): BudgetReservation | null {
    assertLimit(amount, this.resource);
    if (amount > this.capacity - this.reserved) return null;
    this.reserved += amount;
    const state = { amount, released: false };
    const reservation: BudgetReservation = {
      amount,
      get released() {
        return state.released;
      },
      release: () => {
        if (state.released) return;
        state.released = true;
        this.reservationStates.delete(reservation);
        this.reserved -= state.amount;
      },
    };
    this.reservationStates.set(reservation, state);
    return reservation;
  }

  reserve(amount = 1): BudgetReservation {
    const reservation = this.tryReserve(amount);
    if (!reservation) throw new BrokerCapacityError(this.code, this.resource);
    return reservation;
  }

  /** Atomically replace one live reservation, charging only its positive size delta. */
  resize(previous: BudgetReservation, amount: number): BudgetReservation {
    assertLimit(amount, this.resource);
    const previousState = this.reservationStates.get(previous);
    if (!previousState || previousState.released) {
      throw new TypeError(`Cannot resize an inactive ${this.resource} reservation.`);
    }
    const delta = amount - previousState.amount;
    if (delta > this.capacity - this.reserved) {
      throw new BrokerCapacityError(this.code, this.resource);
    }
    this.reserved += delta;
    const replacementState = { amount, released: false };
    const replacement: BudgetReservation = {
      amount,
      get released() {
        return replacementState.released;
      },
      release: () => {
        if (replacementState.released) return;
        replacementState.released = true;
        this.reservationStates.delete(replacement);
        this.reserved -= replacementState.amount;
      },
    };
    previousState.released = true;
    this.reservationStates.delete(previous);
    this.reservationStates.set(replacement, replacementState);
    return replacement;
  }

  /** Atomically resize one reservation while retiring a second reservation from this budget. */
  resizeWithCredit(
    previous: BudgetReservation,
    amount: number,
    credit: BudgetReservation,
  ): BudgetReservation {
    assertLimit(amount, this.resource);
    const previousState = this.reservationStates.get(previous);
    const creditState = this.reservationStates.get(credit);
    if (
      previous === credit ||
      !previousState ||
      previousState.released ||
      !creditState ||
      creditState.released
    ) {
      throw new TypeError(`Cannot combine inactive ${this.resource} reservations.`);
    }
    const delta = amount - previousState.amount - creditState.amount;
    if (delta > this.capacity - this.reserved) {
      throw new BrokerCapacityError(this.code, this.resource);
    }
    this.reserved += delta;
    const replacementState = { amount, released: false };
    const replacement: BudgetReservation = {
      amount,
      get released() {
        return replacementState.released;
      },
      release: () => {
        if (replacementState.released) return;
        replacementState.released = true;
        this.reservationStates.delete(replacement);
        this.reserved -= replacementState.amount;
      },
    };
    previousState.released = true;
    creditState.released = true;
    this.reservationStates.delete(previous);
    this.reservationStates.delete(credit);
    this.reservationStates.set(replacement, replacementState);
    return replacement;
  }
}

/** Own several incremental reservations and release all of them idempotently. */
export class ReservationGroup implements BudgetReservation {
  private reservations: BudgetReservation[] = [];
  private done = false;

  get amount(): number {
    return this.reservations.reduce((sum, reservation) => sum + reservation.amount, 0);
  }

  get released(): boolean {
    return this.done;
  }

  add(reservation: BudgetReservation): void {
    if (this.done) {
      reservation.release();
      throw new Error("Cannot add to a released reservation group.");
    }
    this.reservations.push(reservation);
  }

  release(): void {
    if (this.done) return;
    this.done = true;
    for (const reservation of this.reservations.splice(0)) reservation.release();
  }
}
