import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import type { CliInput } from "../core/run/commandInputs";
import {
  createTestSessionRegistration,
  createTestSessionSnapshot,
} from "../../../../test/helpers/session-daemon-fixtures";
import { buildListedHunkSession } from "./broker/projections";
import {
  HUNK_SESSION_API_VERSION,
  HUNK_SESSION_DAEMON_VERSION,
  type SessionDaemonRequest,
} from "./protocol";
import {
  cliInputSchema,
  parseSessionDaemonCapabilities,
  parseSessionDaemonRequest,
  parseSessionDaemonResponse,
  sessionDaemonRequestSchema,
} from "./protocolSchemas";

/** Strict structural equality; `true` only when A and B are the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Type-lock: the schema's inferred output must be exactly SessionDaemonRequest. A schema that
// forgets a field, widens a union, or misses a new action fails this line at `bun run typecheck`.
const _schemaMatchesProtocol: Equal<
  z.infer<typeof sessionDaemonRequestSchema>,
  SessionDaemonRequest
> = true;
void _schemaMatchesProtocol;
const _cliInputSchemaMatchesProtocol: Equal<z.infer<typeof cliInputSchema>, CliInput> = true;
void _cliInputSchemaMatchesProtocol;
const _dualSelectorIsNotCliInput: CliInput = {
  kind: "vcs",
  range: "main..feature",
  // @ts-expect-error A VCS input cannot carry both selector forms.
  rangeEndpoints: { from: "main", to: "feature" },
  staged: false,
  options: {},
};
void _dualSelectorIsNotCliInput;

describe("session daemon request validation", () => {
  test("uses the daemon revision for structured two-endpoint reload payloads", () => {
    expect(HUNK_SESSION_DAEMON_VERSION).toBe(13);
  });

  test("strictly parses cross-process capabilities", () => {
    expect(
      parseSessionDaemonCapabilities({
        version: HUNK_SESSION_API_VERSION,
        daemonVersion: HUNK_SESSION_DAEMON_VERSION,
        actions: ["list", "get"],
      }),
    ).toEqual({
      version: HUNK_SESSION_API_VERSION,
      daemonVersion: HUNK_SESSION_DAEMON_VERSION,
      actions: ["list", "get"],
    });
    for (const value of [
      null,
      [],
      {
        version: HUNK_SESSION_API_VERSION,
        daemonVersion: HUNK_SESSION_DAEMON_VERSION,
        actions: ["unknown"],
      },
      {
        version: HUNK_SESSION_API_VERSION,
        daemonVersion: HUNK_SESSION_DAEMON_VERSION,
        actions: ["list"],
        extra: true,
      },
    ]) {
      expect(parseSessionDaemonCapabilities(value)).toBeNull();
    }
  });
  test("accepts every wire-shaped action payload", () => {
    const requests: unknown[] = [
      { action: "list" },
      { action: "get", selector: { sessionId: "s-1" } },
      {
        action: "context",
        selector: { repoRoot: "/repo/nested", repoBoundary: "/repo" },
      },
      { action: "review", selector: { sessionId: "s-1" } },
      {
        action: "review",
        selector: { sessionId: "s-1" },
        includePatch: true,
        includeNotes: true,
      },
      { action: "navigate", selector: { sessionId: "s-1" }, hunkNumber: 2 },
      {
        action: "navigate",
        selector: { sessionId: "s-1" },
        filePath: "a.ts",
        side: "new",
        line: 12,
      },
      {
        action: "navigate",
        selector: { sessionId: "s-1" },
        commentDirection: "next",
      },
      {
        action: "navigate",
        selector: { sessionId: "s-1" },
        commentId: "comment-1",
      },
      {
        action: "reload",
        selector: { sessionId: "s-1" },
        nextInput: { kind: "show", ref: "HEAD~1", options: {} },
      },
      {
        action: "reload",
        selector: { sessionId: "s-1" },
        nextInput: {
          kind: "vcs",
          rangeEndpoints: { from: "main", to: "feature" },
          staged: false,
          options: {},
        },
      },
      {
        action: "comment-add",
        selector: { sessionId: "s-1" },
        filePath: "a.ts",
        side: "new",
        line: 1,
        summary: "note",
        reveal: false,
      },
      {
        action: "comment-apply",
        selector: { sessionId: "s-1" },
        comments: [{ filePath: "a.ts", summary: "note", hunkNumber: 2 }],
        revealMode: "first",
      },
      { action: "comment-list", selector: { sessionId: "s-1" }, type: "user" },
      {
        action: "comment-rm",
        selector: { sessionId: "s-1" },
        commentId: "c-1",
      },
      {
        action: "comment-clear",
        selector: { sessionId: "s-1" },
        includeUser: true,
      },
      {
        action: "highlight-add",
        selector: { sessionId: "s-1" },
        filePath: "a.ts",
        side: "new",
        line: 12,
        start: 0,
        end: 8,
        tone: "warning",
        reveal: true,
      },
      {
        action: "highlight-add",
        selector: { repoRoot: "/repo" },
        filePath: "a.ts",
        side: "old",
        line: 3,
        start: 4,
        end: 9,
        reveal: false,
      },
      {
        action: "highlight-clear",
        selector: { sessionId: "s-1" },
        filePath: "a.ts",
      },
      { action: "highlight-clear", selector: { sessionId: "s-1" } },
    ];

    for (const request of requests) {
      expect(() => parseSessionDaemonRequest(request)).not.toThrow();
    }
  });

  test("accepts bounded delegated review metadata and rejects malformed descriptors", () => {
    const review = {
      kind: "change-request" as const,
      provider: "GitHub",
      title: "Protocol metadata",
      id: "#123",
    };
    const session = buildListedHunkSession({
      registration: createTestSessionRegistration({ info: { review } }),
      snapshot: createTestSessionSnapshot(),
    });
    expect(parseSessionDaemonResponse("list", { sessions: [session] })).toEqual({
      sessions: [session],
    });

    expect(() =>
      parseSessionDaemonResponse("list", {
        sessions: [{ ...session, review: { ...review, unknown: true } }],
      }),
    ).toThrow("Invalid Hunk session daemon response for list.");
    expect(() =>
      parseSessionDaemonResponse("list", {
        sessions: [{ ...session, review: { ...review, title: "x".repeat(2 * 1024 + 1) } }],
      }),
    ).toThrow("Invalid Hunk session daemon response for list.");
  });

  test("accepts zero-based ranges in navigation responses", () => {
    expect(
      parseSessionDaemonResponse("navigate", {
        result: {
          fileId: "file-1",
          filePath: "new-file.ts",
          hunkIndex: 0,
          selectedHunk: { index: 0, oldRange: [0, 0], newRange: [0, 4] },
        },
      }),
    ).toEqual({
      result: {
        fileId: "file-1",
        filePath: "new-file.ts",
        hunkIndex: 0,
        selectedHunk: { index: 0, oldRange: [0, 0], newRange: [0, 4] },
      },
    });
  });

  test("rejects malformed action-specific responses with stable errors", () => {
    for (const [action, body] of [
      ["list", { sessions: "not-an-array" }],
      ["get", { session: { sessionId: "partial" } }],
      ["context", { context: { sessionId: "partial" } }],
      ["review", { review: { files: [] } }],
      ["navigate", { result: { fileId: "file-1", filePath: "a.ts", hunkIndex: -1 } }],
      ["comment-list", { comments: [{ commentId: "partial" }] }],
      ["highlight-clear", { result: { removedCount: "two", remainingCount: 0 } }],
    ] as const) {
      expect(() => parseSessionDaemonResponse(action, body)).toThrow(
        `Invalid Hunk session daemon response for ${action}.`,
      );
    }
    expect(() =>
      parseSessionDaemonResponse("navigate", {
        result: {
          fileId: "file-1",
          filePath: "a.ts",
          hunkIndex: 0,
          unknown: true,
        },
      }),
    ).toThrow("Invalid Hunk session daemon response for navigate.");
  });

  test("rejects malformed highlight payloads", () => {
    expect(() =>
      parseSessionDaemonRequest({
        action: "highlight-add",
        selector: { sessionId: "s-1" },
        filePath: "a.ts",
        side: "new",
        line: 12,
        start: -1,
        end: 8,
        reveal: false,
      }),
    ).toThrow(/start/);
    expect(() =>
      parseSessionDaemonRequest({
        action: "highlight-add",
        selector: { sessionId: "s-1" },
        filePath: "a.ts",
        side: "new",
        line: 12,
        start: 0,
        end: 8,
        tone: "loud",
        reveal: false,
      }),
    ).toThrow(/tone/);
  });

  test("rejects unknown actions with a readable error", () => {
    expect(() => parseSessionDaemonRequest({ action: "self-destruct" })).toThrow(
      /Invalid session API request/,
    );
  });

  test("rejects wrong field types and unknown keys", () => {
    expect(() =>
      parseSessionDaemonRequest({
        action: "navigate",
        selector: { sessionId: "s-1" },
        hunkNumber: "2",
      }),
    ).toThrow(/hunkNumber/);
    expect(() =>
      parseSessionDaemonRequest({
        action: "comment-rm",
        selector: { sessionId: "s-1" },
        commentId: "c-1",
        extra: true,
      }),
    ).toThrow(/Invalid session API request/);
    expect(() =>
      parseSessionDaemonRequest({
        action: "comment-add",
        selector: { sessionId: "s-1" },
        filePath: "a.ts",
        side: "sideways",
        line: 1,
        summary: "note",
        reveal: false,
      }),
    ).toThrow(/side/);
  });

  test("rejects deterministic nested Hunk command mutations", () => {
    const malformed = [
      {
        action: "reload",
        selector: { sessionId: "s-1" },
        nextInput: { kind: "vcs", staged: false, options: { tabWidth: 0 } },
      },
      {
        action: "reload",
        selector: { sessionId: "s-1" },
        nextInput: { kind: "patch", options: {}, unknown: true },
      },
      {
        action: "reload",
        selector: { sessionId: "s-1" },
        nextInput: {
          kind: "vcs",
          rangeEndpoints: { from: "main" },
          staged: false,
          options: {},
        },
      },
      {
        action: "reload",
        selector: { sessionId: "s-1" },
        nextInput: {
          kind: "vcs",
          rangeEndpoints: { from: "", to: "feature" },
          staged: false,
          options: {},
        },
      },
      {
        action: "reload",
        selector: { sessionId: "s-1" },
        nextInput: {
          kind: "vcs",
          rangeEndpoints: { from: "main", to: "feature", injected: true },
          staged: false,
          options: {},
        },
      },
      {
        action: "reload",
        selector: { sessionId: "s-1" },
        nextInput: {
          kind: "vcs",
          range: "main..feature",
          rangeEndpoints: { from: "main", to: "feature" },
          staged: false,
          options: {},
        },
      },
      {
        action: "comment-apply",
        selector: { sessionId: "s-1" },
        comments: [{ filePath: "a.ts", summary: "note", hunkNumber: 0 }],
        revealMode: "first",
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        action: "navigate",
        selector: index % 2 === 0 ? { sessionId: index } : { sessionId: "s-1", extra: index },
        hunkNumber: index + 1,
      })),
    ];
    for (const value of malformed) {
      expect(() => parseSessionDaemonRequest(value)).toThrow("Invalid session API request:");
    }
  });

  test("rejects non-object payloads and missing required fields", () => {
    expect(() => parseSessionDaemonRequest("list")).toThrow(/Invalid session API request/);
    expect(() => parseSessionDaemonRequest(null)).toThrow(/Invalid session API request/);
    expect(() =>
      parseSessionDaemonRequest({
        action: "comment-rm",
        selector: { sessionId: "s-1" },
      }),
    ).toThrow(/commentId/);
    expect(() =>
      parseSessionDaemonRequest({
        action: "reload",
        selector: { sessionId: "s-1" },
      }),
    ).toThrow(/nextInput/);
  });
});
