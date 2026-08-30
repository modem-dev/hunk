import {
  CallerSequenceReplayWindow,
  MAX_BROKER_COMMAND_SCOPES,
  SESSION_BROKER_PROTOCOL_REVISION,
  SESSION_BROKER_SIGNATURE_ALGORITHM,
  buildBrokerChallengeTranscript,
  buildBrokerHelloAckTranscript,
  buildBrokerResponseTranscript,
  buildCallerRequestTranscript,
  canonicalJsonBytes,
  freezeBrokerGrant,
  isGrantActive,
  isValidBrokerAppId,
  isValidBrokerIdentifier,
  isValidBrokerRevision,
  principalFromGrant,
  parseBrokerIdentifier,
  parseBrokerString,
  parseExactBrokerRecord,
  ReservationGroup,
  ResourceBudget,
  resolveSessionBrokerLimits,
  utf8ByteLength,
  type BrokerAppContract,
  type BudgetReservation,
  type BrokerChallengeTranscriptInput,
  type BrokerGrant,
  type BrokerHelloProposal,
  type CallerGrant,
  type CallerOperation,
  type CallerPrincipal,
  type CanonicalJsonValue,
  type ProducerGrant,
  type ProducerOperation,
  type ProducerPrincipal,
  type SessionBrokerLimitOptions,
} from "@hunk/session-broker-core";
import {
  decodeBase64Url,
  encodeBase64Url,
  webSessionBrokerCrypto,
  type SessionBrokerCrypto,
} from "./crypto";

const UNIQUE_ID_RETRIES = 16;
const RANDOM_ID_BYTES = 24;
const MAX_ENDPOINT_LENGTH = 2_048;
const CHALLENGE_RECORD_OVERHEAD_BYTES = 320;
const CALLER_SESSION_RECORD_OVERHEAD_BYTES = 384;
const CRYPTO_KEY_REFERENCE_BYTES = 64;

/** Measure retained JSON fields plus opaque runtime references and map bookkeeping. */
function retainedRecordBytes(values: readonly unknown[], overhead: number): number {
  let total = overhead + CRYPTO_KEY_REFERENCE_BYTES;
  for (const value of values) {
    if (value instanceof Uint8Array) {
      total += value.byteLength;
      continue;
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) authenticationError("invalid-credential");
    total += utf8ByteLength(serialized);
  }
  return total;
}
const PRODUCER_OPERATIONS = new Set<ProducerOperation>(["register", "reconnect"]);
const CALLER_OPERATIONS = new Set<CallerOperation>([
  "list",
  "get",
  "dispatch",
  "diagnostics",
  "shutdown",
  "capability:issue",
]);

export type SessionBrokerAuthenticationFailureCode =
  | "authentication-required"
  | "invalid-credential"
  | "credential-expired"
  | "credential-revoked"
  | "challenge-expired"
  | "challenge-used"
  | "caller-session-expired"
  | "invalid-signature"
  | "replay-rejected"
  | "authentication-capacity";

/** Report one stable, redacted authentication failure without credential or signature material. */
export class SessionBrokerAuthenticationError extends Error {
  constructor(readonly code: SessionBrokerAuthenticationFailureCode) {
    super("Session broker authentication failed.");
    this.name = "SessionBrokerAuthenticationError";
  }
}

export interface SessionBrokerCredential<Grant extends BrokerGrant = BrokerGrant> {
  readonly grant: Grant;
  readonly publicKey: CryptoKey;
}

export interface SessionBrokerDaemonIdentity {
  readonly keyId: string;
  readonly privateKey: CryptoKey;
}

export interface SessionBrokerHelloChallengeRequest {
  readonly role: "producer" | "caller";
  readonly appId: string;
  readonly endpoint: string;
  readonly keyId: string;
  readonly grantId: string;
  readonly initiatorNonce: string;
  readonly proposal: BrokerHelloProposal;
}

export interface SessionBrokerHelloChallenge {
  readonly challengeId: string;
  readonly generation: string;
  readonly responderNonce: string;
  readonly expiresAt: number;
  readonly daemonKeyId: string;
  readonly daemonSignature: string;
}

export interface SessionBrokerHelloProof {
  readonly challengeId: string;
  readonly signature: string;
}

export interface AuthenticatedCallerSession {
  readonly callerSessionId: string;
  readonly principal: CallerPrincipal;
  readonly expiresAt: number;
  readonly initialSequence: "1";
  readonly brokerRevision: typeof SESSION_BROKER_PROTOCOL_REVISION;
  readonly appRevision: number;
  readonly features: readonly [];
  readonly helloTranscriptHash: string;
  readonly daemonKeyId: string;
  readonly daemonSignature: string;
}

export interface SessionBrokerProducerHelloAck {
  readonly principal: ProducerPrincipal;
  readonly connectionId: string;
  readonly brokerRevision: typeof SESSION_BROKER_PROTOCOL_REVISION;
  readonly appRevision: number;
  readonly features: readonly [];
  readonly helloTranscriptHash: string;
  readonly daemonKeyId: string;
  readonly daemonSignature: string;
}

