import { diagnoseSessionRegistration, diagnoseSessionSnapshot } from "./wire";

/**
 * Reports why the daemon rejected a session registration or snapshot, for `HUNK_DEBUG=1`.
 *
 * A rejection today closes the producer socket with a fixed reason and nothing else, which
 * turns a daemon/client version skew into a bisect. The description names the rejecting parser
 * and its top-level key path and never includes payload contents.
 */
export type SessionWirePayloadKind = "registration" | "snapshot";

/** Read the session id from an unparsed payload defensively; it may be absent or malformed. */
function readSessionId(input: unknown): string | null {
  const sessionId = (input as { sessionId?: unknown } | null)?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 128
    ? sessionId
    : null;
}

/** Describe one rejected payload as a single log line without reflecting its contents. */
export function describeSessionWireRejection(
  kind: SessionWirePayloadKind,
  input: unknown,
  sessionId: string | null = readSessionId(input),
) {
  const rejection =
    kind === "registration" ? diagnoseSessionRegistration(input) : diagnoseSessionSnapshot(input);
  const origin = sessionId ? ` from session ${sessionId}` : "";
  if (!rejection) {
    return `rejected ${kind}${origin}: the payload parses; the broker refused it for another reason`;
  }
  const location = rejection.path ? ` at ${rejection.path}` : " at the envelope";
  return `rejected ${kind}${origin}: ${rejection.parser} returned null${location}`;
}

/** Log one rejected payload to the daemon's stderr when `HUNK_DEBUG=1`. */
export function reportSessionWireRejection(
  kind: SessionWirePayloadKind,
  input: unknown,
  write: (line: string) => void = (line) => console.error(line),
  sessionId?: string | null,
) {
  if (process.env.HUNK_DEBUG !== "1") return;
  write(
    `[session:daemon] ${describeSessionWireRejection(kind, input, sessionId ?? readSessionId(input))}`,
  );
}
