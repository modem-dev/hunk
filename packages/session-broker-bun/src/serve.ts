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
    options.daemon.limits.maxHttpResponseBytes,
    "maxHttpResponseBytes",
    "busy",
  );
  const bufferedReservations = new Map<object, BudgetReservation>();
  const activeAdmissions = new Set<BudgetReservation>();
  const peers = new WeakMap<object, SessionBrokerPeer>();
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
        const customResponse = await options.handleRequest?.(request, bunServer);
        // Let host apps extend or override routes first; the generic daemon only handles the
        // broker's shared HTTP surface plus the websocket upgrade path.
        if (customResponse !== undefined) {
          return boundHttpResponse(
            customResponse,
            options.daemon.limits.maxHttpResponseBytes,
            responseBudget,
          );
        }

        const daemonResponse = await options.daemon.handleRequest(request);
        if (daemonResponse) {
          return boundHttpResponse(
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
          if (bunServer.upgrade(request, { data: { admission } })) {
            return undefined;
          }
          activeAdmissions.delete(admission);
          admission.release();

          // Bun signals failed upgrades by returning false from upgrade rather than by throwing,
          // so surface that as one explicit HTTP response here.

          return new Response("Expected websocket upgrade.", { status: 426 });
        }

        return boundHttpResponse(
          (await options.notFound?.(request)) ?? defaultNotFound(),
          options.daemon.limits.maxHttpResponseBytes,
          responseBudget,
        );
      },
      websocket: {
        // Bun cannot customize the close code of its native payload rejection. Keep the native cap
        // at the fixed aggregate ceiling so decoded messages above the per-message limit reach the
        // portable 1009 path while runtime buffering remains bounded.
        maxPayloadLength: Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.max(
            options.daemon.limits.maxWsMessageBytes + 1,
            options.daemon.limits.maxInFlightWsBytes,
          ),
        ),
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
          bufferedReservations.get(key)?.release();
          bufferedReservations.delete(key);
          activeAdmissions.delete(socket.data.admission);
          socket.data.admission.release();
          options.daemon.handleConnectionClose(peerFor(socket));
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
  const stop: typeof server.stop = (closeActiveConnections) => {
    // Wrap Bun's stop so callers do not need to remember that the daemon and transport have to be
    // torn down together.
    options.daemon.shutdown();
    for (const reservation of bufferedReservations.values()) reservation.release();
    bufferedReservations.clear();
    for (const admission of activeAdmissions) admission.release();
    activeAdmissions.clear();
    const result = originalStop(closeActiveConnections);
    finish();
    return result;
  };

  Object.defineProperty(server, "stop", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: stop,
  });

  void options.daemon.stopped.then(() => {
    // Idle shutdown and manual stop share one completion promise, but the Bun server only needs
    // the original transport stop here because the daemon has already transitioned to stopped.
    for (const reservation of bufferedReservations.values()) reservation.release();
    bufferedReservations.clear();
    for (const admission of activeAdmissions) admission.release();
    activeAdmissions.clear();
    originalStop(true);
    finish();
  });

  return Object.assign(server, { stopped }) as RunningSessionBrokerDaemon;
}