/** Keep signed wire data separate from server-only authority retained for the live peer. */
export interface AuthenticatedProducerHello {
  readonly ack: SessionBrokerProducerHelloAck;
  /** Reject producer work after credential revocation, expiry, or a clear epoch. */
  assertActive(): void;
}

export interface CallerRequestAuthenticationInput {
  readonly request: Request;
  readonly body: Uint8Array;
}

export interface SessionBrokerResponseAuthentication {
  readonly generation: string;
  readonly brokerRevision: typeof SESSION_BROKER_PROTOCOL_REVISION;
  readonly appContract?: BrokerAppContract;
  readonly callerSessionId: string;
  readonly requestId: string;
  readonly sequence: string;
  readonly httpStatus: number;
  readonly bodyDigest: string;
  readonly daemonKeyId: string;
  readonly daemonSignature: string;
}

export interface CallerResponseSigningInput {
  readonly httpStatus: number;
  readonly body: CanonicalJsonValue;
  readonly appContract?: BrokerAppContract;
}

export interface AuthenticatedCallerRequest {
  readonly principal: CallerPrincipal;
  readonly requestId: string;
  assertActive(): void;
  signResponse(input: CallerResponseSigningInput): Promise<SessionBrokerResponseAuthentication>;
}

export interface CallerRequestAuthenticator {
  authenticate(input: CallerRequestAuthenticationInput): Promise<AuthenticatedCallerRequest>;
  clear?(): void;
}

interface PendingChallenge {
  readonly request: SessionBrokerHelloChallengeRequest;
  readonly transcript: Uint8Array;
  readonly grant: BrokerGrant;
  readonly publicKey: CryptoKey;
  readonly expiresAt: number;
  readonly reservation: BudgetReservation;
}

interface CallerSessionRecord {
  readonly principal: CallerPrincipal;
  readonly grant: CallerGrant;
  readonly publicKey: CryptoKey;
  readonly helloTranscriptHash: string;
  readonly expiresAt: number;
  readonly replay: CallerSequenceReplayWindow;
  readonly reservation: BudgetReservation;
}

export interface SessionBrokerAuthenticatorOptions {
  readonly appId: string;
  readonly appRevision: number;
  readonly generation: string;
  readonly daemonIdentity: SessionBrokerDaemonIdentity;
  readonly credentials: readonly SessionBrokerCredential[];
  readonly crypto?: SessionBrokerCrypto;
  readonly now?: () => number;
  readonly isRevoked?: (revocationId: string) => boolean;
  readonly challengeTtlMs?: number;
  readonly callerSessionTtlMs?: number;
  readonly maxChallenges?: number;
  readonly maxChallengeBytes?: number;
  readonly maxChallengeTranscriptBytes?: number;
  readonly maxCallerSessions?: number;
  readonly limits?: SessionBrokerLimitOptions["limits"];
  readonly unsafeLimits?: SessionBrokerLimitOptions["unsafeLimits"];
}

interface AuthenticatorSnapshot {
  readonly appId: string;
  readonly appRevision: number;
  readonly generation: string;
  readonly daemonIdentity: SessionBrokerDaemonIdentity;
  readonly now: () => number;
  readonly isRevoked?: (revocationId: string) => boolean;
  readonly challengeTtlMs: number;
  readonly callerSessionTtlMs: number;
  readonly maxChallenges: number;
  readonly maxChallengeBytes: number;
  readonly maxChallengeTranscriptBytes: number;
  readonly maxCallerSessions: number;
  readonly maxCallerSessionBytes: number;
  readonly maxCallerSessionsBytes: number;
}

function authenticationError(code: SessionBrokerAuthenticationFailureCode): never {
  throw new SessionBrokerAuthenticationError(code);
}

function invalidStartup(message: string): never {
  throw new TypeError(`Invalid session broker authenticator configuration: ${message}`);
}

/** Require a runtime key with the expected Ed25519 role and usage. */
function assertCryptoKey(
  value: unknown,
  expected: { type: "public" | "private"; usage: "verify" | "sign" },
): asserts value is CryptoKey {
  if (
    !value ||
    typeof value !== "object" ||
    (value as CryptoKey).type !== expected.type ||
    (value as CryptoKey).algorithm?.name !== SESSION_BROKER_SIGNATURE_ALGORITHM ||
    !(value as CryptoKey).usages?.includes(expected.usage) ||
    (expected.type === "private" && (value as CryptoKey).extractable)
  ) {
    invalidStartup(`expected an Ed25519 ${expected.type} key with ${expected.usage} usage.`);
  }
}

/** Select and validate one immutable integer authenticator limit. */
function configuredNumber(
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero: boolean,
  maximum = fallback,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < (allowZero ? 0 : 1)) {
    invalidStartup(`${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer.`);
  }
  if (selected > maximum) invalidStartup(`${name} may only be raised through unsafeLimits.`);
  return selected;
}

