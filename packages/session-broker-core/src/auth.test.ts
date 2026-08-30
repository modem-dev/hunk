import { describe, expect, test } from "bun:test";
import {
  CallerSequenceAllocator,
  CallerSequenceReplayWindow,
  MAX_CALLER_SEQUENCE,
  buildBrokerChallengeTranscript,
  buildBrokerHelloAckTranscript,
  buildBrokerResponseTranscript,
  buildCallerRequestTranscript,
  callerPrincipalAllows,
  freezeBrokerGrant,
  isGrantActive,
  isGrantNarrowing,
  parseCallerSequence,
  principalFromGrant,
  producerPrincipalAllows,
  type CallerGrant,
  type ProducerGrant,
} from "./auth";

const callerGrant: CallerGrant = {
  kind: "caller",
  appId: "dev.example",
  principalId: "caller-1",
  keyId: "caller-key-1",
  grantId: "caller-grant-1",
  algorithm: "Ed25519",
  issuedAt: 1_000,
  expiresAt: 2_000,
  revocationId: "revoke-1",
  mayDelegate: false,
  operations: ["get", "dispatch"],
  commands: [{ name: "review", version: 1 }],
};

describe("session broker authentication core", () => {
  test("builds golden canonical domain-separated transcripts", () => {
    expect(
      new TextDecoder().decode(
        buildBrokerChallengeTranscript({
          role: "caller",
          appId: "dev.example",
          generation: "generation-1",
          endpoint: "http://127.0.0.1:47657/broker",
          keyId: "caller-key-1",
          grantId: "caller-grant-1",
          initiatorNonce: "nonce-a",
          responderNonce: "nonce-b",
          proposal: { brokerRevision: 1, appRevision: 7, features: ["z", "a"] },
        }),
      ),
    ).toBe(
      '{"appId":"dev.example","domain":"dev.hunk.session-broker.v1/caller-hello","endpoint":"http://127.0.0.1:47657/broker","generation":"generation-1","grantId":"caller-grant-1","initiatorNonce":"nonce-a","keyId":"caller-key-1","proposal":{"appRevision":7,"brokerRevision":1,"features":["a","z"]},"responderNonce":"nonce-b"}',
    );
    expect(
      new TextDecoder().decode(
        buildBrokerHelloAckTranscript({
          role: "producer",
          appId: "dev.example",
          generation: "generation-1",
          keyId: "producer-key-1",
          grantId: "producer-grant-1",
          helloTranscriptHash: "hello-hash",
          selection: { brokerRevision: 1, appRevision: 7, features: [] },
          connectionId: "connection-1",
        }),
      ),
    ).toBe(
      '{"appId":"dev.example","connectionId":"connection-1","domain":"dev.hunk.session-broker.v1/producer-hello-ack","generation":"generation-1","grantId":"producer-grant-1","helloTranscriptHash":"hello-hash","keyId":"producer-key-1","selection":{"appRevision":7,"brokerRevision":1,"features":[]}}',
    );
    expect(
      new TextDecoder().decode(
        buildBrokerResponseTranscript({
          appId: "dev.example",
          generation: "generation-1",
          brokerRevision: 1,
          appContract: { appRevision: 7, features: [] },
          callerSessionId: "caller-session-1",
          requestId: "request-1",
          sequence: "1",
          httpStatus: 200,
          bodyDigest: "body-hash",
        }),
      ),
    ).toBe(
      '{"appContract":{"appRevision":7,"features":[]},"appId":"dev.example","bodyDigest":"body-hash","brokerRevision":1,"callerSessionId":"caller-session-1","domain":"dev.hunk.session-broker.v1/caller-response","generation":"generation-1","httpStatus":200,"requestId":"request-1","sequence":"1"}',
    );
    expect(
      new TextDecoder().decode(
        buildCallerRequestTranscript({
          appId: "dev.example",
          generation: "generation-1",
          callerSessionId: "caller-session-1",
          keyId: "caller-key-1",
          grantId: "caller-grant-1",
          helloTranscriptHash: "hello-hash",
          method: "post",
          target: "/broker?a=1&b=2",
          bodyDigest: "body-hash",
          requestId: "request-1",
          sequence: "1",
        }),
      ),
    ).toBe(
      '{"appId":"dev.example","bodyDigest":"body-hash","callerSessionId":"caller-session-1","domain":"dev.hunk.session-broker.v1/caller-request","generation":"generation-1","grantId":"caller-grant-1","helloTranscriptHash":"hello-hash","keyId":"caller-key-1","method":"POST","requestId":"request-1","sequence":"1","target":"/broker?a=1&b=2"}',
    );
  });

  test("enforces immutable grants, expiry, revocation, and command scope separation", () => {
    const grant = freezeBrokerGrant(callerGrant);
    const principal = principalFromGrant(grant);
    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.isFrozen(grant.commands)).toBe(true);
    expect(isGrantActive(grant, { appId: "dev.example", now: 1_500 })).toBe(true);
    expect(isGrantActive(grant, { appId: "wrong.app", now: 1_500 })).toBe(false);
    expect(isGrantActive(grant, { appId: "dev.example", now: 2_000 })).toBe(false);
    expect(
      isGrantNarrowing(
        { ...grant, mayDelegate: true },
        {
          ...grant,
          keyId: "delegated-key",
          grantId: "delegated-grant",
          operations: ["get"],
          commands: [],
          expiresAt: 1_900,
        },
      ),
    ).toBe(true);
    expect(
      isGrantNarrowing(
        { ...grant, mayDelegate: true },
        { ...grant, operations: ["list"], expiresAt: 1_900 },
      ),
    ).toBe(false);
    expect(
      isGrantActive(grant, {
        appId: "dev.example",
        now: 1_500,
        isRevoked: (id) => id === "revoke-1",
      }),
    ).toBe(false);
    expect(
      callerPrincipalAllows(principal, {
        appId: "dev.example",
        operation: "dispatch",
        command: "review",
        commandVersion: 1,
      }),
    ).toBe(true);
    expect(
      callerPrincipalAllows(principal, {
        appId: "dev.example",
        operation: "dispatch",
        command: "review",
        commandVersion: 2,
      }),
    ).toBe(false);
    expect(callerPrincipalAllows(principal, { appId: "dev.example", operation: "list" })).toBe(
      false,
    );

    const producer = principalFromGrant(
      freezeBrokerGrant<ProducerGrant>({
        kind: "producer",
        appId: "dev.example",
        principalId: "producer-1",
        keyId: "producer-key-1",
        grantId: "producer-grant-1",
        algorithm: "Ed25519",
        issuedAt: 1_000,
        expiresAt: 2_000,
        revocationId: "producer-revocation-1",
        mayDelegate: false,
        sessionId: "session-1",
        operations: ["register"],
      }),
    );
    expect(
      producerPrincipalAllows(producer, {
        appId: "dev.example",
        operation: "register",
        sessionId: "session-1",
      }),
    ).toBe(true);
    expect(
      producerPrincipalAllows(producer, {
        appId: "dev.example",
        operation: "reconnect",
        sessionId: "session-1",
      }),
    ).toBe(false);
  });
});

