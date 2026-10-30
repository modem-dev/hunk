import { canonicalJsonBytes, type CanonicalJsonValue } from "./canonicalJson";

export const SESSION_BROKER_PROTOCOL_REVISION = 1 as const;
export const SESSION_BROKER_SIGNATURE_ALGORITHM = "Ed25519" as const;
export const SESSION_BROKER_AUTH_DOMAIN = "dev.hunk.session-broker.v1" as const;
export const MAX_CALLER_SEQUENCE = 18_446_744_073_709_551_615n;
export const MAX_BROKER_IDENTIFIER_LENGTH = 128;
export const MAX_BROKER_COMMAND_SCOPES = 256;
const REPLAY_BITMAP_MASK = (1n << 64n) - 1n;
const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{0,126}[A-Za-z0-9])?$/;

export type ProducerOperation = "register" | "reconnect";
export type CallerOperation =
  | "list"
  | "get"
  | "dispatch"
  | "diagnostics"
  | "shutdown"
  | "capability:issue";

export interface BrokerCommandScope {
  readonly name: string;
  readonly version: number;
}

interface BrokerGrantBase {
  readonly appId: string;
  readonly principalId: string;
  readonly keyId: string;
  readonly grantId: string;
  readonly algorithm: typeof SESSION_BROKER_SIGNATURE_ALGORITHM;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revocationId: string;
  readonly mayDelegate: boolean;
}

export interface ProducerGrant extends BrokerGrantBase {
  readonly kind: "producer";
  readonly sessionId?: string;
  readonly operations: readonly ProducerOperation[];
}

export interface CallerGrant extends BrokerGrantBase {
  readonly kind: "caller";
  readonly sessionId?: string;
  readonly operations: readonly CallerOperation[];
  readonly commands: readonly BrokerCommandScope[];
}

export type BrokerGrant = ProducerGrant | CallerGrant;

export interface ProducerPrincipal {
  readonly kind: "producer";
  readonly appId: string;
  readonly principalId: string;
  readonly keyId: string;
  readonly grantId: string;
  readonly sessionId?: string;
  readonly scopes: readonly ProducerOperation[];
}

export interface CallerPrincipal {
  readonly kind: "caller";
  readonly appId: string;
  readonly principalId: string;
  readonly keyId: string;
  readonly grantId: string;
  readonly sessionId?: string;
  readonly operations: readonly CallerOperation[];
  readonly commands: readonly BrokerCommandScope[];
}

export type BrokerPrincipal = ProducerPrincipal | CallerPrincipal;

export interface BrokerHelloProposal {
  readonly brokerRevision: typeof SESSION_BROKER_PROTOCOL_REVISION;
  readonly appRevision: number;
  readonly features: readonly string[];
}

export interface BrokerAppContract {
  readonly appRevision: number;
  readonly features: readonly string[];
}

export interface BrokerChallengeTranscriptInput {
  readonly role: "producer" | "caller";
  readonly appId: string;
  readonly generation: string;
  readonly endpoint: string;
  readonly keyId: string;
  readonly grantId: string;
  readonly initiatorNonce: string;
  readonly responderNonce: string;
  readonly proposal: BrokerHelloProposal;
}

interface BrokerHelloAckTranscriptBase {
  readonly appId: string;
  readonly generation: string;
  readonly keyId: string;
  readonly grantId: string;
  readonly helloTranscriptHash: string;
  readonly selection: BrokerHelloProposal;
}

export type BrokerHelloAckTranscriptInput = BrokerHelloAckTranscriptBase &
  (
    | { readonly role: "producer"; readonly connectionId: string }
    | {
        readonly role: "caller";
        readonly callerSessionId: string;
        readonly initialSequence: string;
      }
  );

export interface CallerRequestTranscriptInput {
  readonly appId: string;
  readonly generation: string;
  readonly callerSessionId: string;
  readonly keyId: string;
  readonly grantId: string;
  readonly helloTranscriptHash: string;
  readonly method: string;
  readonly target: string;
  readonly bodyDigest: string;
  readonly requestId: string;
  readonly sequence: string;
}

export interface BrokerResponseTranscriptInput {
  readonly appId: string;
  readonly generation: string;
  readonly brokerRevision: typeof SESSION_BROKER_PROTOCOL_REVISION;
  readonly callerSessionId: string;
  readonly requestId: string;
  readonly sequence: string;
  readonly httpStatus: number;
  readonly bodyDigest: string;
  readonly appContract?: BrokerAppContract;
}

/** Return whether a value follows the immutable application identity grammar. */
export function isValidBrokerAppId(value: unknown): value is string {
  return typeof value === "string" && APP_ID_PATTERN.test(value);
}

/** Return whether a value follows the bounded opaque broker identifier grammar. */
export function isValidBrokerIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