/** Bind the injected crypto methods so later mutations cannot alter authenticator behavior. */
function copyCrypto(value: SessionBrokerCrypto | undefined): SessionBrokerCrypto {
  const source = value ?? webSessionBrokerCrypto;
  if (
    typeof source.randomBytes !== "function" ||
    typeof source.sha256 !== "function" ||
    typeof source.sign !== "function" ||
    typeof source.verify !== "function"
  ) {
    invalidStartup("crypto must implement randomBytes, sha256, sign, and verify.");
  }
  return Object.freeze({
    randomBytes: source.randomBytes.bind(source),
    sha256: source.sha256.bind(source),
    sign: source.sign.bind(source),
    verify: source.verify.bind(source),
  });
}

/** Validate and deeply snapshot one startup grant. */
function copyGrant(input: BrokerGrant, appId: string): BrokerGrant {
  if (!input || typeof input !== "object") invalidStartup("credential grant must be an object.");
  const grant = input as BrokerGrant;
  if (grant.kind !== "producer" && grant.kind !== "caller") {
    invalidStartup("credential kind is not recognized.");
  }
  if (!isValidBrokerAppId(grant.appId) || grant.appId !== appId) {
    invalidStartup("every credential must exactly match the configured appId.");
  }
  for (const [name, value] of [
    ["principalId", grant.principalId],
    ["keyId", grant.keyId],
    ["grantId", grant.grantId],
    ["revocationId", grant.revocationId],
  ] as const) {
    if (!isValidBrokerIdentifier(value)) invalidStartup(`${name} has an invalid identifier.`);
  }
  if (grant.sessionId !== undefined && !isValidBrokerIdentifier(grant.sessionId)) {
    invalidStartup("sessionId has an invalid identifier.");
  }
  if (grant.algorithm !== SESSION_BROKER_SIGNATURE_ALGORITHM) {
    invalidStartup("credential algorithm must be Ed25519.");
  }
  if (
    !Number.isFinite(grant.issuedAt) ||
    !Number.isFinite(grant.expiresAt) ||
    grant.issuedAt >= grant.expiresAt
  ) {
    invalidStartup("credential timestamps must be finite and strictly ordered.");
  }
  if (typeof grant.mayDelegate !== "boolean" || !Array.isArray(grant.operations)) {
    invalidStartup("credential delegation and operations are malformed.");
  }

  const recognized = grant.kind === "producer" ? PRODUCER_OPERATIONS : CALLER_OPERATIONS;
  const operations = [...grant.operations];
  if (
    new Set(operations).size !== operations.length ||
    operations.some((operation) => !recognized.has(operation as never))
  ) {
    invalidStartup("credential operations must be recognized and unique.");
  }

  if (grant.kind === "producer") {
    return freezeBrokerGrant({ ...grant, operations } as ProducerGrant);
  }
  if (!Array.isArray(grant.commands) || grant.commands.length > MAX_BROKER_COMMAND_SCOPES) {
    invalidStartup("caller command scopes exceed the configured bound.");
  }
  const commandKeys = new Set<string>();
  const commands = grant.commands.map((scope) => {
    if (!scope || typeof scope !== "object" || !isValidBrokerIdentifier(scope.name)) {
      invalidStartup("caller command scope name is invalid.");
    }
    if (!isValidBrokerRevision(scope.version)) {
      invalidStartup("caller command scope version is invalid.");
    }
    const key = `${scope.name}\u0000${scope.version}`;
    if (commandKeys.has(key)) invalidStartup("caller command scopes must be unique.");
    commandKeys.add(key);
    return { name: scope.name, version: scope.version };
  });
  return freezeBrokerGrant({ ...grant, operations, commands } as CallerGrant);
}

/** Validate and index immutable startup credentials by role and verifier identity. */
function copyCredentials(
  credentials: readonly SessionBrokerCredential[],
  appId: string,
): Map<string, SessionBrokerCredential> {
  if (!Array.isArray(credentials)) invalidStartup("credentials must be an array.");
  const copied = new Map<string, SessionBrokerCredential>();
  for (const credential of credentials) {
    if (!credential || typeof credential !== "object") {
      invalidStartup("credential must be an object.");
    }
    assertCryptoKey(credential.publicKey, { type: "public", usage: "verify" });
    const grant = copyGrant(credential.grant, appId);
    const credentialId = `${grant.kind}:${grant.keyId}:${grant.grantId}`;
    if (copied.has(credentialId)) invalidStartup("credential identities must be unique.");
    copied.set(credentialId, Object.freeze({ grant, publicKey: credential.publicKey }));
  }
  return copied;
}

