import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo, Socket } from "node:net";
import {
  BrokerCapacityError,
  ResourceBudget,
  boundHttpResponse,
  type BudgetReservation,
  type SessionServerMessage,
} from "@hunk/session-broker-core";
import type { SessionBrokerDaemon, SessionBrokerPeer } from "@hunk/session-broker";
import { WebSocketServer, type WebSocket } from "ws";

export interface ServeSessionBrokerDaemonOptions<
  SessionView = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
> {
  daemon: SessionBrokerDaemon<SessionView, ServerMessage, CommandResult>;
  hostname: string;
  port: number;
  handleRequest?: (
    request: Request,
    server: ReturnType<typeof createServer>,
  ) => Response | Promise<Response | undefined> | undefined;
  notFound?: (request: Request) => Response | Promise<Response>;
  formatServeError?: (error: unknown, address: { hostname: string; port: number }) => Error;
}

export interface RunningSessionBrokerDaemon {
  server: ReturnType<typeof createServer>;
  stopped: Promise<void>;
  stop(): Promise<void>;
  address(): AddressInfo | string | null;
}

function defaultNotFound() {
  return new Response("Not found.", { status: 404 });
}

function defaultServeError(error: unknown, address: { hostname: string; port: number }) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `Failed to start the session broker server on ${address.hostname}:${address.port}: ${message}`,
  );
}

function toNodeConnection(
  socket: WebSocket,
  outboundBudget: ResourceBudget,
  maxPeerBytes: number,
  markAuthenticated: () => void,
): SessionBrokerPeer {
  return {
    send(data: string) {
      const bytes = Buffer.byteLength(data);
      if (bytes > maxPeerBytes - socket.bufferedAmount) {
        socket.close(1013, "Session broker outbound pressure exceeded.");
        throw new BrokerCapacityError("busy", "maxOutboundBytesPerPeer");
      }
      const reservation = outboundBudget.tryReserve(bytes);
      if (!reservation) {
        socket.close(1013, "Session broker outbound pressure exceeded.");
        throw new BrokerCapacityError("busy", "maxOutboundBytesTotal");
      }
      try {
        socket.send(data, (error) => {
          reservation.release();
          if (error && socket.readyState < 2) {
            socket.close(1013, "Session broker outbound delivery failed.");
          }
        });
      } catch (error) {
        reservation.release();
        throw error;
      }
    },
    close(code?: number, reason?: string) {
      socket.close(code, reason);
    },
    markAuthenticated,
  };
}

/** Adapt one Node request into the WHATWG Request shape consumed by the runtime-neutral daemon. */
async function toRequest(request: IncomingMessage, hostname: string, port: number) {
  const protocol = "encrypted" in request.socket && request.socket.encrypted ? "https" : "http";
  const url = `${protocol}://${hostname}:${port}${request.url ?? "/"}`;
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : (Readable.toWeb(request) as unknown as BodyInit);

  return new Request(url, {
    method: request.method,
    headers: request.headers as HeadersInit,
    body,
    duplex: body ? "half" : undefined,
  } as RequestInit & { duplex?: "half" });
}

async function writeResponse(
  nodeResponse: ServerResponse,
  sourceResponse: Response,
  responseBudget: ResourceBudget,
  maxResponseBytes: number,
) {
  const response = await boundHttpResponse(sourceResponse, maxResponseBytes, responseBudget);
  const streaming = response.headers
    .get("content-type")
    ?.toLowerCase()
    .startsWith("text/event-stream");
  nodeResponse.statusCode = response.status;
  nodeResponse.statusMessage = response.statusText;
  response.headers.forEach((value, key) => nodeResponse.setHeader(key, value));
  if (!response.body) {
    nodeResponse.end();
    return;
  }

  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (!streaming && total > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        nodeResponse.destroy(new BrokerCapacityError("capacity-exceeded", "maxHttpResponseBytes"));
        return;
      }
      const reservation = streaming ? null : responseBudget.tryReserve(value.byteLength);
      if (!streaming && !reservation) {
        await reader.cancel().catch(() => {});
        nodeResponse.destroy(new BrokerCapacityError("busy", "maxInFlightHttpResponseBytes"));
        return;
      }
      await new Promise<void>((resolve, reject) => {
        nodeResponse.write(value, (error) => {
          reservation?.release();
          if (error) reject(error);
          else resolve();
        });
      });
    }
    nodeResponse.end();
  } finally {
    reader.releaseLock();
  }
}

