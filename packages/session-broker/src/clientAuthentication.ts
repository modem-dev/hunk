import {
  CallerSequenceAllocator,
  DEFAULT_SESSION_BROKER_LIMITS,
  SESSION_BROKER_PROTOCOL_REVISION,
  buildBrokerHelloAckTranscript,
  buildBrokerResponseTranscript,
  buildCallerRequestTranscript,
  canonicalJsonBytes,
  isValidBrokerIdentifier,
  type BrokerGrant,
  type BrokerHelloProposal,
  type CallerGrant,
  type CanonicalJsonValue,
  type ProducerGrant,
} from "@hunk/session-broker-core";
import {
  canonicalHttpTarget,
  challengeTranscriptForClient,
  type AuthenticatedCallerSession,
  type SessionBrokerProducerHelloAck,
  type SessionBrokerHelloChallenge,
  type SessionBrokerHelloChallengeRequest,
} from "./authentication";
import {
  decodeBase64Url,
  encodeBase64Url,
  webSessionBrokerCrypto,
  type SessionBrokerCrypto,
} from "./crypto";
import type { SessionBrokerAuthenticatedResponse } from "./types";

export interface SessionBrokerClientCredential<Grant extends BrokerGrant> {
  readonly grant: Grant;
  readonly privateKey: CryptoKey;
}

export interface SessionBrokerDaemonVerifier {
  readonly keyId: string;
  readonly publicKey: CryptoKey;
}

export interface SessionBrokerHelloClientOptions<Grant extends ProducerGrant | CallerGrant> {
  readonly appId: string;
  readonly appRevision: number;
  readonly endpoint: string;
  readonly credential: SessionBrokerClientCredential<Grant>;
  readonly daemon: SessionBrokerDaemonVerifier;
  readonly crypto?: SessionBrokerCrypto;
}

export interface PendingSessionBrokerHello<Grant extends ProducerGrant | CallerGrant> {
  readonly request: SessionBrokerHelloChallengeRequest;
  readonly transcript: Uint8Array;
  readonly transcriptHash: string;
  readonly proof: { readonly challengeId: string; readonly signature: string };
  readonly challenge: SessionBrokerHelloChallenge;
  readonly options: SessionBrokerHelloClientOptions<Grant>;
}

export class SessionBrokerClientAuthenticationError extends Error {
  constructor() {
    super("Session broker authentication failed or the daemon identity could not be verified.");
    this.name = "SessionBrokerClientAuthenticationError";
  }
}

function clientAuthError(): never {
  throw new SessionBrokerClientAuthenticationError();
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) clientAuthError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) clientAuthError();
  const record = value as Record<string, unknown>;
  const ownKeys = Object.keys(record);
  if (
    ownKeys.some((key) => ["__proto__", "prototype", "constructor"].includes(key)) ||
    ownKeys.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    ownKeys.some((key) => !keys.includes(key))
  )
    clientAuthError();
  return record;
}

function parseChallenge(value: unknown): SessionBrokerHelloChallenge {
  const record = exactRecord(value, [
    "challengeId",
    "generation",
    "responderNonce",
    "expiresAt",
    "daemonKeyId",
    "daemonSignature",
  ]);
  if (
    !isValidBrokerIdentifier(record.challengeId) ||
    !isValidBrokerIdentifier(record.generation) ||
    !isValidBrokerIdentifier(record.responderNonce) ||
    !Number.isFinite(record.expiresAt) ||
    typeof record.daemonKeyId !== "string" ||
    typeof record.daemonSignature !== "string"
  )
    clientAuthError();
  return record as unknown as SessionBrokerHelloChallenge;
}

function randomId(cryptoImpl: SessionBrokerCrypto) {
  return `b_${encodeBase64Url(cryptoImpl.randomBytes(24))}_0`;
}

function fixedProposal(appRevision: number): BrokerHelloProposal {
  return {
    brokerRevision: SESSION_BROKER_PROTOCOL_REVISION,
    appRevision,
    features: [],
  };
}

