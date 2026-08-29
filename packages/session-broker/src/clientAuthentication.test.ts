import { describe, expect, test } from "bun:test";
import { SESSION_BROKER_SIGNATURE_ALGORITHM, type CallerGrant } from "@hunk/session-broker-core";
import { SessionBrokerAuthenticator } from "./authentication";
import { SessionBrokerCallerClient } from "./clientAuthentication";

async function keyPair() {
  const generated = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateBytes = await crypto.subtle.exportKey("pkcs8", generated.privateKey);
  return {
    publicKey: generated.publicKey,
    privateKey: await crypto.subtle.importKey("pkcs8", privateBytes, "Ed25519", false, ["sign"]),
  };
}

async function setup() {
  const daemon = await keyPair();
  const caller = await keyPair();
  const grant: CallerGrant = {
    kind: "caller",
    appId: "dev.example",
    principalId: "caller-1",
    keyId: "caller-key-1",
    grantId: "caller-grant-1",
    algorithm: SESSION_BROKER_SIGNATURE_ALGORITHM,
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    revocationId: "caller-revocation-1",
    mayDelegate: false,
    operations: ["list"],
    commands: [],
  };
  const authenticator = new SessionBrokerAuthenticator({
    appId: "dev.example",
    appRevision: 7,
    generation: "generation-1",
    daemonIdentity: { keyId: "daemon-key-1", privateKey: daemon.privateKey },
    credentials: [{ grant, publicKey: caller.publicKey }],
  });
  return { daemon, caller, grant, authenticator };
}

/** Build an in-memory HTTP adapter exercising the exact generic challenge/proof/request bytes. */
function createFetch(
  authenticator: SessionBrokerAuthenticator,
  proofCount: { value: number },
  targetSpecific = false,
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/session-auth/challenge") {
      return Response.json(await authenticator.issueChallenge(await request.json(), request.url));
    }
    if (url.pathname === "/session-auth/proof") {
      proofCount.value += 1;
      return Response.json(await authenticator.completeCallerHello(await request.json()));
    }
    const body = new Uint8Array(await request.arrayBuffer());
    try {
      const authenticated = await authenticator.authenticate({ request, body });
      const responseBody = { sessions: [] };
      return Response.json({
        body: responseBody,
        authentication: await authenticated.signResponse({
          httpStatus: 200,
          body: responseBody,
          ...(targetSpecific ? { appContract: { appRevision: 7, features: [] } } : {}),
        }),
      });
    } catch {
      return Response.json({ error: "authentication-required" }, { status: 401 });
    }
  }) as typeof fetch;
}

describe("session broker caller client", () => {
  test("negotiates once, allocates monotonic signed sequences, and verifies signed responses", async () => {
    const values = await setup();
    const proofCount = { value: 0 };
    const client = new SessionBrokerCallerClient({
      appId: "dev.example",
      appRevision: 7,
      origin: "http://broker.test",
      credential: { grant: values.grant, privateKey: values.caller.privateKey },
      daemon: { keyId: "daemon-key-1", publicKey: values.daemon.publicKey },
      fetch: createFetch(values.authenticator, proofCount),
    });

    await expect(
      client
        .request("/control", { method: "POST", body: "{}" })
        .then((response) => response.json()),
    ).resolves.toEqual({ sessions: [] });
    await expect(
      client
        .request("/control", { method: "POST", body: "{}" })
        .then((response) => response.json()),
    ).resolves.toEqual({ sessions: [] });
    expect(proofCount.value).toBe(1);
  });

  test("requires the exact Hunk-style application contract on target-specific responses", async () => {
    const values = await setup();
    const proofCount = { value: 0 };
    const client = new SessionBrokerCallerClient({
      appId: "dev.example",
      appRevision: 7,
      origin: "http://broker.test",
      credential: { grant: values.grant, privateKey: values.caller.privateKey },
      daemon: { keyId: "daemon-key-1", publicKey: values.daemon.publicKey },
      fetch: createFetch(values.authenticator, proofCount, true),
    });

    await expect(
      client
        .request("/control", { method: "POST", body: "{}" }, { targetSpecific: true })
        .then((response) => response.json()),
    ).resolves.toEqual({ sessions: [] });
  });

  test("rejects an unsigned second 401 after one fresh-session retry", async () => {
    const values = await setup();
    const proofCount = { value: 0 };
    const authenticatedFetch = createFetch(values.authenticator, proofCount);
    const fetchWithForgedControls = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return new URL(request.url).pathname === "/control"
        ? Response.json({ error: "forged" }, { status: 401 })
        : authenticatedFetch(request);
    }) as typeof fetch;
    const client = new SessionBrokerCallerClient({
      appId: "dev.example",
      appRevision: 7,
      origin: "http://broker.test",
      credential: { grant: values.grant, privateKey: values.caller.privateKey },
      daemon: { keyId: "daemon-key-1", publicKey: values.daemon.publicKey },
      fetch: fetchWithForgedControls,
    });

    await expect(client.request("/control", { method: "POST", body: "{}" })).rejects.toThrow(
      "daemon identity could not be verified",
    );
    expect(proofCount.value).toBe(2);
  });

  test("propagates the control abort signal through challenge and proof negotiation", async () => {
    const values = await setup();
    const proofCount = { value: 0 };
    const signals: Array<AbortSignal | null | undefined> = [];
    const authenticatedFetch = createFetch(values.authenticator, proofCount);
    const observingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(input instanceof Request ? input.signal : init?.signal);
      return authenticatedFetch(input, init);
    }) as typeof fetch;
    const client = new SessionBrokerCallerClient({
      appId: "dev.example",
      appRevision: 7,
      origin: "http://broker.test",
      credential: { grant: values.grant, privateKey: values.caller.privateKey },
      daemon: { keyId: "daemon-key-1", publicKey: values.daemon.publicKey },
      fetch: observingFetch,
    });
    const controller = new AbortController();

    await client.request("/control", { method: "POST", body: "{}", signal: controller.signal });
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  });

  test("rejects oversized unauthenticated challenge responses before parsing", async () => {
    const values = await setup();
    const client = new SessionBrokerCallerClient({
      appId: "dev.example",
      appRevision: 7,
      origin: "http://broker.test",
      credential: { grant: values.grant, privateKey: values.caller.privateKey },
      daemon: { keyId: "daemon-key-1", publicKey: values.daemon.publicKey },
      maxResponseBytes: 32,
      fetch: (async () => Response.json({ padding: "x".repeat(128) })) as unknown as typeof fetch,
    });

    await expect(client.request("/control")).rejects.toThrow(
      "daemon identity could not be verified",
    );
  });

  test("verifies the daemon challenge before presenting caller proof", async () => {
    const values = await setup();
    const wrongDaemon = await keyPair();
    const proofCount = { value: 0 };
    const client = new SessionBrokerCallerClient({
      appId: "dev.example",
      appRevision: 7,
      origin: "http://broker.test",
      credential: { grant: values.grant, privateKey: values.caller.privateKey },
      daemon: { keyId: "daemon-key-1", publicKey: wrongDaemon.publicKey },
      fetch: createFetch(values.authenticator, proofCount),
    });

    await expect(client.request("/control", { method: "POST", body: "{}" })).rejects.toThrow(
      "daemon identity could not be verified",
    );
    expect(proofCount.value).toBe(0);
  });
});
