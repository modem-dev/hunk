import {
  BrokerCapacityError,
  ResourceBudget,
  boundHttpResponse,
  utf8ByteLength,
  type BudgetReservation,
  type SessionServerMessage,
} from "@hunk/session-broker-core";
import type { SessionBrokerDaemon, SessionBrokerPeer } from "@hunk/session-broker";

interface BrokerWebSocketData {
  admission: BudgetReservation;
  handshakeTimer?: ReturnType<typeof setTimeout>;
}

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
    server: ReturnType<typeof Bun.serve<BrokerWebSocketData>>,
  ) => Response | Promise<Response | undefined> | undefined;
  notFound?: (request: Request) => Response | Promise<Response>;
  formatServeError?: (error: unknown, address: { hostname: string; port: number }) => Error;
}

export type RunningSessionBrokerDaemon = ReturnType<typeof Bun.serve<BrokerWebSocketData>> & {
  stopped: Promise<void>;
};

function defaultNotFound() {
  return new Response("Not found.", { status: 404 });
}

function defaultServeError(error: unknown, address: { hostname: string; port: number }) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `Failed to start the session broker server on ${address.hostname}:${address.port}: ${message}`,
  );
}

/** Bound one Bun response and release retained body capacity when HEAD suppresses delivery. */
async function finalizeHttpResponse(
  request: Request,
  response: Response,
  maxBytes: number,
  budget: ResourceBudget,
) {
  const bounded = await boundHttpResponse(response, maxBytes, budget);
  if (request.method !== "HEAD" || !bounded.body) return bounded;
  await bounded.body.cancel().catch(() => {});
  return new Response(null, {
    status: bounded.status,
    statusText: bounded.statusText,
    headers: bounded.headers,
  });
}

/** Serve one runtime-neutral broker daemon through Bun's HTTP and websocket runtime. */
export function serveSessionBrokerDaemon<
  SessionView = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