/** Create the credential-free hello proposal that starts either producer or caller authentication. */
export function createSessionBrokerHelloRequest<Grant extends ProducerGrant | CallerGrant>(
  options: SessionBrokerHelloClientOptions<Grant>,
): SessionBrokerHelloChallengeRequest {
  const cryptoImpl = options.crypto ?? webSessionBrokerCrypto;
  return Object.freeze({
    role: options.credential.grant.kind,
    appId: options.appId,
    endpoint: options.endpoint,
    keyId: options.credential.grant.keyId,
    grantId: options.credential.grant.grantId,
    initiatorNonce: randomId(cryptoImpl),
    proposal: fixedProposal(options.appRevision),
  });
}

/** Verify the daemon challenge before signing the same generation-bound transcript. */
export async function answerSessionBrokerHelloChallenge<Grant extends ProducerGrant | CallerGrant>(
  options: SessionBrokerHelloClientOptions<Grant>,
  request: SessionBrokerHelloChallengeRequest,
  challenge: SessionBrokerHelloChallenge,
): Promise<PendingSessionBrokerHello<Grant>> {
  const cryptoImpl = options.crypto ?? webSessionBrokerCrypto;
  if (
    challenge.daemonKeyId !== options.daemon.keyId ||
    !isValidBrokerIdentifier(challenge.challengeId) ||
    !isValidBrokerIdentifier(challenge.generation) ||
    !isValidBrokerIdentifier(challenge.responderNonce) ||
    !Number.isFinite(challenge.expiresAt) ||
    Date.now() >= challenge.expiresAt
  )
    clientAuthError();
  const transcript = challengeTranscriptForClient(request, challenge, challenge.generation);
  const daemonSignature = decodeBase64Url(challenge.daemonSignature);
  if (
    !daemonSignature ||
    !(await cryptoImpl.verify(options.daemon.publicKey, daemonSignature, transcript))
  ) {
    clientAuthError();
  }
  const signature = encodeBase64Url(
    await cryptoImpl.sign(options.credential.privateKey, transcript),
  );
  return Object.freeze({
    request,
    transcript,
    transcriptHash: encodeBase64Url(await cryptoImpl.sha256(transcript)),
    proof: Object.freeze({ challengeId: challenge.challengeId, signature }),
    challenge,
    options,
  });
}

/** Verify a signed producer acknowledgement against the authenticated hello transcript. */
export async function verifyProducerHelloAck(
  pending: PendingSessionBrokerHello<ProducerGrant>,
  ack: SessionBrokerProducerHelloAck,
): Promise<void> {
  exactRecord(ack, [
    "principal",
    "connectionId",
    "brokerRevision",
    "appRevision",
    "features",
    "helloTranscriptHash",
    "daemonKeyId",
    "daemonSignature",
  ]);
  const grant = pending.options.credential.grant;
  const principal = exactRecord(ack.principal, [
    "kind",
    "appId",
    "principalId",
    "keyId",
    "grantId",
    "scopes",
    ...(grant.sessionId ? ["sessionId"] : []),
  ]);
  const cryptoImpl = pending.options.crypto ?? webSessionBrokerCrypto;
  if (
    principal.kind !== "producer" ||
    principal.appId !== grant.appId ||
    principal.principalId !== grant.principalId ||
    principal.keyId !== grant.keyId ||
    principal.grantId !== grant.grantId ||
    principal.sessionId !== grant.sessionId ||
    JSON.stringify(principal.scopes) !== JSON.stringify(grant.operations) ||
    ack.daemonKeyId !== pending.options.daemon.keyId ||
    ack.helloTranscriptHash !== pending.transcriptHash ||
    ack.brokerRevision !== SESSION_BROKER_PROTOCOL_REVISION ||
    ack.appRevision !== pending.options.appRevision ||
    !Array.isArray(ack.features) ||
    ack.features.length !== 0 ||
    !isValidBrokerIdentifier(ack.connectionId)
  )
    clientAuthError();
  const signature = decodeBase64Url(ack.daemonSignature);
  if (
    !signature ||
    !(await cryptoImpl.verify(
      pending.options.daemon.publicKey,
      signature,
      buildBrokerHelloAckTranscript({
        role: "producer",
        appId: pending.options.appId,
        generation: pending.challenge.generation,
        keyId: pending.options.credential.grant.keyId,
        grantId: pending.options.credential.grant.grantId,
        helloTranscriptHash: pending.transcriptHash,
        selection: fixedProposal(pending.options.appRevision),
        connectionId: ack.connectionId,
      }),
    ))
  )
    clientAuthError();
}

