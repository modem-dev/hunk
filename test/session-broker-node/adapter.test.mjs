import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(
  new URL("../../packages/session-broker-node/package.json", import.meta.url),
);
const WebSocket = require("ws");
const corpus = JSON.parse(
  await readFile(
    fileURLToPath(new URL("../fixtures/sessionBrokerAdapterConformance.json", import.meta.url)),
    "utf8",
  ),
);

const bundlePath = process.env.HUNK_NODE_ADAPTER_BUNDLE;
if (!bundlePath) throw new Error("HUNK_NODE_ADAPTER_BUNDLE must name the built Node adapter.");
const { serveSessionBrokerDaemon } = await import(pathToFileURL(bundlePath).href);

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function closeCode(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket close.")),
      2_000,
    );
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        resolve(event.code);
      },
      { once: true },
    );
    socket.addEventListener("error", () => {}, { once: true });
  });
}

async function rawHttp(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(lines.join("\r\n")));
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("\r\n\r\n")) socket.end();
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

async function openSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket open.")),
      2_000,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("WebSocket failed to open."));
      },
      { once: true },
    );
  });
  return socket;
}

function fakeDaemon(overrides = {}, behavior = {}) {
  const limits = {
    maxWsMessageBytes: corpus.inbound.maxMessageBytes,
    maxInFlightWsBytes: 64 * 1024 * 1024,
    maxOutboundBytesPerPeer: 8 * 1024 * 1024,
    maxOutboundBytesTotal: 64 * 1024 * 1024,
    maxHttpResponseBytes: 8 * 1024 * 1024,
    maxInFlightHttpResponseBytes: 64 * 1024 * 1024,
    maxUnauthenticatedSockets: 64,
    maxHandshakeDurationMs: 15_000,
    ...overrides,
  };
  return {
    limits,
    stopped: new Promise(() => {}),
    requiresProducerAuthentication: behavior.requiresProducerAuthentication ?? false,
    matchesSocketPath: (pathname) => pathname === "/session",
    handleConnectionMessage: behavior.handleConnectionMessage ?? (() => {}),
    handleConnectionClose() {},
    handleRequest:
      behavior.handleRequest ??
      (async (request) =>
        new URL(request.url).pathname === "/health" ? Response.json({ ok: true }) : null),
    shutdown() {},
  };
}

test("Node WebCrypto Ed25519 and base64url work without Bun globals", async () => {
  assert.equal(typeof globalThis.Bun, "undefined");
  const keys = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
  const message = new TextEncoder().encode("session-broker-node");
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, message));
  assert.equal(await crypto.subtle.verify("Ed25519", keys.publicKey, signature, message), true);
  const encoded = Buffer.from(signature).toString("base64url");
  assert.deepEqual(Buffer.from(encoded, "base64url"), Buffer.from(signature));
});

test("Node adapter waits for active HTTP handlers and preserves bodyless framing headers", async () => {
  let deliveredMessages = 0;
  let enter;
  let release;
  const entered = new Promise((resolve) => (enter = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  const port = await reservePort();
  const running = await serveSessionBrokerDaemon({
    daemon: fakeDaemon(
      {},
      {
        handleConnectionMessage: () => {
          deliveredMessages += 1;
        },
        handleRequest: async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/capabilities") {
            return request.headers.get("content-length") === "1" ||
              request.headers.has("transfer-encoding")
              ? new Response(null, { status: 400 })
              : new Response(null, { status: 200 });
          }
          return null;
        },
      },
    ),
    hostname: "127.0.0.1",
    port,
    handleRequest: async (request) => {
      if (new URL(request.url).pathname !== "/deferred") return undefined;
      enter();
      await gate;
      return new Response("done");
    },
  });

  const raw = await rawHttp(port, [
    "GET /capabilities HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Content-Length: 1",
    "Connection: close",
    "",
    "x",
  ]);
  assert.match(raw, /^HTTP\/1\.1 400/);
  const chunked = await rawHttp(port, [
    "GET /capabilities HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Transfer-Encoding: chunked",
    "Connection: close",
    "",
    "1",
    "x",
    "0",
    "",
    "",
  ]);
  assert.match(chunked, /^HTTP\/1\.1 400/);

  const request = fetch(`http://127.0.0.1:${port}/deferred`).catch(() => null);
  await entered;
  let stoppedSettled = false;
  const stopped = running.stopped.then(() => {
    stoppedSettled = true;
  });
  const stopping = running.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stoppedSettled, false);
  await assert.rejects(openSocket(`ws://127.0.0.1:${port}/session`));
  assert.equal(deliveredMessages, 0);
  release();
  await Promise.all([request, stopping, stopped]);
  assert.equal(stoppedSettled, true);
});

