import type { SessionServerMessage } from "@hunk/session-broker-core";
import type { SessionBrokerDaemon } from "@hunk/session-broker";

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
    server: ReturnType<typeof Bun.serve<{}>>,
  ) => Response | Promise<Response | undefined> | undefined;
  notFound?: (request: Request) => Response | Promise<Response>;
  formatServeError?: (error: unknown, address: { hostname: string; port: number }) => Error;
}

export type RunningSessionBrokerDaemon = ReturnType<typeof Bun.serve<{}>> & {
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

  let server: ReturnType<typeof Bun.serve<{}>>;
  try {
    server = Bun.serve<{}>({
      hostname: options.hostname,
      port: options.port,
      fetch: async (request, bunServer) => {
        const customResponse = await options.handleRequest?.(request, bunServer);
        // Let host apps extend or override routes first; the generic daemon only handles the
        // broker's shared HTTP surface plus the websocket upgrade path.
        if (customResponse !== undefined) {
          return customResponse;
        }

        const daemonResponse = await options.daemon.handleRequest(request);
        if (daemonResponse) {
          return daemonResponse;
        }

        const url = new URL(request.url);
        if (options.daemon.matchesSocketPath(url.pathname)) {
          if (bunServer.upgrade(request, { data: {} })) {
            return undefined;
          }

          // Bun signals failed upgrades by returning false from upgrade rather than by throwing,
          // so surface that as one explicit HTTP response here.

          return new Response("Expected websocket upgrade.", { status: 426 });
        }

        return (await options.notFound?.(request)) ?? defaultNotFound();
      },
      websocket: {
        message: (socket, message) => {
          if (typeof message !== "string") {
            return;
          }

          options.daemon.handleConnectionMessage(socket, message);
        },
        close: (socket) => {
          options.daemon.handleConnectionClose(socket);
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
    originalStop(true);
    finish();
  });

  return Object.assign(server, { stopped }) as RunningSessionBrokerDaemon;
}
