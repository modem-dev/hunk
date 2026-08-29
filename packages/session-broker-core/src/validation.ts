import {
  isValidBrokerAppId,
  isValidBrokerIdentifier,
  isValidBrokerRevision,
  parseCallerSequence,
} from "./auth";
import type { SessionTargetInput } from "./types";

export const MAX_BROKER_STRING_BYTES = 4_096;
export const MAX_BROKER_ERROR_BYTES = 1_024;
export const MAX_BROKER_DEADLINE_MS = 5 * 60_000;

export type BrokerProtocolFailureCode =
  | "invalid-json"
  | "invalid-record"
  | "invalid-keys"
  | "invalid-discriminant"
  | "invalid-field"
  | "invalid-selector"
  | "invalid-deadline"
  | "invalid-contract"
  | "unknown-command"
  | "invalid-app-payload"
  | "app-parser-failed";

/** Reports one stable protocol failure without reflecting parser messages or attacker payloads. */
export class BrokerProtocolError extends Error {
  constructor(readonly code: BrokerProtocolFailureCode) {
    super("Session broker protocol validation failed.");
    this.name = "BrokerProtocolError";
  }
}

/** Throw one stable protocol failure code. */
export function failBrokerProtocol(code: BrokerProtocolFailureCode): never {
  throw new BrokerProtocolError(code);
}

/** Return an object record while rejecting null, arrays, and exotic prototypes. */
export function parseBrokerRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failBrokerProtocol("invalid-record");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return failBrokerProtocol("invalid-record");
  }
  return value as Record<string, unknown>;
}

/** Require an exact key set with separately declared required and optional keys. */
export function parseExactBrokerRecord<Required extends string, Optional extends string = never>(
  value: unknown,
  required: readonly Required[],
  optional: readonly Optional[] = [],
): Record<Required, unknown> & Partial<Record<Optional, unknown>> {
  const record = parseBrokerRecord(value);
  const allowed = new Set<string>([...required, ...optional]);
  const keys = Object.keys(record);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    return failBrokerProtocol("invalid-keys");
  }
  return record as Record<Required, unknown> & Partial<Record<Optional, unknown>>;
}

/** Parse a bounded string by UTF-8 byte length. */
export function parseBrokerString(
  value: unknown,
  options: { minBytes?: number; maxBytes?: number } = {},
): string {
  if (typeof value !== "string") return failBrokerProtocol("invalid-field");
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < (options.minBytes ?? 1) || bytes > (options.maxBytes ?? MAX_BROKER_STRING_BYTES)) {
    return failBrokerProtocol("invalid-field");
  }
  return value;
}

/** Parse one bounded broker identifier. */
export function parseBrokerIdentifier(value: unknown): string {
  if (!isValidBrokerIdentifier(value)) return failBrokerProtocol("invalid-field");
  return value;
}

/** Parse one immutable application identifier. */
export function parseBrokerAppId(value: unknown): string {
  if (!isValidBrokerAppId(value)) return failBrokerProtocol("invalid-field");
  return value;
}

/** Parse one non-negative or positive safe integer. */
export function parseBrokerSafeInteger(
  value: unknown,
  options: { minimum?: number; maximum?: number } = {},
): number {
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return failBrokerProtocol("invalid-field");
  }
  return value as number;
}

/** Parse one positive protocol or command revision. */
export function parseBrokerRevision(value: unknown): number {
  if (!isValidBrokerRevision(value)) return failBrokerProtocol("invalid-contract");
  return value;
}

/** Parse one canonical uint64 decimal value. */
export function parseBrokerUint64(value: unknown, options: { allowZero?: boolean } = {}): string {
  if (typeof value !== "string") return failBrokerProtocol("invalid-field");
  const parsed = parseCallerSequence(value);
  if (parsed === null || (!options.allowZero && parsed === 0n)) {
    return failBrokerProtocol("invalid-field");
  }
  return value;
}

/** Parse a strict generic session selector without app-owned selector semantics. */
export function parseBrokerSelector(value: unknown): SessionTargetInput {
  const record = parseExactBrokerRecord(value, [], [
    "sessionId",
    "sessionPath",
    "repoRoot",
    "repoBoundary",
  ] as const);
  const selector: SessionTargetInput = {};
  if (record.sessionId !== undefined) selector.sessionId = parseBrokerIdentifier(record.sessionId);
  for (const key of ["sessionPath", "repoRoot", "repoBoundary"] as const) {
    if (record[key] !== undefined) selector[key] = parseBrokerString(record[key]);
  }
  return selector;
}

/** Parse a positive relative timeout bounded by the public caller maximum. */
export function parseBrokerTimeout(value: unknown): number {
  try {
    return parseBrokerSafeInteger(value, { minimum: 1, maximum: MAX_BROKER_DEADLINE_MS });
  } catch {
    return failBrokerProtocol("invalid-deadline");
  }
}

/** Parse a finite absolute deadline timestamp. */
export function parseBrokerDeadline(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return failBrokerProtocol("invalid-deadline");
  }
  return value;
}

/** Invoke an app parser and normalize null returns and throws into redacted failures. */
export function parseBrokerAppPayload<T>(parser: (value: unknown) => T | null, value: unknown): T {
  let parsed: T | null;
  try {
    parsed = parser(value);
  } catch {
    return failBrokerProtocol("app-parser-failed");
  }
  if (parsed === null || parsed === undefined) return failBrokerProtocol("invalid-app-payload");
  return parsed;
}