test("Node adapter consumes the shared text/binary/oversize/pressure corpus", async () => {
  const port = await reservePort();
  const running = await serveSessionBrokerDaemon({
    daemon: fakeDaemon(
      {
        maxWsMessageBytes: 8,
        maxHttpResponseBytes: 8,
        maxUnauthenticatedSockets: 1,
        maxHandshakeDurationMs: 1_000,
      },
      { requiresProducerAuthentication: true },
    ),
    hostname: "127.0.0.1",
    port,
    handleRequest: (request) =>
      new URL(request.url).pathname === "/large"
        ? new Response("123456789", { headers: { "content-length": "9" } })
        : undefined,
  });
  try {
    const malformedUpgrade = await rawHttp(port, [
      "GET * HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "",
      "",
    ]);
    assert.match(malformedUpgrade, /^HTTP\/1\.1 400/);

    // A successful follow-up request proves the malformed upgrade did not escape the listener.
    const boundedResponse = await fetch(`http://127.0.0.1:${port}/large`);
    assert.equal(boundedResponse.status, 503);
    assert.equal(await boundedResponse.text(), "");
    const exact = await openSocket(`ws://127.0.0.1:${port}/session`);
    exact.send("12345678");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(exact.readyState, WebSocket.OPEN);
    const fullAdmission = await rawHttp(port, [
      "GET /session HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGVzdC1zZXNzaW9uLWtleQ==",
      "",
      "",
    ]);
    assert.match(fullAdmission, new RegExp(`^HTTP/1.1 ${corpus.inbound.admissionHttpStatus}`));
    const exactClosed = closeCode(exact);
    exact.close();
    await exactClosed;
    const afterRelease = await openSocket(`ws://127.0.0.1:${port}/session`);
    const afterReleaseClosed = closeCode(afterRelease);
    afterRelease.close();
    await afterReleaseClosed;

    const binary = await openSocket(`ws://127.0.0.1:${port}/session`);
    const binaryClosed = closeCode(binary);
    binary.send(new Uint8Array([1]));
    assert.equal(await binaryClosed, corpus.textOnly.binaryCloseCode);

    const oversized = await openSocket(`ws://127.0.0.1:${port}/session`);
    const oversizedClosed = closeCode(oversized);
    oversized.send("123456789");
    assert.equal(await oversizedClosed, corpus.inbound.oversizedCloseCode);

    const malformed = await openSocket(`ws://127.0.0.1:${port}/session`);
    const malformedClosed = closeCode(malformed);
    malformed.send(Buffer.from([0xc0, 0xaf]), { binary: false });
    assert.equal(await malformedClosed, 1007);
  } finally {
    await running.stop();
    await running.stopped;
  }

  const outboundPort = await reservePort();
  const outboundRunning = await serveSessionBrokerDaemon({
    daemon: fakeDaemon(
      { maxOutboundBytesPerPeer: 1 },
      { handleConnectionMessage: (peer) => peer.send("too large") },
    ),
    hostname: "127.0.0.1",
    port: outboundPort,
  });
  try {
    const outbound = await openSocket(`ws://127.0.0.1:${outboundPort}/session`);
    const outboundClosed = closeCode(outbound);
    outbound.send("trigger");
    assert.equal(await outboundClosed, corpus.outbound.pressureCloseCode);
  } finally {
    await outboundRunning.stop();
    await outboundRunning.stopped;
  }

  const handlerPort = await reservePort();
  const handlerRunning = await serveSessionBrokerDaemon({
    daemon: fakeDaemon(
      {},
      {
        handleConnectionMessage: () => {
          throw new Error("unexpected handler failure");
        },
      },
    ),
    hostname: "127.0.0.1",
    port: handlerPort,
  });
  try {
    const handlerFailure = await openSocket(`ws://127.0.0.1:${handlerPort}/session`);
    const handlerFailureClosed = closeCode(handlerFailure);
    handlerFailure.send("trigger");
    assert.equal(await handlerFailureClosed, 1011);
  } finally {
    await handlerRunning.stop();
    await handlerRunning.stopped;
  }
});
