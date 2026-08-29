import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
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
    maxUnauthenticatedSockets: 64,
    ...overrides,
  };
  return {
    limits,
    stopped: new Promise(() => {}),
    matchesSocketPath: (pathname) => pathname === "/session",
    handleConnectionMessage: behavior.handleConnectionMessage ?? (() => {}),
    handleConnectionClose() {},
    handleRequest: async (request) =>
      new URL(request.url).pathname === "/health" ? Response.json({ ok: true }) : null,
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

test("Node adapter consumes the shared text/binary/oversize/pressure corpus", async () => {
  const port = await reservePort();
  const running = await serveSessionBrokerDaemon({
    daemon: fakeDaemon({
      maxWsMessageBytes: 8,
      maxHttpResponseBytes: 8,
      maxUnauthenticatedSockets: 1,
    }),
    hostname: "127.0.0.1",
    port,
    handleRequest: (request) =>
      new URL(request.url).pathname === "/large"
        ? new Response("123456789", { headers: { "content-length": "9" } })
        : undefined,
  });
  try {
    const boundedResponse = await fetch(`http://127.0.0.1:${port}/large`);
    assert.equal(boundedResponse.status, 503);
    assert.equal(await boundedResponse.text(), "");
    const exact = await openSocket(`ws://127.0.0.1:${port}/session`);
    exact.send("12345678");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(exact.readyState, WebSocket.OPEN);
    await assert.rejects(openSocket(`ws://127.0.0.1:${port}/session`));
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
    assert.equal(await outboundClosed, 1013);
  } finally {
    await outboundRunning.stop();
    await outboundRunning.stopped;
  }

  const pressurePort = await reservePort();
  const pressureRunning = await serveSessionBrokerDaemon({
    daemon: fakeDaemon({ maxWsMessageBytes: 8, maxInFlightWsBytes: 0 }),
    hostname: "127.0.0.1",
    port: pressurePort,
  });
  try {
    const pressure = await openSocket(`ws://127.0.0.1:${pressurePort}/session`);
    const pressureClosed = closeCode(pressure);
    pressure.send("{}");
    assert.equal(await pressureClosed, corpus.inbound.pressureCloseCode);
  } finally {
    await pressureRunning.stop();
    await pressureRunning.stopped;
  }
});
