import type {
  SessionBrokerSocketCloseEvent,
  SessionBrokerSocketLike,
  SessionBrokerSocketMessageEvent,
} from "@hunk/session-broker";

/** Platform websocket members the adapter reads; tests supply a structural double. */
export type SessionBrokerPlatformWebSocket = Pick<
  WebSocket,
  "readyState" | "send" | "close" | "onopen" | "onmessage" | "onclose" | "onerror"
>;

/**
 * Wraps one Bun/browser `WebSocket` as the runtime-neutral broker socket shape.
 *
 * DOM events stay on this side of the boundary: messages become `{ data }`, closes become
 * `{ code, reason }`, and open/error callbacks receive no event.
 */
export class SessionBrokerWebSocketAdapter implements SessionBrokerSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: SessionBrokerSocketMessageEvent) => void) | null = null;
  onclose: ((event: SessionBrokerSocketCloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(private readonly socket: SessionBrokerPlatformWebSocket) {
    socket.onopen = () => this.onopen?.();
    socket.onmessage = (event) => this.onmessage?.({ data: event.data });
    socket.onclose = (event) => this.onclose?.({ code: event.code, reason: event.reason });
    socket.onerror = () => this.onerror?.();
  }

  get readyState() {
    return this.socket.readyState;
  }

  send(data: string) {
    this.socket.send(data);
  }

  close(code?: number, reason?: string) {
    this.socket.close(code, reason);
  }
}

/** Open one platform `WebSocket` and adapt it for `createSessionBrokerConnection`. */
export function createSessionBrokerWebSocket(url: string): SessionBrokerSocketLike {
  return new SessionBrokerWebSocketAdapter(new WebSocket(url));
}
