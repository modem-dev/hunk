import { describe, expect, test } from "bun:test";
import {
  buildBrokerResponseTranscript,
  buildCallerRequestTranscript,
  type CallerGrant,
  type ProducerGrant,
} from "@hunk/session-broker-core";
import {
  SessionBrokerAuthenticationError,
  SessionBrokerAuthenticator,
  canonicalHttpTarget,
  challengeTranscriptForClient,
  type SessionBrokerHelloChallengeRequest,
} from "./authentication";
import { decodeBase64Url, encodeBase64Url, webSessionBrokerCrypto } from "./crypto";
import type { SessionBrokerCrypto } from "./crypto";

async function keyPair() {
  return crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
}

function callerGrant(overrides: Partial<CallerGrant> = {}): CallerGrant {
  return {
    kind: "caller",
    appId: "dev.example",
    principalId: "caller-1",
    keyId: "caller-key-1",
    grantId: "caller-grant-1",
    algorithm: "Ed25519",
    issuedAt: 1_000,
    expiresAt: 10_000,
    revocationId: "caller-revocation-1",
    mayDelegate: false,
    operations: ["list", "get", "dispatch"],
    commands: [{ name: "review", version: 1 }],
    ...overrides,
  };
}

function producerGrant(): ProducerGrant {
  return {
    kind: "producer",
    appId: "dev.example",
    principalId: "producer-1",
    keyId: "producer-key-1",
    grantId: "producer-grant-1",
    algorithm: "Ed25519",
    issuedAt: 1_000,
    expiresAt: 10_000,
    revocationId: "producer-revocation-1",
    mayDelegate: false,
    operations: ["register"],
  };
}

async function setup(
  options: {
    revoked?: () => boolean;
    maxChallenges?: number;
    maxChallengeBytes?: number;
    maxChallengeTranscriptBytes?: number;
    maxCallerSessions?: number;
    limits?: { maxCallerSessionBytes?: number; maxCallerSessionsBytes?: number };
    callerSessionTtlMs?: number;
    crypto?: SessionBrokerCrypto;
  } = {},
) {
  let now = 2_000;
  const daemon = await keyPair();
  const caller = await keyPair();
  const producer = await keyPair();
  const authenticator = new SessionBrokerAuthenticator({
    appId: "dev.example",
    appRevision: 1,
    generation: "generation-1",
    daemonIdentity: { keyId: "daemon-key-1", privateKey: daemon.privateKey },
    credentials: [
      { grant: callerGrant(), publicKey: caller.publicKey },
      { grant: producerGrant(), publicKey: producer.publicKey },
    ],
    now: () => now,
    isRevoked: options.revoked,
    maxChallenges: options.maxChallenges,
    maxChallengeBytes: options.maxChallengeBytes,
    maxChallengeTranscriptBytes: options.maxChallengeTranscriptBytes,
    maxCallerSessions: options.maxCallerSessions,
    callerSessionTtlMs: options.callerSessionTtlMs,
    limits: options.limits,
    crypto: options.crypto,
  });
  return {
    authenticator,
    daemon,
    caller,
    producer,
    setNow(value: number) {
      now = value;
    },
  };
}

function challengeRequest(
  role: "caller" | "producer" = "caller",
): SessionBrokerHelloChallengeRequest {
  return {
    role,
    appId: "dev.example",
    endpoint: "http://127.0.0.1:47657/broker",
    keyId: `${role}-key-1`,
    grantId: `${role}-grant-1`,
    initiatorNonce: "initiator-nonce",
    proposal: { brokerRevision: 1, appRevision: 1, features: [] },
  };
}