export type SessionBrokerSignedRequestInit = Omit<RequestInit, "body"> & {
  readonly body?: string | null;
};

export interface SessionBrokerCallerClientOptions {
  readonly appId: string;
  readonly appRevision: number;
  readonly origin: string;
  readonly credential: SessionBrokerClientCredential<CallerGrant>;
  readonly daemon: SessionBrokerDaemonVerifier;
  readonly fetch?: typeof fetch;
  readonly crypto?: SessionBrokerCrypto;
  readonly challengePath?: string;
  readonly proofPath?: string;
  readonly maxResponseBytes?: number;
}

/** Read one untrusted response through a strict byte ceiling before JSON decoding. */
async function readBoundedResponseJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    clientAuthError();
  }
  if (!response.body) clientAuthError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        clientAuthError();
      }
      chunks.push(value);
    }
  } catch {
    clientAuthError();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    clientAuthError();
  }
}

/** Negotiates short-lived caller sessions and signs/verifies every exact HTTP control payload. */
export class SessionBrokerCallerClient {
  private session: AuthenticatedCallerSession | null = null;
  private sequence: CallerSequenceAllocator | null = null;
  private pending: PendingSessionBrokerHello<CallerGrant> | null = null;
  private negotiation: { epoch: number; promise: Promise<void> } | null = null;
  private authenticationEpoch = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly cryptoImpl: SessionBrokerCrypto;

  constructor(private readonly options: SessionBrokerCallerClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.cryptoImpl = options.crypto ?? webSessionBrokerCrypto;
  }

