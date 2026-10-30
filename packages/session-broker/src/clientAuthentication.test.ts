import { describe, expect, test } from "bun:test";
import { SESSION_BROKER_SIGNATURE_ALGORITHM, type CallerGrant } from "@hunk/session-broker-core";
import { SessionBrokerAuthenticator } from "./authentication";
import {
  SessionBrokerCallerClient,
  SessionBrokerClientAuthenticationError,
} from "./clientAuthentication";

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

  test("rejects responses replayed across caller sessions or request sequences", async () => {
    for (const [field, replacement] of [
      ["callerSessionId", "caller-session-replayed"],
      ["sequence", "2"],
    ] as const) {
      const values = await setup();
      const proofCount = { value: 0 };
      const authenticatedFetch = createFetch(values.authenticator, proofCount);
      const tamperingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const response = await authenticatedFetch(request);
        if (new URL(request.url).pathname !== "/control") return response;
        const envelope = (await response.json()) as {
          body: unknown;
          authentication: Record<string, unknown>;
        };
        envelope.authentication[field] = replacement;
        return Response.json(envelope, { status: response.status });
      }) as typeof fetch;
      const client = new SessionBrokerCallerClient({
        appId: "dev.example",
        appRevision: 7,
        origin: "http://broker.test",
        credential: {
          grant: values.grant,
          privateKey: values.caller.privateKey,
        },
        daemon: { keyId: "daemon-key-1", publicKey: values.daemon.publicKey },
        fetch: tamperingFetch,
      });

      await expect(
        client.request("/control", { method: "POST", body: "{}" }),
      ).rejects.toBeInstanceOf(SessionBrokerClientAuthenticationError);
    }
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

  test("delayed stale 401s do not clear an overlapping shared recovery negotiation", async () => {
    const values = await setup();
    const proofCount = { value: 0 };
    const authenticatedFetch = createFetch(values.authenticator, proofCount);
    let staleControls = 0;
    let staleMode = false;
    let releaseFirst401!: () => void;
    let releaseSecond401!: () => void;
    let releaseRecovery!: () => void;
    let signalBothStale!: () => void;
    let signalRecovery!: () => void;
    const first401 = new Promise<void>((resolve) => (releaseFirst401 = resolve));
    const second401 = new Promise<void>((resolve) => (releaseSecond401 = resolve));
    const recoveryGate = new Promise<void>((resolve) => (releaseRecovery = resolve));
    const bothStale = new Promise<void>((resolve) => (signalBothStale = resolve));
    const recoveryStarted = new Promise<void>((resolve) => (signalRecovery = resolve));
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const pathname = new URL(request.url).pathname;
      if (staleMode && pathname === "/session-auth/challenge" && proofCount.value === 1) {
        signalRecovery();
        await recoveryGate;
      }
      if (staleMode && pathname === "/control" && proofCount.value === 1 && staleControls < 2) {
        staleControls += 1;
        if (staleControls === 2) signalBothStale();
        await (staleControls === 1 ? first401 : second401);
        return Response.json({ error: "stale-session" }, { status: 401 });
      }
      return authenticatedFetch(request);
    }) as typeof fetch;
    const client = new SessionBrokerCallerClient({
      appId: "dev.example",
      appRevision: 7,
      origin: "http://broker.test",
      credential: { grant: values.grant, privateKey: values.caller.privateKey },
      daemon: { keyId: "daemon-key-1", publicKey: values.daemon.publicKey },
      fetch: fetchImpl,
    });

    await expect(client.request("/control")).resolves.toBeInstanceOf(Response);
    staleMode = true;
    const first = client.request("/control");
    const second = client.request("/control");
    await bothStale;
    releaseFirst401();
    await recoveryStarted;
    releaseSecond401();
    releaseRecovery();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(proofCount.value).toBe(2);
  });

  test("coalesces concurrent negotiations while retaining unique request sequences", async () => {
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

    const responses = await Promise.all(
      Array.from({ length: 32 }, () => client.request("/control", { method: "POST", body: "{}" })),
    );
    expect(responses).toHaveLength(32);
    expect(proofCount.value).toBe(1);
  });

  test("aborting one negotiation waiter does not cancel another", async () => {
    const values = await setup();
    const proofCount = { value: 0 };
    const authenticatedFetch = createFetch(values.authenticator, proofCount);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/session-auth/challenge") await gate;
      return authenticatedFetch(request);
    }) as typeof fetch;
    const client = new SessionBrokerCallerClient({
      appId: "dev.example",
      appRevision: 7,
      origin: "http://broker.test",
      credential: { grant: values.grant, privateKey: values.caller.privateKey },
      daemon: { keyId: "daemon-key-1", publicKey: values.daemon.publicKey },
      fetch: gatedFetch,
    });
    const controller = new AbortController();
    const aborted = client.request("/control", { signal: controller.signal });
    const surviving = client.request("/control");
    controller.abort(new Error("caller stopped"));
    release();

    await expect(aborted).rejects.toThrow("caller stopped");
    await expect(surviving).resolves.toBeInstanceOf(Response);
    expect(proofCount.value).toBe(1);
  });

  test("clear invalidates stale negotiation installation and failures allow retry", async () => {
    const values = await setup();
    const authenticatedFetch = createFetch(values.authenticator, { value: 0 });
    let challengeCount = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/session-auth/challenge") {
        challengeCount += 1;
        if (challengeCount === 1) await firstGate;
        if (challengeCount === 2) return new Response("no", { status: 503 });
      }
      return authenticatedFetch(request);
    }) as typeof fetch;
    const client = new SessionBrokerCallerClient({
      appId: "dev.example",
      appRevision: 7,
      origin: "http://broker.test",
      credential: { grant: values.grant, privateKey: values.caller.privateKey },
      daemon: { keyId: "daemon-key-1", publicKey: values.daemon.publicKey },
      fetch: fetchImpl,
    });

    const stale = client.request("/control");
    client.clear();
    await expect(client.request("/control")).rejects.toBeInstanceOf(
      SessionBrokerClientAuthenticationError,
    );
    releaseFirst();
    await expect(stale).rejects.toBeInstanceOf(SessionBrokerClientAuthenticationError);
    await expect(client.request("/control")).resolves.toBeInstanceOf(Response);
    expect(challengeCount).toBe(3);
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

  test("cancels malformed or oversized declared response bodies before rejecting", async () => {
    for (const declared of ["invalid", "33"]) {
      const values = await setup();
      let cancelled = false;
      const client = new SessionBrokerCallerClient({
        appId: "dev.example",
        appRevision: 7,
        origin: "http://broker.test",
        credential: {
          grant: values.grant,
          privateKey: values.caller.privateKey,
        },
        daemon: { keyId: "daemon-key-1", publicKey: values.daemon.publicKey },
        maxResponseBytes: 32,
        fetch: (async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-length": declared } },
          )) as unknown as typeof fetch,
      });

      await expect(client.request("/control")).rejects.toThrow(
        "daemon identity could not be verified",
      );
      expect(cancelled).toBe(true);
    }
  });

  test("rejects challenge records with unknown or dangerous own keys", async () => {
    for (const extra of ["extra", "__proto__"]) {
      const values = await setup();
      const authenticatedFetch = createFetch(values.authenticator, {
        value: 0,
      });
      const fetchWithExtra = (async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const response = await authenticatedFetch(request);
        if (new URL(request.url).pathname !== "/session-auth/challenge") return response;
        const challenge = (await response.json()) as Record<string, unknown>;
        Object.defineProperty(challenge, extra, {
          value: true,
          enumerable: true,
        });
        return Response.json(challenge);
      }) as typeof fetch;
      const client = new SessionBrokerCallerClient({
        appId: "dev.example",
        appRevision: 7,
        origin: "http://broker.test",
        credential: {
          grant: values.grant,
          privateKey: values.caller.privateKey,
        },
        daemon: { keyId: "daemon-key-1", publicKey: values.daemon.publicKey },
        fetch: fetchWithExtra,
      });

      await expect(client.request("/control")).rejects.toThrow(
        "daemon identity could not be verified",
      );
    }
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