/** Validate and snapshot every non-credential authenticator startup option. */
function copyOptions(options: SessionBrokerAuthenticatorOptions): AuthenticatorSnapshot {
  if (!options || typeof options !== "object") invalidStartup("options must be an object.");
  if (!isValidBrokerAppId(options.appId)) invalidStartup("appId has an invalid grammar.");
  if (!isValidBrokerRevision(options.appRevision)) {
    invalidStartup("appRevision must be a positive safe integer.");
  }
  if (!isValidBrokerIdentifier(options.generation)) {
    invalidStartup("generation has an invalid identifier.");
  }
  if (!options.daemonIdentity || !isValidBrokerIdentifier(options.daemonIdentity.keyId)) {
    invalidStartup("daemon keyId has an invalid identifier.");
  }
  assertCryptoKey(options.daemonIdentity.privateKey, { type: "private", usage: "sign" });
  if (options.now !== undefined && typeof options.now !== "function") {
    invalidStartup("now must be a function.");
  }
  if (options.isRevoked !== undefined && typeof options.isRevoked !== "function") {
    invalidStartup("isRevoked must be a function.");
  }
  const limits = resolveSessionBrokerLimits({
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.unsafeLimits ? { unsafeLimits: options.unsafeLimits } : {}),
  });
  const retainedCallerCapacity =
    limits.maxCallerSessionBytes === 0
      ? 0
      : Math.floor(limits.maxCallerSessionsBytes / limits.maxCallerSessionBytes);
  const maxCallerSessions = Math.min(limits.maxCallerSessions, retainedCallerCapacity);
  return Object.freeze({
    appId: options.appId,
    appRevision: options.appRevision,
    generation: options.generation,
    daemonIdentity: Object.freeze({
      keyId: options.daemonIdentity.keyId,
      privateKey: options.daemonIdentity.privateKey,
    }),
    now: options.now ?? Date.now,
    ...(options.isRevoked ? { isRevoked: options.isRevoked } : {}),
    challengeTtlMs: configuredNumber(
      options.challengeTtlMs,
      limits.challengeTtlMs,
      "challengeTtlMs",
      false,
      limits.challengeTtlMs,
    ),
    callerSessionTtlMs: configuredNumber(
      options.callerSessionTtlMs,
      limits.callerSessionTtlMs,
      "callerSessionTtlMs",
      false,
      limits.callerSessionTtlMs,
    ),
    maxChallenges: configuredNumber(
      options.maxChallenges,
      limits.maxIncompleteHandshakes,
      "maxChallenges",
      true,
      limits.maxIncompleteHandshakes,
    ),
    maxChallengeBytes: configuredNumber(
      options.maxChallengeBytes,
      limits.maxIncompleteHandshakeBytes,
      "maxChallengeBytes",
      true,
      limits.maxIncompleteHandshakeBytes,
    ),
    maxChallengeTranscriptBytes: configuredNumber(
      options.maxChallengeTranscriptBytes,
      limits.maxHandshakeProposalBytes,
      "maxChallengeTranscriptBytes",
      true,
      limits.maxHandshakeProposalBytes,
    ),
    maxCallerSessions: configuredNumber(
      options.maxCallerSessions,
      maxCallerSessions,
      "maxCallerSessions",
      true,
      maxCallerSessions,
    ),
    maxCallerSessionBytes: limits.maxCallerSessionBytes,
    maxCallerSessionsBytes: limits.maxCallerSessionsBytes,
  });
}

/** Parse one bounded credential-free HTTP or websocket hello endpoint. */
function parseEndpoint(value: string): URL | null {
  if (value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }
    canonicalHttpTarget(url);
    return url;
  } catch {
    return null;
  }
}

/** Build the only broker and application selection supported during Phase 1. */
function fixedProposal(appRevision: number): BrokerHelloProposal {
  return Object.freeze({
    brokerRevision: SESSION_BROKER_PROTOCOL_REVISION,
    appRevision,
    features: Object.freeze([]),
  });
}

/** Produce the canonical path and RFC 3986 encoded sorted query covered by request signatures. */
export function canonicalHttpTarget(url: URL): string {
  const encode = (value: string) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const decode = (value: string, plusAsSpace: boolean) =>
    decodeURIComponent(plusAsSpace ? value.replaceAll("+", "%20") : value);

  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const pairs = rawQuery
    ? rawQuery
        .split("&")
        .map((pair) => {
          const separator = pair.indexOf("=");
          const rawKey = separator < 0 ? pair : pair.slice(0, separator);
          const rawValue = separator < 0 ? "" : pair.slice(separator + 1);
          return [encode(decode(rawKey, true)), encode(decode(rawValue, true))] as const;
        })
        .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
          leftKey === rightKey
            ? leftValue < rightValue
              ? -1
              : leftValue > rightValue
                ? 1
                : 0
            : leftKey < rightKey
              ? -1
              : 1,
        )
    : [];
  const path = url.pathname
    .split("/")
    .map((segment) => encode(decode(segment, false)))
    .join("/");
  const query = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  return query ? `${path}?${query}` : path;
}

export interface SessionBrokerHelloAuthenticator {
  issueChallenge(request: unknown, listenerEndpoint: string): Promise<SessionBrokerHelloChallenge>;
  completeCallerHello(proofInput: unknown): Promise<AuthenticatedCallerSession>;
  completeProducerHello(
    proofInput: unknown,
    connectionId: unknown,
  ): Promise<AuthenticatedProducerHello>;
}

