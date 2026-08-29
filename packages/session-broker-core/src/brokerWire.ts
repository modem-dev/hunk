import type {
  SessionRegistration,
  SessionSnapshot,
  SessionTerminalLocation,
  SessionTerminalMetadata,
} from "./types";
import {
  BrokerProtocolError,
  parseBrokerAppPayload,
  parseBrokerIdentifier,
  parseBrokerSafeInteger,
  parseBrokerString,
  parseExactBrokerRecord,
} from "./validation";

/** Version the live broker registration payload separately from the public session CLI API. */
export const SESSION_BROKER_REGISTRATION_VERSION = 2;

type JsonRecord = Record<string, unknown>;

/** Return one plain JSON object record when the wire payload is object-shaped. */
function asRecord(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as JsonRecord) : null;
}

/** Parse one required bounded non-empty string field. */
function parseRequiredString(value: unknown) {
  try {
    return parseBrokerString(value);
  } catch {
    return null;
  }
}

/** Parse one optional bounded string, rejecting malformed present values. */
function parseOptionalString(value: unknown) {
  if (value === undefined) return undefined;
  return parseBrokerString(value);
}

/** Parse one required non-negative safe integer field. */
function parseNonNegativeInt(value: unknown) {
  try {
    return parseBrokerSafeInteger(value);
  } catch {
    return null;
  }
}

/** Parse one required positive safe integer field. */
function parsePositiveInt(value: unknown) {
  try {
    return parseBrokerSafeInteger(value, { minimum: 1 });
  } catch {
    return null;
  }
}

/** Parse one terminal location with exact keys and strict optional fields. */
function parseSessionTerminalLocation(value: unknown): SessionTerminalLocation {
  const record = parseExactBrokerRecord(
    value,
    ["source"] as const,
    ["tty", "windowId", "tabId", "paneId", "terminalId", "sessionId"] as const,
  );
  return {
    source: parseBrokerString(record.source),
    ...(record.tty === undefined ? {} : { tty: parseBrokerString(record.tty) }),
    ...(record.windowId === undefined ? {} : { windowId: parseBrokerString(record.windowId) }),
    ...(record.tabId === undefined ? {} : { tabId: parseBrokerString(record.tabId) }),
    ...(record.paneId === undefined ? {} : { paneId: parseBrokerString(record.paneId) }),
    ...(record.terminalId === undefined
      ? {}
      : { terminalId: parseBrokerString(record.terminalId) }),
    ...(record.sessionId === undefined
      ? {}
      : { sessionId: parseBrokerIdentifier(record.sessionId) }),
  };
}

/** Parse terminal metadata with exact keys and no partial location filtering. */
function parseSessionTerminalMetadata(value: unknown): SessionTerminalMetadata {
  const record = parseExactBrokerRecord(value, ["locations"] as const, ["program"] as const);
  if (!Array.isArray(record.locations)) throw new BrokerProtocolError("invalid-field");
  return {
    ...(record.program === undefined ? {} : { program: parseBrokerString(record.program) }),
    locations: record.locations.map(parseSessionTerminalLocation),
  };
}

/** Parse one broker registration envelope and delegate app-owned info parsing to the caller. */
export function parseSessionRegistrationEnvelope<Info>(
  value: unknown,
  parseInfo: (value: unknown) => Info | null,
): SessionRegistration<Info> | null {
  try {
    const record = parseExactBrokerRecord(
      value,
      ["registrationVersion", "sessionId", "pid", "cwd", "launchedAt", "info"] as const,
      ["repoRoot", "terminal"] as const,
    );
    const registrationVersion = parseBrokerSafeInteger(record.registrationVersion, { minimum: 1 });
    if (registrationVersion !== SESSION_BROKER_REGISTRATION_VERSION) return null;
    return {
      registrationVersion,
      sessionId: parseBrokerIdentifier(record.sessionId),
      pid: parseBrokerSafeInteger(record.pid, { minimum: 1 }),
      cwd: parseBrokerString(record.cwd),
      ...(record.repoRoot === undefined ? {} : { repoRoot: parseBrokerString(record.repoRoot) }),
      launchedAt: parseBrokerString(record.launchedAt),
      ...(record.terminal === undefined
        ? {}
        : { terminal: parseSessionTerminalMetadata(record.terminal) }),
      info: parseBrokerAppPayload(parseInfo, record.info),
    };
  } catch {
    return null;
  }
}

/** Parse one broker snapshot envelope and delegate app-owned state parsing to the caller. */
export function parseSessionSnapshotEnvelope<State>(
  value: unknown,
  parseState: (value: unknown) => State | null,
): SessionSnapshot<State> | null {
  try {
    const record = parseExactBrokerRecord(value, ["updatedAt", "state"] as const);
    return {
      updatedAt: parseBrokerString(record.updatedAt),
      state: parseBrokerAppPayload(parseState, record.state),
    };
  } catch {
    return null;
  }
}

export const brokerWireParsers = {
  asRecord,
  parseNonNegativeInt,
  parseOptionalString,
  parsePositiveInt,
  parseRequiredString,
};