/** Return whether a value is a supported positive integer protocol or command revision. */
export function isValidBrokerRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
export function freezeBrokerGrant<Grant extends BrokerGrant>(grant: Grant): Grant {
  const commands =
    grant.kind === "caller"
      ? grant.commands.map((scope) => Object.freeze({ ...scope }))
      : undefined;
  return Object.freeze({
    ...grant,
    operations: Object.freeze([...grant.operations]),
    ...(commands ? { commands: Object.freeze(commands) } : {}),
  }) as unknown as Grant;
}

/** Project one immutable grant into the redacted principal used by authorization hooks. */
export function principalFromGrant(grant: ProducerGrant): ProducerPrincipal;
export function principalFromGrant(grant: CallerGrant): CallerPrincipal;
export function principalFromGrant(grant: BrokerGrant): BrokerPrincipal {
  if (grant.kind === "producer") {
    return Object.freeze({
      kind: "producer",
      appId: grant.appId,
      principalId: grant.principalId,
      keyId: grant.keyId,
      grantId: grant.grantId,
      ...(grant.sessionId !== undefined ? { sessionId: grant.sessionId } : {}),
      scopes: Object.freeze([...grant.operations]),
    });
  }

  return Object.freeze({
    kind: "caller",
    appId: grant.appId,
    principalId: grant.principalId,
    keyId: grant.keyId,
    grantId: grant.grantId,
    ...(grant.sessionId !== undefined ? { sessionId: grant.sessionId } : {}),
    operations: Object.freeze([...grant.operations]),
    commands: Object.freeze(grant.commands.map((scope) => Object.freeze({ ...scope }))),
  });
}

/** Return whether a grant is currently valid, app-scoped, and not revoked. */
export function isGrantActive(
  grant: BrokerGrant,
  facts: { appId: string; now: number; isRevoked?: (revocationId: string) => boolean },
): boolean {
  return (
    grant.appId === facts.appId &&
    grant.issuedAt <= facts.now &&
    facts.now < grant.expiresAt &&
    !facts.isRevoked?.(grant.revocationId)
  );
}

/** Return whether a delegated grant is an immutable subset of its parent authority. */
export function isGrantNarrowing(parent: BrokerGrant, child: BrokerGrant): boolean {
  if (
    !parent.mayDelegate ||
    parent.kind !== child.kind ||
    parent.appId !== child.appId ||
    child.issuedAt < parent.issuedAt ||
    child.expiresAt > parent.expiresAt ||
    (parent.sessionId !== undefined && child.sessionId !== parent.sessionId) ||
    child.operations.some(
      (operation) => !(parent.operations as readonly string[]).includes(operation),
    )
  ) {
    return false;
  }
  if (parent.kind === "producer" || child.kind === "producer") {
    return parent.kind === child.kind;
  }
  return child.commands.every((childScope) =>
    parent.commands.some(
      (parentScope) =>
        parentScope.name === childScope.name && parentScope.version === childScope.version,
    ),
  );
}

/** Check producer operation and session authority without an allow-by-default path. */
export function producerPrincipalAllows(
  principal: ProducerPrincipal,
  facts: { appId: string; operation: ProducerOperation; sessionId?: string },
): boolean {
  return (
    principal.appId === facts.appId &&
    principal.scopes.includes(facts.operation) &&
    (principal.sessionId === undefined || principal.sessionId === facts.sessionId)
  );
}

/** Check caller operation, session, and command authority without an allow-by-default path. */
export function callerPrincipalAllows(
  principal: CallerPrincipal,
  facts: {
    appId: string;
    operation: CallerOperation;
    sessionId?: string;
    command?: string;
    commandVersion?: number;
  },
): boolean {
  if (principal.appId !== facts.appId || !principal.operations.includes(facts.operation)) {
    return false;
  }
  if (principal.sessionId !== undefined && principal.sessionId !== facts.sessionId) {
    return false;
  }
  if (facts.operation !== "dispatch") {
    return true;
  }
  if (!facts.command) {
    return false;
  }
  return principal.commands.some(
    (scope) => scope.name === facts.command && scope.version === facts.commandVersion,
  );
}

/** Build the deterministic, domain-separated producer or caller hello transcript. */
export function buildBrokerChallengeTranscript(input: BrokerChallengeTranscriptInput): Uint8Array {
  return canonicalJsonBytes({
    appId: input.appId,
    domain: `${SESSION_BROKER_AUTH_DOMAIN}/${input.role}-hello`,
    endpoint: input.endpoint,
    generation: input.generation,
    grantId: input.grantId,
    initiatorNonce: input.initiatorNonce,
    keyId: input.keyId,
    proposal: {
      appRevision: input.proposal.appRevision,
      brokerRevision: input.proposal.brokerRevision,
      features: [...input.proposal.features].sort(),
    },
    responderNonce: input.responderNonce,
  });
}