/** Authenticate bounded producer hellos and generation-bound signed caller request sessions. */
export class SessionBrokerAuthenticator
  implements CallerRequestAuthenticator, SessionBrokerHelloAuthenticator
{
  private readonly crypto: SessionBrokerCrypto;
  private readonly config: AuthenticatorSnapshot;
  private readonly credentials: Map<string, SessionBrokerCredential>;
  private readonly challenges = new Map<string, PendingChallenge>();
  private readonly callerSessions = new Map<string, CallerSessionRecord>();
  private readonly reservedChallengeIds = new Set<string>();
  private readonly reservedCallerSessionIds = new Set<string>();
  private readonly challengeCountBudget: ResourceBudget;
  private readonly challengeBudget: ResourceBudget;
  private readonly callerSessionCountBudget: ResourceBudget;
  private readonly callerSessionByteBudget: ResourceBudget;
  private clearEpoch = 0;

  constructor(options: SessionBrokerAuthenticatorOptions) {
    this.config = copyOptions(options);
    this.crypto = copyCrypto(options.crypto);
    this.credentials = copyCredentials(options.credentials, this.config.appId);
    this.challengeCountBudget = new ResourceBudget(
      this.config.maxChallenges,
      "maxIncompleteHandshakes",
    );
    this.challengeBudget = new ResourceBudget(this.config.maxChallengeBytes, "challengeBytes");
    this.callerSessionCountBudget = new ResourceBudget(
      this.config.maxCallerSessions,
      "maxCallerSessions",
    );
    this.callerSessionByteBudget = new ResourceBudget(
      this.config.maxCallerSessionsBytes,
      "maxCallerSessionsBytes",
    );
  }

  /** Issue one bounded, expiring challenge signed by the daemon identity. */
  async issueChallenge(
    request: unknown,
    listenerEndpoint: string,
  ): Promise<SessionBrokerHelloChallenge> {
    const epoch = this.clearEpoch;
    this.pruneExpired();
    const normalized = this.validateHello(request, listenerEndpoint);
    const credential = this.credentials.get(
      `${normalized.role}:${normalized.keyId}:${normalized.grantId}`,
    );
    if (!credential || credential.grant.kind !== normalized.role) {
      authenticationError("invalid-credential");
    }
    this.requireActiveGrant(credential.grant);

    const challengeId = this.uniqueId(
      (id) => this.challenges.has(id) || this.reservedChallengeIds.has(id),
    );
    const responderNonce = this.randomId();
    const expiresAt = this.currentTime() + this.config.challengeTtlMs;
    if (!Number.isFinite(expiresAt)) authenticationError("invalid-credential");
    const transcript = buildBrokerChallengeTranscript({
      ...normalized,
      generation: this.config.generation,
      responderNonce,
    });
    const retainedBytes = retainedRecordBytes(
      [challengeId, normalized, credential.grant, transcript, expiresAt],
      CHALLENGE_RECORD_OVERHEAD_BYTES,
    );
    if (retainedBytes > this.config.maxChallengeTranscriptBytes) {
      authenticationError("authentication-capacity");
    }
    const reservation = new ReservationGroup();
    try {
      reservation.add(this.challengeCountBudget.reserve());
      reservation.add(this.challengeBudget.reserve(retainedBytes));
    } catch {
      reservation.release();
      authenticationError("authentication-capacity");
    }
    this.reservedChallengeIds.add(challengeId);
    let committed = false;
    try {
      const daemonSignature = encodeBase64Url(
        await this.crypto.sign(this.config.daemonIdentity.privateKey, transcript),
      );
      this.assertClearEpoch(epoch);
      this.challenges.set(challengeId, {
        request: normalized,
        transcript,
        grant: credential.grant,
        publicKey: credential.publicKey,
        expiresAt,
        reservation,
      });
      committed = true;
      return Object.freeze({
        challengeId,
        generation: this.config.generation,
        responderNonce,
        expiresAt,
        daemonKeyId: this.config.daemonIdentity.keyId,
        daemonSignature,
      });
    } catch {
      return authenticationError("invalid-credential");
    } finally {
      this.reservedChallengeIds.delete(challengeId);
      if (!committed) reservation.release();
    }
  }

  /** Consume one caller proof and issue a short-lived replay-protected caller session. */
  async completeCallerHello(proofInput: unknown): Promise<AuthenticatedCallerSession> {
    const epoch = this.clearEpoch;
    const proof = this.parseHelloProof(proofInput);
    const pending = this.takeChallenge(proof.challengeId, "caller");
    try {
      await this.verifyProof(pending, proof.signature);
      this.assertClearEpoch(epoch);
      const grant = pending.grant as CallerGrant;
      this.requireActiveGrant(grant);
      this.pruneExpired();
      return await this.createCallerSession(pending, grant, epoch);
    } finally {
      pending.reservation.release();
    }
  }

  private async createCallerSession(
    pending: PendingChallenge,
    grant: CallerGrant,
    epoch: number,
  ): Promise<AuthenticatedCallerSession> {
    const transcriptHash = encodeBase64Url(await this.crypto.sha256(pending.transcript));
    this.assertClearEpoch(epoch);
    const callerSessionId = this.uniqueId(
      (id) => this.callerSessions.has(id) || this.reservedCallerSessionIds.has(id),
    );
    this.reservedCallerSessionIds.add(callerSessionId);
    const reservations = new ReservationGroup();
    let committed = false;
    try {
      const expiresAt = Math.min(
        grant.expiresAt,
        this.currentTime() + this.config.callerSessionTtlMs,
      );
      const principal = principalFromGrant(grant);
      const retainedBytes = retainedRecordBytes(
        [callerSessionId, principal, grant, transcriptHash, expiresAt],
        CALLER_SESSION_RECORD_OVERHEAD_BYTES,
      );
      if (retainedBytes > this.config.maxCallerSessionBytes) {
        authenticationError("authentication-capacity");
      }
      try {
        reservations.add(this.callerSessionCountBudget.reserve());
        reservations.add(this.callerSessionByteBudget.reserve(retainedBytes));
      } catch {
        authenticationError("authentication-capacity");
      }
      const daemonSignature = encodeBase64Url(
        await this.crypto.sign(
          this.config.daemonIdentity.privateKey,
          buildBrokerHelloAckTranscript({
            role: "caller",
            appId: this.config.appId,
            generation: this.config.generation,
            keyId: grant.keyId,
            grantId: grant.grantId,
            helloTranscriptHash: transcriptHash,
            selection: pending.request.proposal,
            callerSessionId,
            initialSequence: "1",
          }),
        ),
      );
      this.assertClearEpoch(epoch);
      this.callerSessions.set(callerSessionId, {
        principal,
        grant,
        publicKey: pending.publicKey,
        helloTranscriptHash: transcriptHash,
        expiresAt,
        replay: new CallerSequenceReplayWindow(),
        reservation: reservations,
      });
      committed = true;
      return Object.freeze({
        callerSessionId,
        principal,
        expiresAt,
        initialSequence: "1",
        brokerRevision: SESSION_BROKER_PROTOCOL_REVISION,
        appRevision: this.config.appRevision,
        features: Object.freeze([]) as readonly [],
        helloTranscriptHash: transcriptHash,
        daemonKeyId: this.config.daemonIdentity.keyId,
        daemonSignature,
      });
    } finally {
      this.reservedCallerSessionIds.delete(callerSessionId);
      if (!committed) reservations.release();
    }
  }

  /** Consume one producer proof and sign the connection binding supplied by the adapter. */
  async completeProducerHello(
    proofInput: unknown,
    connectionId: unknown,
  ): Promise<AuthenticatedProducerHello> {
    const epoch = this.clearEpoch;
    const proof = this.parseHelloProof(proofInput);
    if (!isValidBrokerIdentifier(connectionId)) authenticationError("invalid-credential");
    const pending = this.takeChallenge(proof.challengeId, "producer");
    try {
      await this.verifyProof(pending, proof.signature);
      this.assertClearEpoch(epoch);
      const grant = pending.grant as ProducerGrant;
      this.requireActiveGrant(grant);
      const helloTranscriptHash = encodeBase64Url(await this.crypto.sha256(pending.transcript));
      this.assertClearEpoch(epoch);
      const daemonSignature = encodeBase64Url(
        await this.crypto.sign(
          this.config.daemonIdentity.privateKey,
          buildBrokerHelloAckTranscript({
            role: "producer",
            appId: this.config.appId,
            generation: this.config.generation,
            keyId: grant.keyId,
            grantId: grant.grantId,
            helloTranscriptHash,
            selection: pending.request.proposal,
            connectionId,
          }),
        ),
      );
      this.assertClearEpoch(epoch);
      this.requireActiveGrant(grant);
      const assertActive = () => {
        this.assertClearEpoch(epoch);
        this.requireActiveGrant(grant);
      };
      const ack: SessionBrokerProducerHelloAck = Object.freeze({
        principal: principalFromGrant(grant),
        connectionId,
        brokerRevision: SESSION_BROKER_PROTOCOL_REVISION,
        appRevision: this.config.appRevision,
        features: Object.freeze([]) as readonly [],
        helloTranscriptHash,
        daemonKeyId: this.config.daemonIdentity.keyId,
        daemonSignature,
      });
      return Object.freeze({ ack, assertActive });
    } finally {
      pending.reservation.release();
    }
  }

  /** Verify one signed HTTP request and atomically admit its sequence before returning authority. */
  async authenticate({
    request,
    body,
  }: CallerRequestAuthenticationInput): Promise<AuthenticatedCallerRequest> {
    this.pruneExpired();
    const callerSessionId = request.headers.get("x-session-broker-caller-session");
    const requestId = request.headers.get("x-session-broker-request-id");
    const sequence = request.headers.get("x-session-broker-sequence");
    const encodedSignature = request.headers.get("x-session-broker-signature");
    if (!callerSessionId || !requestId || !sequence || !encodedSignature) {
      authenticationError("authentication-required");
    }
    if (!isValidBrokerIdentifier(callerSessionId) || !isValidBrokerIdentifier(requestId)) {
      authenticationError("invalid-signature");
    }
    const session = this.callerSessions.get(callerSessionId);
    if (!session) authenticationError("caller-session-expired");
    try {
      this.requireActiveGrant(session.grant);
    } catch (error) {
      this.deleteCallerSession(callerSessionId);
      throw error;
    }
    if (this.currentTime() >= session.expiresAt) {
      this.deleteCallerSession(callerSessionId);
      authenticationError("caller-session-expired");
    }

    const signature = decodeBase64Url(encodedSignature);
    if (!signature || signature.byteLength === 0) authenticationError("invalid-signature");
    const bodyDigest = encodeBase64Url(await this.crypto.sha256(body));
    let target: string;
    try {
      const url = new URL(request.url);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username ||
        url.password ||
        url.hash
      ) {
        authenticationError("invalid-signature");
      }
      target = canonicalHttpTarget(url);
    } catch {
      authenticationError("invalid-signature");
    }
    const transcript = buildCallerRequestTranscript({
      appId: this.config.appId,
      generation: this.config.generation,
      callerSessionId,
      keyId: session.grant.keyId,
      grantId: session.grant.grantId,
      helloTranscriptHash: session.helloTranscriptHash,
      method: request.method,
      target,
      bodyDigest,
      requestId,
      sequence,
    });
    if (!(await this.crypto.verify(session.publicKey, signature, transcript))) {
      authenticationError("invalid-signature");
    }
    this.assertCallerSessionActive(callerSessionId, session);
    if (session.replay.admit(sequence) !== "accepted") {
      authenticationError("replay-rejected");
    }

    const principal = session.principal;
    const epoch = this.clearEpoch;
    const assertActive = () => {
      this.assertClearEpoch(epoch);
      this.assertCallerSessionActive(callerSessionId, session);
    };
    return Object.freeze({
      principal,
      requestId,
      assertActive,
      signResponse: (input: CallerResponseSigningInput) =>
        this.signResponse(callerSessionId, requestId, sequence, input, assertActive),
    });
  }

  /** Revoke one in-memory caller session without exposing whether it previously existed. */
  revokeCallerSession(callerSessionId: string): void {
    this.deleteCallerSession(callerSessionId);
  }

  /** Release every retained authentication record during shutdown or credential reload. */
  clear(): void {
    this.clearEpoch += 1;
    for (const id of this.challenges.keys()) this.deleteChallenge(id);
    for (const id of this.callerSessions.keys()) this.deleteCallerSession(id);
    // Deferred crypto still retains its transcript, key inputs, and reserved identities. Their
    // reservations and ids remain live until each operation observes the epoch change and settles,
    // preventing clear/reload loops from exceeding resource or uniqueness ceilings.
  }

  /** Reject authority that crossed a credential-clear lifecycle boundary. */
  private assertClearEpoch(epoch: number): void {
    if (epoch !== this.clearEpoch) authenticationError("invalid-credential");
  }

  /** Recheck identity, revocation, and expiry after every asynchronous policy boundary. */
  private assertCallerSessionActive(callerSessionId: string, session: CallerSessionRecord): void {
    if (this.callerSessions.get(callerSessionId) !== session) {
      authenticationError("caller-session-expired");
    }
    try {
      this.requireActiveGrant(session.grant);
    } catch (error) {
      this.deleteCallerSession(callerSessionId);
      throw error;
    }
    if (this.currentTime() >= session.expiresAt) {
      this.deleteCallerSession(callerSessionId);
      authenticationError("caller-session-expired");
    }
  }

  private async signResponse(
    callerSessionId: string,
    requestId: string,
    sequence: string,
    input: CallerResponseSigningInput,
    assertActive: () => void,
  ): Promise<SessionBrokerResponseAuthentication> {
    assertActive();
    if (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599) {
      authenticationError("invalid-credential");
    }
    if (
      input.appContract &&
      (input.appContract.appRevision !== this.config.appRevision ||
        !Array.isArray(input.appContract.features) ||
        input.appContract.features.length !== 0)
    ) {
      authenticationError("invalid-credential");
    }
    const appContract = input.appContract
      ? Object.freeze({ appRevision: this.config.appRevision, features: Object.freeze([]) })
      : undefined;
    const bodyDigest = encodeBase64Url(await this.crypto.sha256(canonicalJsonBytes(input.body)));
    assertActive();
    const transcript = buildBrokerResponseTranscript({
      appId: this.config.appId,
      generation: this.config.generation,
      brokerRevision: SESSION_BROKER_PROTOCOL_REVISION,
      callerSessionId,
      requestId,
      sequence,
      httpStatus: input.httpStatus,
      bodyDigest,
      ...(appContract ? { appContract } : {}),
    });
    const daemonSignature = encodeBase64Url(
      await this.crypto.sign(this.config.daemonIdentity.privateKey, transcript),
    );
    assertActive();
    return Object.freeze({
      generation: this.config.generation,
      brokerRevision: SESSION_BROKER_PROTOCOL_REVISION,
      ...(appContract ? { appContract } : {}),
      callerSessionId,
      requestId,
      sequence,
      httpStatus: input.httpStatus,
      bodyDigest,
      daemonKeyId: this.config.daemonIdentity.keyId,
      daemonSignature,
    });
  }

  private validateHello(
    value: unknown,
    listenerEndpoint: string,
  ): SessionBrokerHelloChallengeRequest {
    try {
      const request = parseExactBrokerRecord(value, [
        "role",
        "appId",
        "endpoint",
        "keyId",
        "grantId",
        "initiatorNonce",
        "proposal",
      ] as const);
      const proposal = parseExactBrokerRecord(request.proposal, [
        "brokerRevision",
        "appRevision",
        "features",
      ] as const);
      if (
        (request.role !== "producer" && request.role !== "caller") ||
        request.appId !== this.config.appId ||
        request.endpoint !== listenerEndpoint ||
        typeof request.endpoint !== "string" ||
        !parseEndpoint(request.endpoint) ||
        !parseEndpoint(listenerEndpoint) ||
        proposal.brokerRevision !== SESSION_BROKER_PROTOCOL_REVISION ||
        proposal.appRevision !== this.config.appRevision ||
        !Array.isArray(proposal.features) ||
        proposal.features.length !== 0
      ) {
        authenticationError("invalid-credential");
      }
      return Object.freeze({
        role: request.role,
        appId: this.config.appId,
        endpoint: request.endpoint,
        keyId: parseBrokerIdentifier(request.keyId),
        grantId: parseBrokerIdentifier(request.grantId),
        initiatorNonce: parseBrokerIdentifier(request.initiatorNonce),
        proposal: fixedProposal(this.config.appRevision),
      });
    } catch {
      return authenticationError("invalid-credential");
    }
  }

  /** Parse one exact proof envelope before consuming challenge state. */
  private parseHelloProof(value: unknown): SessionBrokerHelloProof {
    try {
      const proof = parseExactBrokerRecord(value, ["challengeId", "signature"] as const);
      return {
        challengeId: parseBrokerIdentifier(proof.challengeId),
        signature: parseBrokerString(proof.signature, { maxBytes: 1_024 }),
      };
    } catch {
      return authenticationError("invalid-credential");
    }
  }

  private takeChallenge(challengeId: string, role: BrokerGrant["kind"]): PendingChallenge {
    if (!isValidBrokerIdentifier(challengeId)) authenticationError("challenge-used");
    const pending = this.challenges.get(challengeId);
    if (!pending) authenticationError("challenge-used");
    // Remove lookup authority before asynchronous verification so a second proof cannot consume it.
    // The count/byte reservation remains live until the consuming proof completes.
    this.challenges.delete(challengeId);
    try {
      if (this.currentTime() >= pending.expiresAt) authenticationError("challenge-expired");
      if (pending.grant.kind !== role) authenticationError("invalid-credential");
      return pending;
    } catch (error) {
      pending.reservation.release();
      throw error;
    }
  }

  private async verifyProof(pending: PendingChallenge, encodedSignature: string): Promise<void> {
    const signature = decodeBase64Url(encodedSignature);
    if (
      !signature ||
      signature.byteLength === 0 ||
      !(await this.crypto.verify(pending.publicKey, signature, pending.transcript))
    ) {
      authenticationError("invalid-signature");
    }
  }

  private requireActiveGrant(grant: BrokerGrant): void {
    let revoked = false;
    try {
      revoked = this.config.isRevoked?.(grant.revocationId) ?? false;
    } catch {
      authenticationError("invalid-credential");
    }
    if (revoked) authenticationError("credential-revoked");
    if (!isGrantActive(grant, { appId: this.config.appId, now: this.currentTime() })) {
      authenticationError("credential-expired");
    }
  }

  private currentTime(): number {
    let now: number;
    try {
      now = this.config.now();
    } catch {
      authenticationError("invalid-credential");
    }
    if (!Number.isFinite(now)) authenticationError("invalid-credential");
    return now;
  }

  private deleteChallenge(challengeId: string): void {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return;
    this.challenges.delete(challengeId);
    challenge.reservation.release();
  }

  private deleteCallerSession(callerSessionId: string): void {
    const session = this.callerSessions.get(callerSessionId);
    if (!session) return;
    this.callerSessions.delete(callerSessionId);
    session.reservation.release();
  }

  private pruneExpired(): void {
    const now = this.currentTime();
    for (const [id, challenge] of this.challenges) {
      if (now >= challenge.expiresAt) this.deleteChallenge(id);
    }
    for (const [id, session] of this.callerSessions) {
      if (now >= session.expiresAt) this.deleteCallerSession(id);
    }
  }

  private uniqueId(isReserved: (id: string) => boolean): string {
    for (let attempt = 0; attempt < UNIQUE_ID_RETRIES; attempt += 1) {
      const id = this.randomId();
      if (!isReserved(id)) return id;
    }
    authenticationError("authentication-capacity");
  }

  private randomId(): string {
    let bytes: Uint8Array;
    try {
      bytes = this.crypto.randomBytes(RANDOM_ID_BYTES);
    } catch {
      authenticationError("invalid-credential");
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== RANDOM_ID_BYTES) {
      authenticationError("invalid-credential");
    }
    // Fixed alphanumeric bookends keep generated values inside the public identifier grammar.
    return `b_${encodeBase64Url(bytes)}_0`;
  }
}

/** Build the exact challenge transcript so clients can verify daemon identity before signing. */
export function challengeTranscriptForClient(
  request: SessionBrokerHelloChallengeRequest,
  challenge: Pick<SessionBrokerHelloChallenge, "responderNonce">,
  generation: string,
): Uint8Array {
  return buildBrokerChallengeTranscript({
    ...request,
    generation,
    responderNonce: challenge.responderNonce,
  } satisfies BrokerChallengeTranscriptInput);
}