async function openCallerSession(setupResult: Awaited<ReturnType<typeof setup>>) {
  const request = challengeRequest();
  const challenge = await setupResult.authenticator.issueChallenge(request, request.endpoint);
  const transcript = challengeTranscriptForClient(request, challenge, "generation-1");
  expect(
    await webSessionBrokerCrypto.verify(
      setupResult.daemon.publicKey,
      Uint8Array.from(
        atob(
          challenge.daemonSignature
            .replaceAll("-", "+")
            .replaceAll("_", "/")
            .padEnd(Math.ceil(challenge.daemonSignature.length / 4) * 4, "="),
        ),
        (character) => character.charCodeAt(0),
      ),
      transcript,
    ),
  ).toBe(true);
  const signature = encodeBase64Url(
    await webSessionBrokerCrypto.sign(setupResult.caller.privateKey, transcript),
  );
  const session = await setupResult.authenticator.completeCallerHello({
    challengeId: challenge.challengeId,
    signature,
  });
  return { session, transcript };
}

async function signedRequest(
  setupResult: Awaited<ReturnType<typeof setup>>,
  caller: Awaited<ReturnType<typeof openCallerSession>>,
  sequence: string,
  bodyText = '{"action":"list"}',
) {
  const body = new TextEncoder().encode(bodyText);
  const url = new URL("http://broker.test/broker?z=2&a=hello%20world");
  const bodyDigest = encodeBase64Url(await webSessionBrokerCrypto.sha256(body));
  const helloTranscriptHash = encodeBase64Url(
    await webSessionBrokerCrypto.sha256(caller.transcript),
  );
  const transcript = buildCallerRequestTranscript({
    appId: "dev.example",
    generation: "generation-1",
    callerSessionId: caller.session.callerSessionId,
    keyId: "caller-key-1",
    grantId: "caller-grant-1",
    helloTranscriptHash,
    method: "POST",
    target: canonicalHttpTarget(url),
    bodyDigest,
    requestId: `request-${sequence}`,
    sequence,
  });
  const signature = encodeBase64Url(
    await webSessionBrokerCrypto.sign(setupResult.caller.privateKey, transcript),
  );
  const request = new Request(url, {
    method: "POST",
    headers: {
      "x-session-broker-caller-session": caller.session.callerSessionId,
      "x-session-broker-request-id": `request-${sequence}`,
      "x-session-broker-sequence": sequence,
      "x-session-broker-signature": signature,
    },
  });
  return { request, body };
}