describe("caller uint64 replay window", () => {
  test("rejects zero, non-canonical values, overflow, duplicate, and old sequences", () => {
    expect(parseCallerSequence(MAX_CALLER_SEQUENCE.toString())).toBe(MAX_CALLER_SEQUENCE);
    expect(parseCallerSequence("18446744073709551616")).toBeNull();
    expect(parseCallerSequence("01")).toBeNull();
    const replay = new CallerSequenceReplayWindow();
    expect(replay.admit("0")).toBe("zero");
    expect(replay.admit("1")).toBe("accepted");
    expect(replay.admit("1")).toBe("duplicate");
    expect(replay.admit("65")).toBe("accepted");
    expect(replay.admit("1")).toBe("too-old");
  });

  test("accepts out-of-order values and exact +64 while rejecting +65", () => {
    const replay = new CallerSequenceReplayWindow();
    expect(replay.admit("4")).toBe("accepted");
    expect(replay.admit("2")).toBe("accepted");
    expect(replay.admit("3")).toBe("accepted");
    expect(replay.admit("68")).toBe("accepted");
    expect(replay.admit("133")).toBe("too-far-ahead");
    expect(replay.admit("132")).toBe("accepted");
  });

  test("handles uint64 exhaustion without addition overflow or wrapping", () => {
    const allocator = new CallerSequenceAllocator(MAX_CALLER_SEQUENCE);
    expect(allocator.allocate()).toBe(MAX_CALLER_SEQUENCE.toString());
    expect(allocator.allocate()).toBeNull();

    const replay = new CallerSequenceReplayWindow();
    expect(replay.admit((MAX_CALLER_SEQUENCE - 64n).toString())).toBe("too-far-ahead");
    const nearMax = new CallerSequenceReplayWindow({
      highest: MAX_CALLER_SEQUENCE - 64n,
      bitmap: 1n,
    });
    expect(nearMax.admit(MAX_CALLER_SEQUENCE.toString())).toBe("accepted");
    expect(nearMax.admit(MAX_CALLER_SEQUENCE.toString())).toBe("duplicate");
    expect(nearMax.admit("18446744073709551616")).toBe("invalid");
  });
});
