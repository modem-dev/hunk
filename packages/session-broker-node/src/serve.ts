import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import type { SessionServerMessage } from "@hunk/session-broker-core";
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

function toNodeConnection(socket: WebSocket): SessionBrokerPeer {
  return {
    send(data: string) {
      socket.send(data);
    },
    close(code?: number, reason?: string) {
      socket.close(code, reason);
    },
  };
}

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

async function writeResponse(nodeResponse: ServerResponse, response: Response) {
  nodeResponse.statusCode = response.status;
  nodeResponse.statusMessage = response.statusText;

  response.headers.forEach((value, key) => {
    nodeResponse.setHeader(key, value);
  });

  if (!response.body) {
    nodeResponse.end();
    return;
  }

  const body = Buffer.from(await response.arrayBuffer());
  nodeResponse.end(body);
}

/** Serve one runtime-neutral broker daemon through Node HTTP and ws. */
export async function serveSessionBrokerDaemon<
  SessionView = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
>(
  options: ServeSessionBrokerDaemonOptions<SessionView, ServerMessage, CommandResult>,
): Promise<RunningSessionBrokerDaemon> {
  const server = createServer(async (incoming, outgoing) => {
    const request = await toRequest(incoming, options.hostname, options.port);
    const customResponse = await options.handleRequest?.(request, server);
    if (customResponse !== undefined) {
      await writeResponse(outgoing, customResponse);
      return;
    }

    const daemonResponse = await options.daemon.handleRequest(request);
    if (daemonResponse) {
      await writeResponse(outgoing, daemonResponse);
      return;
    }

    await writeResponse(outgoing, (await options.notFound?.(request)) ?? defaultNotFound());
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  const peerBySocket = new WeakMap<WebSocket, SessionBrokerPeer>();
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
    const peer = toNodeConnection(socket);
    peerBySocket.set(socket, peer);
    socket.on("message", (message: string | Buffer | ArrayBuffer | Buffer[]) => {
      const text =
        typeof message === "string"
          ? message
          : Array.isArray(message)
            ? Buffer.concat(message).toString()
            : message instanceof ArrayBuffer
              ? Buffer.from(new Uint8Array(message)).toString()
              : Buffer.from(message).toString();
      options.daemon.handleConnectionMessage(peer, text);
    });
    socket.on("close", (code: number, reason: Buffer) => {
      options.daemon.handleConnectionClose(peerBySocket.get(socket) ?? peer);
      void code;
      void reason;
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(`http://${options.hostname}:${options.port}${request.url ?? "/"}`)
      .pathname;
    if (!options.daemon.matchesSocketPath(pathname)) {
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket: WebSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
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

  const stop = async () => {
    options.daemon.shutdown();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    finish();
  };

  void options.daemon.stopped.then(async () => {
    try {
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