describe("session broker signed authentication", () => {
  test("canonicalizes encoded paths and sorted duplicate query values", () => {
    expect(
      canonicalHttpTarget(new URL("http://broker.test/review/%7euser?z=2&a=hello+world&a=%2F")),
    ).toBe("/review/~user?a=%2F&a=hello%20world&z=2");
  });

  test("verifies daemon identity before accepting caller and producer proofs", async () => {
    const values = await setup();
    const caller = await openCallerSession(values);
    expect(caller.session).toMatchObject({ initialSequence: "1", brokerRevision: 1 });

    const request = challengeRequest("producer");
    const challenge = await values.authenticator.issueChallenge(request, request.endpoint);
    const transcript = challengeTranscriptForClient(request, challenge, "generation-1");
    const signature = encodeBase64Url(
      await webSessionBrokerCrypto.sign(values.producer.privateKey, transcript),
    );
    await expect(
      values.authenticator.completeProducerHello(
        { challengeId: challenge.challengeId, signature },
        "connection-1",
      ),
    ).resolves.toMatchObject({
      connectionId: "connection-1",
      daemonKeyId: "daemon-key-1",
      principal: { kind: "producer", scopes: ["register"] },
    });
  });

  test("rechecks producer expiry and revocation after hello completion", async () => {
    let revoked = false;
    const values = await setup({ revoked: () => revoked });
    const request = challengeRequest("producer");
    const challenge = await values.authenticator.issueChallenge(request, request.endpoint);
    const transcript = challengeTranscriptForClient(request, challenge, "generation-1");
    const signature = encodeBase64Url(
      await webSessionBrokerCrypto.sign(values.producer.privateKey, transcript),
    );
    const hello = await values.authenticator.completeProducerHello(
      { challengeId: challenge.challengeId, signature },
      "connection-1",
    );

    expect(() => values.authenticator.assertProducerActive(hello.principal)).not.toThrow();
    revoked = true;
    expect(() => values.authenticator.assertProducerActive(hello.principal)).toThrow(
      SessionBrokerAuthenticationError,
    );
    revoked = false;
    values.setNow(10_001);
    expect(() => values.authenticator.assertProducerActive(hello.principal)).toThrow(
      SessionBrokerAuthenticationError,
    );
  });

  test("rejects missing, wrong, expired, revoked, and reused credentials with redacted errors", async () => {
    const values = await setup();
    await expect(
      values.authenticator.issueChallenge(
        { ...challengeRequest(), keyId: "wrong-key" },
        challengeRequest().endpoint,
      ),
    ).rejects.toMatchObject({ code: "invalid-credential" });
    await expect(
      values.authenticator.authenticate({
        request: new Request("http://broker.test/broker"),
        body: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ code: "authentication-required" });

    const request = challengeRequest();
    const challenge = await values.authenticator.issueChallenge(request, request.endpoint);
    const transcript = challengeTranscriptForClient(request, challenge, "generation-1");
    const signature = encodeBase64Url(
      await webSessionBrokerCrypto.sign(values.caller.privateKey, transcript),
    );
    await values.authenticator.completeCallerHello({
      challengeId: challenge.challengeId,
      signature,
    });
    await expect(
      values.authenticator.completeCallerHello({ challengeId: challenge.challengeId, signature }),
    ).rejects.toMatchObject({ code: "challenge-used" });

    values.setNow(11_000);
    await expect(
      values.authenticator.issueChallenge(challengeRequest(), challengeRequest().endpoint),
    ).rejects.toMatchObject({
      code: "credential-expired",
    });

    const revoked = await setup({ revoked: () => true });
    await expect(
      revoked.authenticator.issueChallenge(challengeRequest(), challengeRequest().endpoint),
    ).rejects.toMatchObject({
      code: "credential-revoked",
    });

    const error = new SessionBrokerAuthenticationError("invalid-signature");
    expect(JSON.stringify({ message: error.message, code: error.code })).not.toContain(
      "signature-",
    );
    expect(error.message).toBe("Session broker authentication failed.");
  });

  test("expires challenges and short-lived caller sessions", async () => {
    const challengeValues = await setup();
    const request = challengeRequest();
    const challenge = await challengeValues.authenticator.issueChallenge(request, request.endpoint);
    challengeValues.setNow(challenge.expiresAt);
    await expect(
      challengeValues.authenticator.completeCallerHello({
        challengeId: challenge.challengeId,
        signature: "not-used-after-expiry",
      }),
    ).rejects.toMatchObject({ code: "challenge-expired" });

    const sessionValues = await setup({ callerSessionTtlMs: 500 });
    const caller = await openCallerSession(sessionValues);
    sessionValues.setNow(caller.session.expiresAt);
    const signed = await signedRequest(sessionValues, caller, "1");
    await expect(sessionValues.authenticator.authenticate(signed)).rejects.toMatchObject({
      code: "caller-session-expired",
    });
  });

  test("binds method, canonical target, body digest, request ID, and replay sequence", async () => {
    const values = await setup();
    const caller = await openCallerSession(values);
    const first = await signedRequest(values, caller, "1");
    await expect(values.authenticator.authenticate(first)).resolves.toMatchObject({
      principal: { principalId: "caller-1" },
    });
    await expect(values.authenticator.authenticate(first)).rejects.toMatchObject({
      code: "replay-rejected",
    });

    const tampered = await signedRequest(values, caller, "2");
    await expect(
      values.authenticator.authenticate({
        request: tampered.request,
        body: new TextEncoder().encode('{"action":"get"}'),
      }),
    ).rejects.toMatchObject({ code: "invalid-signature" });
    await expect(values.authenticator.authenticate(tampered)).resolves.toMatchObject({
      principal: { principalId: "caller-1" },
    });
  });

  test("rechecks revocation after asynchronous signature verification", async () => {
    let revoked = false;
    let revokeAfterVerify = false;
    const cryptoWithRevocation: SessionBrokerCrypto = {
      ...webSessionBrokerCrypto,
      async verify(publicKey, signature, value) {
        const verified = await webSessionBrokerCrypto.verify(publicKey, signature, value);
        if (revokeAfterVerify) revoked = true;
        return verified;
      },
    };
    const values = await setup({ revoked: () => revoked, crypto: cryptoWithRevocation });
    const caller = await openCallerSession(values);
    const signed = await signedRequest(values, caller, "1");

    revokeAfterVerify = true;
    await expect(values.authenticator.authenticate(signed)).rejects.toMatchObject({
      code: "credential-revoked",
    });
  });

  test("rejects non-HTTP request targets even when path and query are signable", async () => {
    const values = await setup();
    const caller = await openCallerSession(values);
    const signed = await signedRequest(values, caller, "1");
    const request = new Request("ftp://broker.test/broker?z=2&a=hello%20world", {
      method: "POST",
      headers: signed.request.headers,
    });

    await expect(
      values.authenticator.authenticate({ request, body: signed.body }),
    ).rejects.toMatchObject({ code: "invalid-signature" });
  });

  test("signs response envelopes and rejects transcript tampering or the wrong generation", async () => {
    const values = await setup();
    const caller = await openCallerSession(values);
    const signed = await signedRequest(values, caller, "1");
    const authenticated = await values.authenticator.authenticate(signed);
    const response = await authenticated.signResponse({
      httpStatus: 200,
      body: { sessions: [] },
      appContract: { appRevision: 1, features: [] },
    });
    const signature = decodeBase64Url(response.daemonSignature)!;
    const transcriptInput = {
      appId: "dev.example",
      generation: response.generation,
      brokerRevision: 1 as const,
      appContract: { appRevision: 1, features: [] },
      requestId: response.requestId,
      httpStatus: response.httpStatus,
      bodyDigest: response.bodyDigest,
    };
    expect(
      await webSessionBrokerCrypto.verify(
        values.daemon.publicKey,
        signature,
        buildBrokerResponseTranscript(transcriptInput),
      ),
    ).toBe(true);
    expect(
      await webSessionBrokerCrypto.verify(
        values.daemon.publicKey,
        signature,
        buildBrokerResponseTranscript({ ...transcriptInput, generation: "generation-2" }),
      ),
    ).toBe(false);
    expect(
      await webSessionBrokerCrypto.verify(
        values.daemon.publicKey,
        signature,
        buildBrokerResponseTranscript({ ...transcriptInput, httpStatus: 201 }),
      ),
    ).toBe(false);
    expect(
      await webSessionBrokerCrypto.verify(
        values.daemon.publicKey,
        signature,
        buildBrokerResponseTranscript({ ...transcriptInput, bodyDigest: "tampered" }),
      ),
    ).toBe(false);
  });

  test("uses bounded collision-safe IDs with a deterministic custom random source", async () => {
    const randomValues = [1, 2, 1, 3];
    const deterministicCrypto: SessionBrokerCrypto = {
      ...webSessionBrokerCrypto,
      randomBytes(length) {
        return new Uint8Array(length).fill(randomValues.shift() ?? 9);
      },
    };
    const values = await setup({ crypto: deterministicCrypto, maxChallenges: 2 });
    const first = await values.authenticator.issueChallenge(
      challengeRequest(),
      challengeRequest().endpoint,
    );
    const second = await values.authenticator.issueChallenge(
      challengeRequest(),
      challengeRequest().endpoint,
    );
    expect(first.challengeId).not.toBe(second.challengeId);

    const callerRandomValues = [1, 2, 3, 1, 4, 3, 5];
    const callerCrypto: SessionBrokerCrypto = {
      ...webSessionBrokerCrypto,
      randomBytes(length) {
        return new Uint8Array(length).fill(callerRandomValues.shift() ?? 9);
      },
    };
    const callerValues = await setup({ crypto: callerCrypto, maxCallerSessions: 2 });
    const firstCaller = await openCallerSession(callerValues);
    const secondCaller = await openCallerSession(callerValues);
    expect(firstCaller.session.callerSessionId).not.toBe(secondCaller.session.callerSessionId);
  });

  test("validates and snapshots mutable startup authority before accepting traffic", async () => {
    const daemon = await keyPair();
    const caller = await keyPair();
    let now = 2_000;
    const grant = callerGrant();
    const options = {
      appId: "dev.example",
      appRevision: 1,
      generation: "generation-1",
      daemonIdentity: { keyId: "daemon-key-1", privateKey: daemon.privateKey },
      credentials: [{ grant, publicKey: caller.publicKey }],
      now: () => now,
      isRevoked: () => false,
      maxChallenges: 1,
    };
    const authenticator = new SessionBrokerAuthenticator(options);
    (grant.operations as CallerGrant["operations"] & string[]).splice(0, grant.operations.length);
    options.generation = "generation-2";
    options.maxChallenges = 0;
    options.isRevoked = () => true;

    const request = challengeRequest();
    await expect(authenticator.issueChallenge(request, request.endpoint)).resolves.toMatchObject({
      daemonKeyId: "daemon-key-1",
    });
    now = 18_000;
    await expect(authenticator.issueChallenge(request, request.endpoint)).rejects.toMatchObject({
      code: "credential-expired",
    });

    expect(
      () =>
        new SessionBrokerAuthenticator({
          ...options,
          generation: "generation-1",
          credentials: [
            { grant: callerGrant({ algorithm: "RSA" as "Ed25519" }), publicKey: caller.publicKey },
          ],
        }),
    ).toThrow("algorithm");
    expect(
      () =>
        new SessionBrokerAuthenticator({
          ...options,
          generation: "generation-1",
          credentials: [
            { grant: callerGrant({ issuedAt: Number.NaN }), publicKey: caller.publicKey },
          ],
        }),
    ).toThrow("timestamps");
    expect(
      () =>
        new SessionBrokerAuthenticator({
          ...options,
          appId: "Wrong.App",
          generation: "generation-1",
          credentials: [],
        }),
    ).toThrow("appId");
    expect(
      () =>
        new SessionBrokerAuthenticator({
          ...options,
          generation: "generation-1",
          credentials: [
            {
              grant: callerGrant({ appId: "other.app", operations: ["unknown" as "list"] }),
              publicKey: caller.publicKey,
            },
          ],
        }),
    ).toThrow("configured appId");
    expect(
      () =>
        new SessionBrokerAuthenticator({
          ...options,
          generation: "generation-1",
          credentials: [
            {
              grant: callerGrant({ operations: ["unknown" as "list"] }),
              publicKey: caller.publicKey,
            },
          ],
        }),
    ).toThrow("recognized");
    expect(
      () =>
        new SessionBrokerAuthenticator({
          ...options,
          generation: "generation-1",
          credentials: [
            {
              grant: callerGrant({
                commands: [
                  { name: "review", version: 1 },
                  { name: "review", version: 1 },
                ],
              }),
              publicKey: caller.publicKey,
            },
          ],
        }),
    ).toThrow("unique");
  });

  test("rejects malformed fixed hello proposals, identifiers, and endpoints", async () => {
    const values = await setup();
    const valid = challengeRequest();
    for (const malformed of [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, initiatorNonce: "bad nonce" },
      { ...valid, endpoint: "http://user@127.0.0.1/broker" },
      { ...valid, proposal: { ...valid.proposal, appRevision: 2 } },
      { ...valid, proposal: { ...valid.proposal, features: ["unexpected.feature"] } },
      { ...valid, proposal: { ...valid.proposal, extra: true } },
    ]) {
      await expect(
        values.authenticator.issueChallenge(malformed, valid.endpoint),
      ).rejects.toMatchObject({
        code: "invalid-credential",
      });
    }
  });

  test("rejects malformed percent encodings and UTF-8 in canonical HTTP targets", () => {
    for (const target of ["/%", "/%GG", "/%C0%AF", "/broker?q=%ED%A0%80"]) {
      expect(() => canonicalHttpTarget(new URL(`http://broker.test${target}`))).toThrow();
    }
  });

  test("retains incomplete-handshake capacity through asynchronous proof verification", async () => {
    let blockVerify = false;
    let releaseVerify!: () => void;
    const verifyGate = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    const cryptoWithGate: SessionBrokerCrypto = {
      ...webSessionBrokerCrypto,
      async verify(publicKey, signature, value) {
        if (blockVerify) await verifyGate;
        return webSessionBrokerCrypto.verify(publicKey, signature, value);
      },
    };
    const values = await setup({ maxChallenges: 1, crypto: cryptoWithGate });
    const request = challengeRequest();
    const challenge = await values.authenticator.issueChallenge(request, request.endpoint);
    const transcript = challengeTranscriptForClient(request, challenge, "generation-1");
    const signature = encodeBase64Url(
      await webSessionBrokerCrypto.sign(values.caller.privateKey, transcript),
    );

    blockVerify = true;
    const completing = values.authenticator.completeCallerHello({
      challengeId: challenge.challengeId,
      signature,
    });
    await Bun.sleep(0);
    await expect(
      values.authenticator.issueChallenge(request, request.endpoint),
    ).rejects.toMatchObject({ code: "authentication-capacity" });
    releaseVerify();
    await expect(completing).resolves.toMatchObject({ brokerRevision: 1 });
  });

  test("bounds pending challenge counts and retained transcript bytes", async () => {
    const values = await setup({ maxChallenges: 1 });
    await values.authenticator.issueChallenge(challengeRequest(), challengeRequest().endpoint);
    await expect(
      values.authenticator.issueChallenge(challengeRequest(), challengeRequest().endpoint),
    ).rejects.toMatchObject({
      code: "authentication-capacity",
    });

    const byteBound = await setup({ maxChallengeTranscriptBytes: 128 });
    await expect(
      byteBound.authenticator.issueChallenge(challengeRequest(), challengeRequest().endpoint),
    ).rejects.toMatchObject({ code: "authentication-capacity" });

    const completeRecordBound = await setup({ maxChallengeBytes: 512 });
    await expect(
      completeRecordBound.authenticator.issueChallenge(
        challengeRequest(),
        challengeRequest().endpoint,
      ),
    ).rejects.toMatchObject({ code: "authentication-capacity" });

    const noCallerCapacity = await setup({ maxCallerSessions: 0 });
    await expect(openCallerSession(noCallerCapacity)).rejects.toMatchObject({
      code: "authentication-capacity",
    });

    const noCallerByteCapacity = await setup({
      limits: { maxCallerSessionBytes: 1, maxCallerSessionsBytes: 1 },
    });
    await expect(openCallerSession(noCallerByteCapacity)).rejects.toMatchObject({
      code: "authentication-capacity",
    });

    const reusableCallerCapacity = await setup({ maxCallerSessions: 1 });
    const first = await openCallerSession(reusableCallerCapacity);
    reusableCallerCapacity.authenticator.revokeCallerSession(first.session.callerSessionId);
    await expect(openCallerSession(reusableCallerCapacity)).resolves.toMatchObject({
      session: { initialSequence: "1" },
    });
    reusableCallerCapacity.authenticator.clear();
  });
});
