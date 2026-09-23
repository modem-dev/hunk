import {
  BrokerProtocolError,
  parseBrokerRevision,
  parseBrokerSafeInteger,
  parseBrokerString,
  parseExactBrokerRecord,
} from "@hunk/session-broker-core";

/**
 * Defines the daemon's revision-tolerant admin scope: two actions a caller from a *different*
 * app revision may perform after the ordinary signed caller handshake.
 *
 * - `status` reports what the daemon is (its revision, version, pid, uptime) and which sessions
 *   are attached, so a mismatched client can explain the skew to the user.
 * - `stop` begins graceful shutdown and closes attached producers with a distinct reason, which
 *   is what lets `hunk daemon restart` replace an old daemon without signalling a pid.
 *
 * The scope has its own fixed app contract (`SESSION_BROKER_ADMIN_SCOPE_VERSION` stands in for
 * the app revision in the hello) and its own HTTP paths, so a caller session negotiated here is
 * unknown to the main authenticator and can never reach the session API. The response schema is
 * frozen: extend it by adding a new version, never in place.
 */
export const SESSION_BROKER_ADMIN_SCOPE_VERSION = 1;

export interface SessionBrokerAdminPaths {
  readonly challenge: string;
  readonly proof: string;
  readonly control: string;
}

export const DEFAULT_SESSION_BROKER_ADMIN_PATHS: SessionBrokerAdminPaths = Object.freeze({
  challenge: "/session-admin/challenge",
  proof: "/session-admin/proof",
  control: "/session-admin",
});

/** Close reason attached producers see when an admin `stop` retires the daemon. */
export const SESSION_BROKER_ADMIN_STOP_CLOSE_REASON = "Session daemon restarting.";

export type SessionBrokerAdminRequest = { readonly action: "status" } | { readonly action: "stop" };

export interface SessionBrokerAdminSessionV1 {
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string;
  readonly pid: number;
  /** The app revision the session's producer presented in its hello. */
  readonly clientDaemonVersion: number;
}

export interface SessionBrokerAdminStatusV1 {
  readonly adminScopeVersion: typeof SESSION_BROKER_ADMIN_SCOPE_VERSION;
  /** The daemon's app revision — the value the ordinary hello requires an exact match on. */
  readonly daemonVersion: number;
  /** The app's human-readable build version, such as a package version. */
  readonly appVersion: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly uptimeMs: number;
  readonly sessions: readonly SessionBrokerAdminSessionV1[];
}

export interface SessionBrokerAdminStopResultV1 {
  readonly adminScopeVersion: typeof SESSION_BROKER_ADMIN_SCOPE_VERSION;
  readonly stopping: true;
}

/** Parse one exact admin request body. */
export function parseSessionBrokerAdminRequest(value: unknown): SessionBrokerAdminRequest {
  const record = parseExactBrokerRecord(value, ["action"] as const);
  if (record.action === "status" || record.action === "stop") return { action: record.action };
  throw new BrokerProtocolError("invalid-discriminant");
}

/** Parse one exact v1 admin session entry. */
function parseAdminSessionV1(value: unknown): SessionBrokerAdminSessionV1 {
  const record = parseExactBrokerRecord(value, [
    "sessionId",
    "title",
    "cwd",
    "pid",
    "clientDaemonVersion",
  ] as const);
  return {
    sessionId: parseBrokerString(record.sessionId),
    title: parseBrokerString(record.title, { minBytes: 0 }),
    cwd: parseBrokerString(record.cwd, { minBytes: 0 }),
    pid: parseBrokerSafeInteger(record.pid, { minimum: 1 }),
    clientDaemonVersion: parseBrokerRevision(record.clientDaemonVersion),
  };
}

/** Parse one exact v1 admin status body; any other scope version is a protocol failure. */
export function parseSessionBrokerAdminStatusV1(value: unknown): SessionBrokerAdminStatusV1 {
  const record = parseExactBrokerRecord(value, [
    "adminScopeVersion",
    "daemonVersion",
    "appVersion",
    "pid",
    "startedAt",
    "uptimeMs",
    "sessions",
  ] as const);
  if (record.adminScopeVersion !== SESSION_BROKER_ADMIN_SCOPE_VERSION) {
    throw new BrokerProtocolError("invalid-discriminant");
  }
  if (!Array.isArray(record.sessions)) throw new BrokerProtocolError("invalid-field");
  return {
    adminScopeVersion: SESSION_BROKER_ADMIN_SCOPE_VERSION,
    daemonVersion: parseBrokerRevision(record.daemonVersion),
    appVersion: parseBrokerString(record.appVersion),
    pid: parseBrokerSafeInteger(record.pid, { minimum: 1 }),
    startedAt: parseBrokerString(record.startedAt),
    uptimeMs: parseBrokerSafeInteger(record.uptimeMs),
    sessions: record.sessions.map(parseAdminSessionV1),
  };
}

/** Parse one exact v1 admin stop acknowledgement. */
export function parseSessionBrokerAdminStopResultV1(
  value: unknown,
): SessionBrokerAdminStopResultV1 {
  const record = parseExactBrokerRecord(value, ["adminScopeVersion", "stopping"] as const);
  if (record.adminScopeVersion !== SESSION_BROKER_ADMIN_SCOPE_VERSION || record.stopping !== true) {
    throw new BrokerProtocolError("invalid-discriminant");
  }
  return { adminScopeVersion: SESSION_BROKER_ADMIN_SCOPE_VERSION, stopping: true };
}
