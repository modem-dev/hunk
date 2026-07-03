import { describe, expect, test } from "bun:test";
import { createTestListedSession } from "../../test/helpers/session-daemon-fixtures";
import type { HunkSessionBrokerState } from "../hunk-session/brokerAdapter";
import type { SessionDaemonRequest } from "../session/protocol";
import {
  formatDaemonServeError,
  handleSessionApiRequest,
  isAllowedHostPort,
  parseHostAndPort,
  validateHostHeader,
  validateOriginHeader,
} from "./brokerServer";

const PORT = 7000;

/** Build a POST session-API request with a JSON body for the given daemon action. */
function apiRequest(body: SessionDaemonRequest) {
  return new Request(`http://127.0.0.1:${PORT}/session-api`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("formatDaemonServeError", () => {
  test("maps address-in-use failures to a port-conflict hint", () => {
    const err = formatDaemonServeError(new Error("listen EADDRINUSE"), "127.0.0.1", PORT);
    expect(err.message).toContain("already in use");
    expect(err.message).toContain(`127.0.0.1:${PORT}`);
  });

  test("falls back to a generic start failure for other errors", () => {
    const err = formatDaemonServeError(new Error("boom"), "127.0.0.1", PORT);
    expect(err.message).toContain("Failed to start the session broker daemon");
    expect(err.message).toContain("boom");
  });

  test("stringifies non-Error throwables", () => {
    const err = formatDaemonServeError("plain string", "127.0.0.1", PORT);
    expect(err.message).toContain("plain string");
  });
});

describe("parseHostAndPort", () => {
  test("returns null for empty input", () => {
    expect(parseHostAndPort("   ")).toBeNull();
  });

  test("parses a bare host with no port", () => {
    expect(parseHostAndPort("127.0.0.1")).toEqual({ host: "127.0.0.1", port: undefined });
  });

  test("parses host:port", () => {
    expect(parseHostAndPort("127.0.0.1:7000")).toEqual({ host: "127.0.0.1", port: 7000 });
  });

  test("rejects host:port with a non-numeric port", () => {
    expect(parseHostAndPort("127.0.0.1:abc")).toBeNull();
  });

  test("parses a bracketed IPv6 literal with a port", () => {
    expect(parseHostAndPort("[::1]:7000")).toEqual({ host: "::1", port: 7000 });
  });

  test("parses a bracketed IPv6 literal without a port", () => {
    expect(parseHostAndPort("[::1]")).toEqual({ host: "::1", port: undefined });
  });

  test("rejects an unterminated bracket", () => {
    expect(parseHostAndPort("[::1")).toBeNull();
  });

  test("rejects bracketed host with trailing junk that is not a port", () => {
    expect(parseHostAndPort("[::1]x")).toBeNull();
  });

  test("rejects a bracketed host with a zero port", () => {
    expect(parseHostAndPort("[::1]:0")).toBeNull();
  });

  test("tolerates an unbracketed IPv6 literal by dropping the port", () => {
    expect(parseHostAndPort("::1")).toEqual({ host: "::1", port: undefined });
  });
});

describe("isAllowedHostPort", () => {
  test("accepts a loopback host on the expected port", () => {
    expect(isAllowedHostPort({ host: "127.0.0.1", port: PORT }, PORT, { allowRemote: false })).toBe(
      true,
    );
  });

  test("defaults a missing port to 80 and rejects it against a non-80 broker", () => {
    expect(isAllowedHostPort({ host: "127.0.0.1" }, PORT, { allowRemote: false })).toBe(false);
  });

  test("rejects a non-loopback host unless remote is allowed", () => {
    expect(isAllowedHostPort({ host: "10.0.0.5", port: PORT }, PORT, { allowRemote: false })).toBe(
      false,
    );
    expect(isAllowedHostPort({ host: "10.0.0.5", port: PORT }, PORT, { allowRemote: true })).toBe(
      true,
    );
  });
});

describe("validateHostHeader", () => {
  test("rejects a request with no Host header", () => {
    const result = validateHostHeader(new Request(`http://127.0.0.1:${PORT}/`), PORT, false);
    expect(result?.status).toBe(400);
  });

  test("rejects a Host that names a disallowed endpoint", () => {
    const request = new Request(`http://127.0.0.1:${PORT}/`, {
      headers: { host: "evil.com:7000" },
    });
    expect(validateHostHeader(request, PORT, false)?.status).toBe(403);
  });

  test("accepts a loopback Host on the expected port", () => {
    const request = new Request(`http://127.0.0.1:${PORT}/`, {
      headers: { host: `127.0.0.1:${PORT}` },
    });
    expect(validateHostHeader(request, PORT, false)).toBeNull();
  });
});

describe("validateOriginHeader", () => {
  test("allows requests with no Origin header", () => {
    expect(validateOriginHeader(new Request(`http://127.0.0.1:${PORT}/`), PORT, false)).toBeNull();
  });

  test("rejects a malformed Origin value", () => {
    const request = new Request(`http://127.0.0.1:${PORT}/`, { headers: { origin: "not a url" } });
    expect(validateOriginHeader(request, PORT, false)?.status).toBe(403);
  });

  test("rejects a non-http(s) Origin scheme", () => {
    const request = new Request(`http://127.0.0.1:${PORT}/`, {
      headers: { origin: "file://localhost" },
    });
    expect(validateOriginHeader(request, PORT, false)?.status).toBe(403);
  });

  test("rejects a cross-origin browser request", () => {
    const request = new Request(`http://127.0.0.1:${PORT}/`, {
      headers: { origin: "http://evil.com" },
    });
    expect(validateOriginHeader(request, PORT, false)?.status).toBe(403);
  });

  test("accepts a loopback Origin on the expected port", () => {
    const request = new Request(`http://127.0.0.1:${PORT}/`, {
      headers: { origin: `http://127.0.0.1:${PORT}` },
    });
    expect(validateOriginHeader(request, PORT, false)).toBeNull();
  });
});

describe("handleSessionApiRequest", () => {
  /** Build a fake broker state recording dispatched commands and returning canned results. */
  function createFakeState(overrides: Partial<Record<string, unknown>> = {}) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const record =
      (method: string, result: unknown) =>
      (...args: unknown[]) => {
        calls.push({ method, args });
        return result;
      };
    const state = {
      listSessions: record("listSessions", [createTestListedSession({ sessionId: "s-1" })]),
      getSession: record("getSession", createTestListedSession({ sessionId: "s-1" })),
      getSelectedContext: record("getSelectedContext", { sessionId: "s-1" }),
      getSessionReview: record("getSessionReview", { title: "review" }),
      listComments: record("listComments", []),
      dispatchCommand: record("dispatchCommand", { ok: true }),
      ...overrides,
    } as unknown as HunkSessionBrokerState;
    return { state, calls };
  }

  test("rejects non-POST methods", async () => {
    const { state } = createFakeState();
    const response = await handleSessionApiRequest(
      state,
      new Request(`http://127.0.0.1:${PORT}/session-api`, { method: "GET" }),
    );
    expect(response.status).toBe(405);
  });

  test("requires a JSON content type", async () => {
    const { state } = createFakeState();
    const response = await handleSessionApiRequest(
      state,
      new Request(`http://127.0.0.1:${PORT}/session-api`, { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(415);
  });

  test("returns 400 for an unparseable JSON body", async () => {
    const { state } = createFakeState();
    const response = await handleSessionApiRequest(
      state,
      new Request(`http://127.0.0.1:${PORT}/session-api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      }),
    );
    expect(response.status).toBe(400);
  });

  test("routes list/get/context/review to the matching state methods", async () => {
    const { state, calls } = createFakeState();
    for (const action of ["list", "get", "context", "review"] as const) {
      const body = action === "list" ? { action } : { action, selector: { sessionId: "s-1" } };
      const response = await handleSessionApiRequest(
        state,
        apiRequest(body as SessionDaemonRequest),
      );
      expect(response.status).toBe(200);
    }
    expect(calls.map((c) => c.method)).toEqual([
      "listSessions",
      "getSession",
      "getSelectedContext",
      "getSessionReview",
    ]);
  });

  test("rejects a navigate request missing both hunk and line targets", async () => {
    const { state } = createFakeState();
    const response = await handleSessionApiRequest(
      state,
      apiRequest({ action: "navigate", selector: { sessionId: "s-1" } } as SessionDaemonRequest),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("navigate") });
  });

  test("dispatches a navigate command when a hunk number is supplied", async () => {
    const { state, calls } = createFakeState();
    const response = await handleSessionApiRequest(
      state,
      apiRequest({
        action: "navigate",
        selector: { sessionId: "s-1" },
        hunkNumber: 2,
      } as SessionDaemonRequest),
    );
    expect(response.status).toBe(200);
    const dispatch = calls.find((c) => c.method === "dispatchCommand");
    expect(dispatch).toBeDefined();
    // hunkNumber is 1-based on the wire and converted to a 0-based hunkIndex.
    const dispatchInput = (dispatch!.args[0] as { input: { hunkIndex: number } }).input;
    expect(dispatchInput.hunkIndex).toBe(1);
  });

  test("dispatches reload, comment-add, comment-rm, and comment-clear commands", async () => {
    const { state, calls } = createFakeState();
    const requests: SessionDaemonRequest[] = [
      {
        action: "reload",
        selector: { sessionId: "s-1" },
        nextInput: { kind: "show", ref: "HEAD~1", options: {} },
      } as SessionDaemonRequest,
      {
        action: "comment-add",
        selector: { sessionId: "s-1" },
        filePath: "a.ts",
        side: "new",
        line: 1,
        summary: "note",
        reveal: false,
      } as SessionDaemonRequest,
      {
        action: "comment-rm",
        selector: { sessionId: "s-1" },
        commentId: "c-1",
      } as SessionDaemonRequest,
      { action: "comment-clear", selector: { sessionId: "s-1" } } as SessionDaemonRequest,
    ];
    for (const body of requests) {
      const response = await handleSessionApiRequest(state, apiRequest(body));
      expect(response.status).toBe(200);
    }
    expect(calls.filter((c) => c.method === "dispatchCommand")).toHaveLength(4);
  });

  test("serves the live comment-list path from state.listComments", async () => {
    const { state, calls } = createFakeState();
    const response = await handleSessionApiRequest(
      state,
      apiRequest({
        action: "comment-list",
        selector: { sessionId: "s-1" },
      } as SessionDaemonRequest),
    );
    expect(response.status).toBe(200);
    expect(calls.some((c) => c.method === "listComments")).toBe(true);
  });

  test("serves the review-note comment-list path from the session snapshot", async () => {
    const { state } = createFakeState();
    const response = await handleSessionApiRequest(
      state,
      apiRequest({
        action: "comment-list",
        selector: { sessionId: "s-1" },
        type: "all",
      } as SessionDaemonRequest),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("comments");
  });

  test("returns 400 when a dispatched command rejects", async () => {
    const { state } = createFakeState({
      dispatchCommand: () => {
        throw new Error("session timed out");
      },
    });
    const response = await handleSessionApiRequest(
      state,
      apiRequest({
        action: "comment-rm",
        selector: { sessionId: "s-1" },
        commentId: "c-1",
      } as SessionDaemonRequest),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "session timed out" });
  });
});
