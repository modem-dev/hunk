import { describe, expect, test } from "bun:test";
import { SessionBrokerWebSocketAdapter, type SessionBrokerPlatformWebSocket } from "./socket";

/** Record calls and expose the DOM handlers the adapter installs. */
class PlatformWebSocketTest implements SessionBrokerPlatformWebSocket {
  readyState = 0;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  onopen: SessionBrokerPlatformWebSocket["onopen"] = null;
  onmessage: SessionBrokerPlatformWebSocket["onmessage"] = null;
  onclose: SessionBrokerPlatformWebSocket["onclose"] = null;
  onerror: SessionBrokerPlatformWebSocket["onerror"] = null;

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closes.push([code, reason]);
  }

  /** Invoke one installed handler the way the platform would. */
  dispatch<Key extends "onopen" | "onmessage" | "onclose" | "onerror">(key: Key, event: Event) {
    const handler = this[key] as ((this: WebSocket, event: Event) => unknown) | null;
    handler?.call(this as unknown as WebSocket, event);
  }
}

describe("SessionBrokerWebSocketAdapter", () => {
  test("forwards readyState, send, and close to the platform socket", () => {
    const platform = new PlatformWebSocketTest();
    const socket = new SessionBrokerWebSocketAdapter(platform);

    platform.readyState = 1;
    socket.send("hello");
    socket.close(1000, "done");
    socket.close();

    expect(socket.readyState).toBe(1);
    expect(platform.sent).toEqual(["hello"]);
    expect(platform.closes).toEqual([
      [1000, "done"],
      [undefined, undefined],
    ]);
  });

  test("normalizes open, message, close, and error events", () => {
    const platform = new PlatformWebSocketTest();
    const socket = new SessionBrokerWebSocketAdapter(platform);
    const received: unknown[][] = [];
    socket.onopen = (...args: unknown[]) => received.push(["open", ...args]);
    socket.onmessage = (...args: unknown[]) => received.push(["message", ...args]);
    socket.onclose = (...args: unknown[]) => received.push(["close", ...args]);
    socket.onerror = (...args: unknown[]) => received.push(["error", ...args]);

    platform.dispatch("onopen", new Event("open"));
    platform.dispatch("onmessage", new MessageEvent("message", { data: '{"type":"ping"}' }));
    platform.dispatch("onerror", new Event("error"));
    platform.dispatch("onclose", new CloseEvent("close", { code: 4001, reason: "stale" }));

    expect(received).toEqual([
      ["open"],
      ["message", { data: '{"type":"ping"}' }],
      ["error"],
      ["close", { code: 4001, reason: "stale" }],
    ]);
  });

  test("ignores platform events while no broker handler is attached", () => {
    const platform = new PlatformWebSocketTest();
    new SessionBrokerWebSocketAdapter(platform);

    expect(() => {
      platform.dispatch("onopen", new Event("open"));
      platform.dispatch("onmessage", new MessageEvent("message", { data: "x" }));
      platform.dispatch("onclose", new CloseEvent("close", { code: 1000 }));
      platform.dispatch("onerror", new Event("error"));
    }).not.toThrow();
  });
});