  /** Issue one signed request, renegotiating once after restart, expiry, or replay rejection. */
  async request(
    path: string,
    init: SessionBrokerSignedRequestInit = {},
    options: { readonly targetSpecific?: boolean } = {},
  ): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!this.session || Date.now() >= this.session.expiresAt) {
        await this.ensureNegotiated(init.signal);
      }
      const attemptedSession = this.session;
      const attemptedEpoch = this.authenticationEpoch;
      const response = await this.signedRequest(path, init, options.targetSpecific ?? false);
      if (response === null) {
        if (attempt === 0) {
          // A delayed 401 from an older session must not invalidate recovery another request already
          // completed. Only the request that still owns the current authentication epoch clears it.
          if (this.session === attemptedSession && this.authenticationEpoch === attemptedEpoch) {
            this.clear();
          }
          continue;
        }
        clientAuthError();
      }
      return response;
    }
    clientAuthError();
  }

  clear() {
    this.authenticationEpoch += 1;
    this.session = null;
    this.sequence = null;
    this.pending = null;
    this.negotiation = null;
  }

  /** Share one negotiation while allowing each waiting request to abort independently. */
  private async ensureNegotiated(signal?: AbortSignal | null) {
    if (!this.negotiation) {
      const epoch = this.authenticationEpoch;
      const promise = this.negotiate(epoch).finally(() => {
        if (this.negotiation?.promise === promise) this.negotiation = null;
      });
      this.negotiation = { epoch, promise };
    }
    const promise = this.negotiation.promise;
    if (!signal) return promise;
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      void promise
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private async negotiate(epoch: number) {
    const challengePath = this.options.challengePath ?? "/session-auth/challenge";
    const proofPath = this.options.proofPath ?? "/session-auth/proof";
    const endpoint = `${this.options.origin}${challengePath}`;
    const helloOptions: SessionBrokerHelloClientOptions<CallerGrant> = {
      appId: this.options.appId,
      appRevision: this.options.appRevision,
      endpoint,
      credential: this.options.credential,
      daemon: this.options.daemon,
      crypto: this.cryptoImpl,
    };
    const request = createSessionBrokerHelloRequest(helloOptions);
    const challengeResponse = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!challengeResponse.ok) clientAuthError();
    const challenge = parseChallenge(
      await readBoundedResponseJson(
        challengeResponse,
        this.options.maxResponseBytes ?? DEFAULT_SESSION_BROKER_LIMITS.maxHttpResponseBytes,
      ),
    );
    const pending = await answerSessionBrokerHelloChallenge(helloOptions, request, challenge);
    const proofResponse = await this.fetchImpl(`${this.options.origin}${proofPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pending.proof),
    });
    if (!proofResponse.ok) clientAuthError();
    const sessionValue = await readBoundedResponseJson(
      proofResponse,
      this.options.maxResponseBytes ?? DEFAULT_SESSION_BROKER_LIMITS.maxHttpResponseBytes,
    );
    const sessionRecord = exactRecord(sessionValue, [
      "callerSessionId",
      "principal",
      "expiresAt",
      "initialSequence",
      "brokerRevision",
      "appRevision",
      "features",
      "helloTranscriptHash",
      "daemonKeyId",
      "daemonSignature",
    ]);
    const session = sessionRecord as unknown as AuthenticatedCallerSession;
    await this.verifyCallerAck(pending, session);
    if (epoch !== this.authenticationEpoch) clientAuthError();
    this.pending = pending;
    this.session = session;
    this.sequence = new CallerSequenceAllocator(BigInt(session.initialSequence));
  }

  private async verifyCallerAck(
    pending: PendingSessionBrokerHello<CallerGrant>,
    session: AuthenticatedCallerSession,
  ) {
    const grant = this.options.credential.grant;
    const principal = exactRecord(session.principal, [
      "kind",
      "appId",
      "principalId",
      "keyId",
      "grantId",
      "operations",
      "commands",
      ...(grant.sessionId ? ["sessionId"] : []),
    ]);
    if (
      principal.kind !== "caller" ||
      principal.appId !== grant.appId ||
      principal.principalId !== grant.principalId ||
      principal.keyId !== grant.keyId ||
      principal.grantId !== grant.grantId ||
      principal.sessionId !== grant.sessionId ||
      JSON.stringify(principal.operations) !== JSON.stringify(grant.operations) ||
      JSON.stringify(principal.commands) !== JSON.stringify(grant.commands) ||
      session.daemonKeyId !== this.options.daemon.keyId ||
      session.helloTranscriptHash !== pending.transcriptHash ||
      session.brokerRevision !== SESSION_BROKER_PROTOCOL_REVISION ||
      session.appRevision !== this.options.appRevision ||
      !Array.isArray(session.features) ||
      session.features.length !== 0 ||
      !Number.isFinite(session.expiresAt) ||
      session.initialSequence !== "1" ||
      !isValidBrokerIdentifier(session.callerSessionId)
    )
      clientAuthError();
    const signature = decodeBase64Url(session.daemonSignature);
    if (
      !signature ||
      !(await this.cryptoImpl.verify(
        this.options.daemon.publicKey,
        signature,
        buildBrokerHelloAckTranscript({
          role: "caller",
          appId: this.options.appId,
          generation: pending.challenge.generation,
          keyId: this.options.credential.grant.keyId,
          grantId: this.options.credential.grant.grantId,
          helloTranscriptHash: pending.transcriptHash,
          selection: fixedProposal(this.options.appRevision),
          callerSessionId: session.callerSessionId,
          initialSequence: session.initialSequence,
        }),
      ))
    )
      clientAuthError();
  }

  private async signedRequest(
    path: string,
    init: SessionBrokerSignedRequestInit,
    targetSpecific: boolean,
  ) {
    const session = this.session!;
    const pending = this.pending!;
    const sequence = this.sequence!.allocate();
    if (!sequence) clientAuthError();
    const method = (init.method ?? "GET").toUpperCase();
    const bodyBytes =
      typeof init.body === "string"
        ? new TextEncoder().encode(init.body)
        : init.body == null
          ? new Uint8Array()
          : clientAuthError();
    const url = new URL(path, this.options.origin);
    if (
      url.origin !== new URL(this.options.origin).origin ||
      url.username ||
      url.password ||
      url.hash
    ) {
      clientAuthError();
    }
    const requestId = randomId(this.cryptoImpl);
    const bodyDigest = encodeBase64Url(await this.cryptoImpl.sha256(bodyBytes));
    const signature = encodeBase64Url(
      await this.cryptoImpl.sign(
        this.options.credential.privateKey,
        buildCallerRequestTranscript({
          appId: this.options.appId,
          generation: pending.challenge.generation,
          callerSessionId: session.callerSessionId,
          keyId: this.options.credential.grant.keyId,
          grantId: this.options.credential.grant.grantId,
          helloTranscriptHash: pending.transcriptHash,
          method,
          target: canonicalHttpTarget(url),
          bodyDigest,
          requestId,
          sequence,
        }),
      ),
    );
    const headers = new Headers(init.headers);
    headers.set("x-session-broker-caller-session", session.callerSessionId);
    headers.set("x-session-broker-request-id", requestId);
    headers.set("x-session-broker-sequence", sequence);
    headers.set("x-session-broker-signature", signature);
    const response = await this.fetchImpl(url, { ...init, method, headers });
    let envelope: SessionBrokerAuthenticatedResponse<CanonicalJsonValue>;
    try {
      envelope = (await readBoundedResponseJson(
        response,
        this.options.maxResponseBytes ?? DEFAULT_SESSION_BROKER_LIMITS.maxHttpResponseBytes,
      )) as SessionBrokerAuthenticatedResponse<CanonicalJsonValue>;
      await this.verifyResponse(
        envelope,
        response.status,
        session.callerSessionId,
        requestId,
        sequence,
        pending.challenge.generation,
        targetSpecific,
      );
    } catch {
      if (response.status === 401) return null;
      clientAuthError();
    }
    return new Response(JSON.stringify(envelope.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  private async verifyResponse(
    envelope: SessionBrokerAuthenticatedResponse<CanonicalJsonValue>,
    status: number,
    callerSessionId: string,
    requestId: string,
    sequence: string,
    generation: string,
    targetSpecific: boolean,
  ) {
    const envelopeRecord = exactRecord(envelope, ["body", "authentication"]);
    const authenticationKeys = [
      "generation",
      "brokerRevision",
      "callerSessionId",
      "requestId",
      "sequence",
      "httpStatus",
      "bodyDigest",
      "daemonKeyId",
      "daemonSignature",
      ...(targetSpecific ? ["appContract"] : []),
    ];
    const auth = exactRecord(
      envelopeRecord.authentication,
      authenticationKeys,
    ) as unknown as SessionBrokerAuthenticatedResponse<CanonicalJsonValue>["authentication"];
    const appContract = auth.appContract
      ? exactRecord(auth.appContract, ["appRevision", "features"])
      : undefined;
    if (
      !auth ||
      typeof auth.bodyDigest !== "string" ||
      typeof auth.daemonSignature !== "string" ||
      auth.generation !== generation ||
      auth.callerSessionId !== callerSessionId ||
      auth.requestId !== requestId ||
      auth.sequence !== sequence ||
      auth.httpStatus !== status ||
      auth.brokerRevision !== SESSION_BROKER_PROTOCOL_REVISION ||
      auth.daemonKeyId !== this.options.daemon.keyId ||
      (targetSpecific ? !auth.appContract : auth.appContract !== undefined)
    )
      clientAuthError();
    if (
      appContract &&
      (appContract.appRevision !== this.options.appRevision ||
        !Array.isArray(appContract.features) ||
        appContract.features.length !== 0)
    )
      clientAuthError();
    const bodyDigest = encodeBase64Url(
      await this.cryptoImpl.sha256(canonicalJsonBytes(envelopeRecord.body as CanonicalJsonValue)),
    );
    if (bodyDigest !== auth.bodyDigest) clientAuthError();
    const signature = decodeBase64Url(auth.daemonSignature);
    if (
      !signature ||
      !(await this.cryptoImpl.verify(
        this.options.daemon.publicKey,
        signature,
        buildBrokerResponseTranscript({
          appId: this.options.appId,
          generation,
          brokerRevision: SESSION_BROKER_PROTOCOL_REVISION,
          callerSessionId,
          requestId,
          sequence,
          httpStatus: status,
          bodyDigest,
          ...(auth.appContract ? { appContract: auth.appContract } : {}),
        }),
      ))
    )
      clientAuthError();
  }
}
