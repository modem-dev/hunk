import type {
  SessionRegistration,
  SessionSnapshot,
  SessionTerminalLocation,
  SessionTerminalMetadata,
} from "./types";

/** Version the live broker registration payload separately from the public session CLI API. */
export const SESSION_BROKER_REGISTRATION_VERSION = 2;

type JsonRecord = Record<string, unknown>;

/** Return one JSON object record when the wire payload is object-shaped. */
function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

/** Parse one required non-empty string field from the websocket payload. */
function parseRequiredString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parse one optional string field, dropping malformed values instead of rejecting the payload. */
function parseOptionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse one required non-negative integer field from the websocket payload. */
function parseNonNegativeInt(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Parse one required positive integer field from the websocket payload. */
function parsePositiveInt(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Parse one terminal location entry, skipping malformed optional metadata. */
function parseSessionTerminalLocation(value: unknown): SessionTerminalLocation | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const source = parseRequiredString(record.source);
  if (source === null) {
    return null;
  }

  return {
    source,
    tty: parseOptionalString(record.tty),
    windowId: parseOptionalString(record.windowId),
    tabId: parseOptionalString(record.tabId),
    paneId: parseOptionalString(record.paneId),
    terminalId: parseOptionalString(record.terminalId),
    sessionId: parseOptionalString(record.sessionId),
  };
}

/** Parse terminal metadata while tolerating malformed optional location detail. */
function parseSessionTerminalMetadata(value: unknown): SessionTerminalMetadata | undefined {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.locations)) {
    return undefined;
  }

  const locations = record.locations
    .map(parseSessionTerminalLocation)
    .filter((location): location is SessionTerminalLocation => location !== null);

  return {
    program: parseOptionalString(record.program),
    locations,
  };
}

/** Parse one broker registration envelope and delegate app-owned info parsing to the caller. */
export function parseSessionRegistrationEnvelope<Info>(
  value: unknown,
  parseInfo: (value: unknown) => Info | null,
): SessionRegistration<Info> | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const registrationVersion = parsePositiveInt(record.registrationVersion);
  const sessionId = parseRequiredString(record.sessionId);
  const pid = parsePositiveInt(record.pid);
  const cwd = parseRequiredString(record.cwd);
  const launchedAt = parseRequiredString(record.launchedAt);
  const info = parseInfo(record.info);
  if (
    registrationVersion !== SESSION_BROKER_REGISTRATION_VERSION ||
    sessionId === null ||
    pid === null ||
    cwd === null ||
    launchedAt === null ||
    info === null
  ) {
    return null;
  }

  return {
    registrationVersion,
    sessionId,
    pid,
    cwd,
    repoRoot: parseOptionalString(record.repoRoot),
    launchedAt,
    terminal: parseSessionTerminalMetadata(record.terminal),
    info,
  };
}

/** Parse one broker snapshot envelope and delegate app-owned state parsing to the caller. */
export function parseSessionSnapshotEnvelope<State>(
  value: unknown,
  parseState: (value: unknown) => State | null,
): SessionSnapshot<State> | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const updatedAt = parseRequiredString(record.updatedAt);
  const state = parseState(record.state);
  if (updatedAt === null || state === null) {
    return null;
  }

  return {
    updatedAt,
    state,
  };
}

export const brokerWireParsers = {
  asRecord,
  parseNonNegativeInt,
  parseOptionalString,
  parsePositiveInt,
  parseRequiredString,
};