/** Serve one runtime-neutral broker daemon through Node HTTP and ws. */
export async function serveSessionBrokerDaemon<
  SessionView = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
>(
  options: ServeSessionBrokerDaemonOptions<SessionView, ServerMessage, CommandResult>,
): Promise<RunningSessionBrokerDaemon> {
  const inboundBudget = new ResourceBudget(
    options.daemon.limits.maxInFlightWsBytes,
    "maxInFlightWsBytes",
  );
  const outboundBudget = new ResourceBudget(
    options.daemon.limits.maxOutboundBytesTotal,
    "maxOutboundBytesTotal",
    "busy",
  );
  const responseBudget = new ResourceBudget(
    options.daemon.limits.maxInFlightHttpResponseBytes,
    "maxInFlightHttpResponseBytes",
    "busy",
  );
  const activeHttpHandlers = new Set<Promise<void>>();
  let stopping = false;
  let server!: ReturnType<typeof createServer>;
  server = createServer((incoming, outgoing) => {
    const task = (async () => {
      if (stopping) {
        outgoing.statusCode = 503;
        outgoing.end();
        return;
      }
      const request = await toRequest(incoming, options.hostname, options.port);
      const customResponse = await options.handleRequest?.(request, server);
      if (customResponse !== undefined) {
        await writeResponse(
          outgoing,
          customResponse,
          responseBudget,
          options.daemon.limits.maxHttpResponseBytes,
        );
        return;
      }

      const daemonResponse = await options.daemon.handleRequest(request);
      if (daemonResponse) {
        await writeResponse(
          outgoing,
          daemonResponse,
          responseBudget,
          options.daemon.limits.maxHttpResponseBytes,
        );
        return;
      }

      await writeResponse(
        outgoing,
        (await options.notFound?.(request)) ?? defaultNotFound(),
        responseBudget,
        options.daemon.limits.maxHttpResponseBytes,
      );
    })().catch((error: unknown) => {
      // Node ignores promises returned by request listeners. Contain late handler/write failures so
      // forced socket teardown cannot become an unhandled rejection.
      if (!outgoing.destroyed) outgoing.destroy(error instanceof Error ? error : undefined);
    });
    activeHttpHandlers.add(task);
    void task.then(() => activeHttpHandlers.delete(task));
  });
  const unauthenticatedSocketBudget = new ResourceBudget(
    options.daemon.limits.maxUnauthenticatedSockets,
    "maxUnauthenticatedSockets",
    "busy",
  );
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max(1, options.daemon.limits.maxWsMessageBytes),
  });
  // Reuse one stable peer wrapper per websocket so close events unregister the same logical
  // connection object that registration and message handling used earlier.
  const peerBySocket = new WeakMap<WebSocket, SessionBrokerPeer>();
  const admissionBySocket = new WeakMap<WebSocket, BudgetReservation>();
  const handshakeTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>();
  const activeWebSockets = new Set<WebSocket>();
  const activeSockets = new Set<Socket>();
  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });
  let resolved = false;
  let resolveStopped: (() => void) | null = null;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const finish = () => {
    if (resolved) {
      return;
    }

    resolved = true;
    resolveStopped?.();
    resolveStopped = null;
  };

  webSocketServer.on("connection", (socket: WebSocket) => {
    activeWebSockets.add(socket);
    const markAuthenticated = () => {
      admissionBySocket.get(socket)?.release();
      admissionBySocket.delete(socket);
      const timer = handshakeTimers.get(socket);
      if (timer) clearTimeout(timer);
      handshakeTimers.delete(socket);
    };
    const peer = toNodeConnection(
      socket,
      outboundBudget,
      options.daemon.limits.maxOutboundBytesPerPeer,
      markAuthenticated,
    );
    if (options.daemon.requiresProducerAuthentication) {
      const timer = setTimeout(() => {
        socket.close(1008, "Session broker authentication timed out.");
      }, options.daemon.limits.maxHandshakeDurationMs);
      timer.unref?.();
      handshakeTimers.set(socket, timer);
    } else {
      markAuthenticated();
    }
    peerBySocket.set(socket, peer);
    socket.on("message", (message: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (stopping) {
        socket.close(1001, "Session broker shutting down.");
        return;
      }
      if (isBinary) {
        socket.close(1003, "Session broker accepts text messages only.");
        return;
      }
      const byteLength = Array.isArray(message)
        ? message.reduce((total, chunk) => total + chunk.byteLength, 0)
        : message.byteLength;
      if (byteLength > options.daemon.limits.maxWsMessageBytes) {
        socket.close(1009, "Message exceeds the session broker size limit.");
        return;
      }
      const reservation = inboundBudget.tryReserve(byteLength);
      if (!reservation) {
        socket.close(1013, "Session broker inbound pressure exceeded.");
        return;
      }
      try {
        // ws usually supplies one Buffer. Concatenate only fragmented array variants, and create a
        // zero-copy Buffer view for ArrayBuffer so broker accounting covers any required copy.
        const bytes = Array.isArray(message)
          ? Buffer.concat(message, byteLength)
          : message instanceof ArrayBuffer
            ? Buffer.from(message)
            : message;
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          socket.close(1007, "Malformed UTF-8 session broker message.");
          return;
        }
        try {
          options.daemon.handleConnectionMessage(peer, text);
        } catch (error) {
          socket.close(
            error instanceof BrokerCapacityError ? 1013 : 1011,
            "Session broker message handling failed.",
          );
        }
      } finally {
        reservation.release();
      }
    });
    // ws reports maxPayload violations through an error event before its protocol close. Keep the
    // process alive while ws completes the required 1009 close handshake.
    socket.on("error", () => {});
    socket.on("close", (code: number, reason: Buffer) => {
      activeWebSockets.delete(socket);
      const timer = handshakeTimers.get(socket);
      if (timer) clearTimeout(timer);
      handshakeTimers.delete(socket);
      admissionBySocket.get(socket)?.release();
      admissionBySocket.delete(socket);
      options.daemon.handleConnectionClose(peerBySocket.get(socket) ?? peer);
      // The runtime-neutral daemon only cares that the transport closed; Node-specific close data
      // stays ignored here instead of leaking into the shared broker API.
      void code;
      void reason;
    });
  });

  server.on("upgrade", (request, socket, head) => {
    if (stopping) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    let pathname: string;
    try {
      const target = request.url;
      if (!target?.startsWith("/") || target.startsWith("//")) {
        throw new TypeError("Expected an origin-form WebSocket request target.");
      }
      pathname = new URL(target, `http://${options.hostname}:${options.port}`).pathname;
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!options.daemon.matchesSocketPath(pathname)) {
      socket.destroy();
      return;
    }

    const admission = unauthenticatedSocketBudget.tryReserve();
    if (!admission) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    socket.once("close", () => admission.release());
    try {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket: WebSocket) => {
        if (stopping) {
          admission.release();
          webSocket.terminate();
          return;
        }
        admissionBySocket.set(webSocket, admission);
        webSocketServer.emit("connection", webSocket, request);
      });
    } catch {
      admission.release();
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(
        (options.formatServeError ?? defaultServeError)(error, {
          hostname: options.hostname,
          port: options.port,
        }),
      );
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.hostname);
  });

  let stopPromise: Promise<void> | null = null;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      // Reject new HTTP/upgrades and broker work before snapshotting and terminating active peers.
      stopping = true;
      options.daemon.shutdown();
      const peerClosures = [...activeWebSockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === socket.CLOSED) return resolve();
            socket.once("close", () => resolve());
            socket.terminate();
          }),
      );
      for (const socket of activeSockets) socket.destroy();
      await Promise.all(peerClosures);
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      const closeServer = () => {
        server.close();
        server.closeAllConnections();
      };
      if ((globalThis as { Bun?: unknown }).Bun) {
        // Bun's Node compatibility layer does not consistently emit Server's close callback after
        // upgraded sockets are terminated; the real Node path below still awaits native closure.
        closeServer();
      } else {
        await new Promise<void>((resolve, reject) => {
          server.once("close", resolve);
          server.once("error", reject);
          closeServer();
        });
      }
      while (activeHttpHandlers.size > 0) {
        await Promise.all(activeHttpHandlers);
      }
      finish();
    })();
    return stopPromise;
  };

  void options.daemon.stopped.then(async () => {
    try {
      // Reuse the same stop path when the daemon requests shutdown for idleness so manual and
      // automatic teardown keep identical ordering.
      await stop();
    } catch {
      finish();
    }
  });

  return {
    server,
    stopped,
    stop,
    address: () => server.address(),
  };
}