>(
  options: ServeSessionBrokerDaemonOptions<SessionView, ServerMessage, CommandResult>,
): RunningSessionBrokerDaemon {
  const inboundBudget = new ResourceBudget(
    options.daemon.limits.maxInFlightWsBytes,
    "maxInFlightWsBytes",
  );
  const outboundBudget = new ResourceBudget(
    options.daemon.limits.maxOutboundBytesTotal,
    "maxOutboundBytesTotal",
    "busy",
  );
  const unauthenticatedSocketBudget = new ResourceBudget(
    options.daemon.limits.maxUnauthenticatedSockets,
    "maxUnauthenticatedSockets",
    "busy",
  );
  const responseBudget = new ResourceBudget(
    options.daemon.limits.maxInFlightHttpResponseBytes,
    "maxInFlightHttpResponseBytes",
    "busy",
  );
  const bufferedReservations = new Map<object, BudgetReservation>();
  const activeAdmissions = new Set<BudgetReservation>();
  const peers = new WeakMap<object, SessionBrokerPeer>();
  let transportStopStarted = false;
  let transportStopSettled = false;
  let activeHttpHandlers = 0;
  const maybeFinishTransportStop = () => {
    // Bun may leave its stop promise pending after every peer close callback has fired. Either the
    // runtime promise or an empty admitted-peer set proves no socket can deliver another message.
    if (
      !transportStopStarted ||
      activeHttpHandlers !== 0 ||
      (!transportStopSettled && activeAdmissions.size !== 0)
    )
      return;
    for (const reservation of bufferedReservations.values()) reservation.release();
    bufferedReservations.clear();
    for (const admission of activeAdmissions) admission.release();
    activeAdmissions.clear();
    finish();
  };
  const peerFor = (socket: {
    send(data: string): number;
    close(code?: number, reason?: string): void;
    getBufferedAmount?(): number;
  }): SessionBrokerPeer => {
    const key = socket as object;
    const existing = peers.get(key);
    if (existing) return existing;
    const peer: SessionBrokerPeer = {
      send(data) {
        const bytes = utf8ByteLength(data);
        const buffered = socket.getBufferedAmount?.() ?? 0;
        if (bytes > options.daemon.limits.maxOutboundBytesPerPeer - buffered) {
          socket.close(1013, "Session broker outbound pressure exceeded.");
          throw new BrokerCapacityError("busy", "maxOutboundBytesPerPeer");
        }
        const previous = bufferedReservations.get(key);
        let provisional: BudgetReservation;
        try {
          provisional = previous
            ? outboundBudget.resize(previous, buffered + bytes)
            : outboundBudget.reserve(buffered + bytes);
        } catch {
          socket.close(1013, "Session broker outbound pressure exceeded.");
          throw new BrokerCapacityError("busy", "maxOutboundBytesTotal");
        }
        bufferedReservations.set(key, provisional);
        try {
          const sent = socket.send(data);
          if (sent === 0) {
            socket.close(1013, "Session broker outbound pressure exceeded.");
            throw new BrokerCapacityError("busy", "maxOutboundBytesPerPeer");
          }
          const remaining = socket.getBufferedAmount?.() ?? 0;
          if (remaining === 0) {
            bufferedReservations.delete(key);
            provisional.release();
          } else {
            bufferedReservations.set(key, outboundBudget.resize(provisional, remaining));
          }
        } catch (error) {
          // A dropped send retains the provisional bound until close; other failures release now.
          if (socket.getBufferedAmount?.() === 0) {
            bufferedReservations.delete(key);
            provisional.release();
          }
          throw error;
        }
      },
      close: (code, reason) => socket.close(code, reason),
      markAuthenticated() {
        const data = (socket as typeof socket & { data?: BrokerWebSocketData }).data;
        if (!data) return;
        if (data.handshakeTimer) {
          clearTimeout(data.handshakeTimer);
          data.handshakeTimer = undefined;
        }
        activeAdmissions.delete(data.admission);
        data.admission.release();
      },
    };
    peers.set(key, peer);
    return peer;
  };
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

  let server: ReturnType<typeof Bun.serve<BrokerWebSocketData>>;
  try {
    server = Bun.serve<BrokerWebSocketData>({
      hostname: options.hostname,
      port: options.port,
      fetch: async (request, bunServer) => {
        activeHttpHandlers += 1;
        try {
          const customResponse = await options.handleRequest?.(request, bunServer);
          // Let host apps extend or override routes first; the generic daemon only handles the
          // broker's shared HTTP surface plus the websocket upgrade path.
          if (customResponse !== undefined) {
            return await finalizeHttpResponse(
              request,
              customResponse,
              options.daemon.limits.maxHttpResponseBytes,
              responseBudget,
            );
          }

          const daemonResponse = await options.daemon.handleRequest(request);
          if (daemonResponse) {
            return await finalizeHttpResponse(
              request,
              daemonResponse,
              options.daemon.limits.maxHttpResponseBytes,
              responseBudget,
            );
          }

          const url = new URL(request.url);
          if (options.daemon.matchesSocketPath(url.pathname)) {
            const admission = unauthenticatedSocketBudget.tryReserve();
            if (!admission) return new Response(null, { status: 503 });
            activeAdmissions.add(admission);
            try {
              if (bunServer.upgrade(request, { data: { admission } })) {
                return undefined;
              }
            } catch (error) {
              activeAdmissions.delete(admission);
              admission.release();
              throw error;
            }
            activeAdmissions.delete(admission);
            admission.release();

            // Bun signals failed upgrades by returning false from upgrade rather than by throwing,
            // so surface that as one explicit HTTP response here.
            return new Response("Expected websocket upgrade.", { status: 426 });
          }

          return await finalizeHttpResponse(
            request,
            (await options.notFound?.(request)) ?? defaultNotFound(),
            options.daemon.limits.maxHttpResponseBytes,
            responseBudget,
          );
        } finally {
          activeHttpHandlers -= 1;
          maybeFinishTransportStop();
        }
      },
      websocket: {
        open: (socket) => {
          if (!options.daemon.requiresProducerAuthentication) {
            activeAdmissions.delete(socket.data.admission);
            socket.data.admission.release();
            return;
          }
          socket.data.handshakeTimer = setTimeout(() => {
            socket.close(1008, "Session broker authentication timed out.");
          }, options.daemon.limits.maxHandshakeDurationMs);
          socket.data.handshakeTimer.unref?.();
        },
        // Bun bounds native frame assembly per message but exposes no accounting hook before it
        // delivers the decoded string. The broker budget below covers only application processing.
        maxPayloadLength: Math.max(1, options.daemon.limits.maxWsMessageBytes),
        message: (socket, message) => {
          const peer = peerFor(socket);
          if (typeof message !== "string") {
            socket.close(1003, "Session broker accepts text messages only.");
            return;
          }

          const bytes = utf8ByteLength(message);
          if (bytes > options.daemon.limits.maxWsMessageBytes) {
            socket.close(1009, "Message exceeds the session broker size limit.");
            return;
          }
          const reservation = inboundBudget.tryReserve(bytes);
          if (!reservation) {
            socket.close(1013, "Session broker inbound pressure exceeded.");
            return;
          }
          try {
            options.daemon.handleConnectionMessage(peer, message);
          } catch (error) {
            socket.close(
              error instanceof BrokerCapacityError ? 1013 : 1011,
              "Session broker message handling failed.",
            );
          } finally {
            reservation.release();
          }
        },
        drain: (socket) => {
          const key = socket as object;
          const previous = bufferedReservations.get(key);
          if (!previous) return;
          const remaining = socket.getBufferedAmount();
          if (remaining === 0) {
            bufferedReservations.delete(key);
            previous.release();
          } else {
            bufferedReservations.set(key, outboundBudget.resize(previous, remaining));
          }
        },
        close: (socket) => {
          const key = socket as object;
          if (socket.data.handshakeTimer) clearTimeout(socket.data.handshakeTimer);
          bufferedReservations.get(key)?.release();
          bufferedReservations.delete(key);
          activeAdmissions.delete(socket.data.admission);
          socket.data.admission.release();
          options.daemon.handleConnectionClose(peerFor(socket));
          maybeFinishTransportStop();
        },
      },
    });
  } catch (error) {
    throw (options.formatServeError ?? defaultServeError)(error, {
      hostname: options.hostname,
      port: options.port,
    });
  }

  const originalStop = server.stop.bind(server);
  let transportStopResult!: ReturnType<typeof originalStop>;
  const beginTransportStop = () => {
    if (!transportStopStarted) {
      transportStopStarted = true;
      // The portable broker contract refuses new work and closes active peers on shutdown. Bun's
      // graceful `stop(false)` would keep those peers live, so the adapter always forces closure.
      transportStopResult = originalStop(true);
      void Promise.resolve(transportStopResult).then(
        () => {
          transportStopSettled = true;
          maybeFinishTransportStop();
        },
        () => {
          transportStopSettled = true;
          maybeFinishTransportStop();
        },
      );
      maybeFinishTransportStop();
    }
    return transportStopResult;
  };
  const stop: typeof server.stop = (_closeActiveConnections) => {
    // Transition semantic state before asking Bun to close peers so no message delivered during
    // shutdown can admit fresh broker work. Reservations stay live through each close callback.
    options.daemon.shutdown();
    return beginTransportStop();
  };

  Object.defineProperty(server, "stop", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: stop,
  });

  void options.daemon.stopped.then(() => beginTransportStop());

  return Object.assign(server, { stopped }) as RunningSessionBrokerDaemon;
}