/** Build the signed hello acknowledgement binding identity, selection, and connection/session. */
export function buildBrokerHelloAckTranscript(input: BrokerHelloAckTranscriptInput): Uint8Array {
  const binding: Record<string, string> =
    input.role === "producer"
      ? { connectionId: input.connectionId }
      : {
          callerSessionId: input.callerSessionId,
          initialSequence: input.initialSequence,
        };
  return canonicalJsonBytes({
    appId: input.appId,
    ...binding,
    domain: `${SESSION_BROKER_AUTH_DOMAIN}/${input.role}-hello-ack`,
    generation: input.generation,
    grantId: input.grantId,
    helloTranscriptHash: input.helloTranscriptHash,
    keyId: input.keyId,
    selection: {
      appRevision: input.selection.appRevision,
      brokerRevision: input.selection.brokerRevision,
      features: [...input.selection.features].sort(),
    },
  });
}

/** Build the deterministic, domain-separated signed HTTP caller request transcript. */
export function buildCallerRequestTranscript(input: CallerRequestTranscriptInput): Uint8Array {
  return canonicalJsonBytes({
    appId: input.appId,
    bodyDigest: input.bodyDigest,
    callerSessionId: input.callerSessionId,
    domain: `${SESSION_BROKER_AUTH_DOMAIN}/caller-request`,
    generation: input.generation,
    grantId: input.grantId,
    helloTranscriptHash: input.helloTranscriptHash,
    keyId: input.keyId,
    method: input.method.toUpperCase(),
    requestId: input.requestId,
    sequence: input.sequence,
    target: input.target,
  } satisfies CanonicalJsonValue);
}

/** Build the signed response transcript binding status and the structured body digest. */
export function buildBrokerResponseTranscript(input: BrokerResponseTranscriptInput): Uint8Array {
  return canonicalJsonBytes({
    appId: input.appId,
    ...(input.appContract
      ? {
          appContract: {
            appRevision: input.appContract.appRevision,
            features: [...input.appContract.features].sort(),
          },
        }
      : {}),
    bodyDigest: input.bodyDigest,
    brokerRevision: input.brokerRevision,
    callerSessionId: input.callerSessionId,
    domain: `${SESSION_BROKER_AUTH_DOMAIN}/caller-response`,
    generation: input.generation,
    httpStatus: input.httpStatus,
    requestId: input.requestId,
    sequence: input.sequence,
  });
}

/** Parse the canonical decimal uint64 representation used by caller replay admission. */
export function parseCallerSequence(value: string): bigint | null {
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    return null;
  }
  const sequence = BigInt(value);
  return sequence <= MAX_CALLER_SEQUENCE ? sequence : null;
}

/** Allocate canonical caller sequences monotonically and stop rather than wrapping at uint64 max. */
export class CallerSequenceAllocator {
  private next: bigint;

  constructor(initialNext = 1n) {
    if (initialNext < 1n || initialNext > MAX_CALLER_SEQUENCE) {
      throw new RangeError("Invalid initial caller sequence.");
    }
    this.next = initialNext;
  }

  allocate(): string | null {
    if (this.next > MAX_CALLER_SEQUENCE) return null;
    const allocated = this.next;
    this.next += 1n;
    return allocated.toString();
  }
}

export type CallerSequenceAdmission =
  | "accepted"
  | "zero"
  | "duplicate"
  | "too-old"
  | "too-far-ahead"
  | "invalid";

/** Atomically admit canonical caller sequences through the contract's 64-value replay bitmap. */
export class CallerSequenceReplayWindow {
  private highest: bigint;
  private bitmap: bigint;

  constructor(initial: { highest: bigint; bitmap: bigint } = { highest: 0n, bitmap: 0n }) {
    if (
      initial.highest < 0n ||
      initial.highest > MAX_CALLER_SEQUENCE ||
      initial.bitmap < 0n ||
      initial.bitmap > REPLAY_BITMAP_MASK
    ) {
      throw new RangeError("Invalid caller replay window state.");
    }
    this.highest = initial.highest;
    this.bitmap = initial.bitmap;
  }

  admit(canonicalSequence: string): CallerSequenceAdmission {
    const sequence = parseCallerSequence(canonicalSequence);
    if (sequence === null) return "invalid";
    if (sequence === 0n) return "zero";

    if (sequence <= this.highest) {
      const distance = this.highest - sequence;
      if (distance >= 64n) return "too-old";
      const bit = 1n << distance;
      if ((this.bitmap & bit) !== 0n) return "duplicate";
      this.bitmap = (this.bitmap | bit) & REPLAY_BITMAP_MASK;
      return "accepted";
    }

    const delta = sequence - this.highest;
    if (delta > 64n) return "too-far-ahead";
    this.bitmap = delta === 64n ? 0n : (this.bitmap << delta) & REPLAY_BITMAP_MASK;
    this.highest = sequence;
    this.bitmap |= 1n;
    return "accepted";
  }

  /** Return a read-only diagnostic snapshot containing no credential material. */
  snapshot() {
    return { highest: this.highest.toString(), bitmap: this.bitmap.toString(16) } as const;
  }
}
