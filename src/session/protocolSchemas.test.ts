import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import type { SessionDaemonRequest } from "./protocol";
import { parseSessionDaemonRequest, sessionDaemonRequestSchema } from "./protocolSchemas";

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

describe("session daemon request validation", () => {
  test("accepts every wire-shaped action payload", () => {
    const requests: unknown[] = [
      { action: "list" },
      { action: "get", selector: { sessionId: "s-1" } },
      {
        action: "context",
        selector: { repoRoot: "/repo/nested", repoBoundary: "/repo" },
      },
      { action: "review", selector: { sessionId: "s-1" } },
      { action: "review", selector: { sessionId: "s-1" }, includePatch: true, includeNotes: true },
      { action: "navigate", selector: { sessionId: "s-1" }, hunkNumber: 2 },
      {
        action: "navigate",
        selector: { sessionId: "s-1" },
        filePath: "a.ts",
        side: "new",
        line: 12,
      },
      { action: "navigate", selector: { sessionId: "s-1" }, commentDirection: "next" },
      {
        action: "reload",
        selector: { sessionId: "s-1" },
        nextInput: { kind: "show", ref: "HEAD~1", options: {} },
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
      { action: "comment-rm", selector: { sessionId: "s-1" }, commentId: "c-1" },
      { action: "comment-clear", selector: { sessionId: "s-1" }, includeUser: true },
    ];

    for (const request of requests) {
      expect(() => parseSessionDaemonRequest(request)).not.toThrow();
    }
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

  test("rejects non-object payloads and missing required fields", () => {
    expect(() => parseSessionDaemonRequest("list")).toThrow(/Invalid session API request/);
    expect(() => parseSessionDaemonRequest(null)).toThrow(/Invalid session API request/);
    expect(() =>
      parseSessionDaemonRequest({ action: "comment-rm", selector: { sessionId: "s-1" } }),
    ).toThrow(/commentId/);
    expect(() =>
      parseSessionDaemonRequest({ action: "reload", selector: { sessionId: "s-1" } }),
    ).toThrow(/nextInput/);
  });
});
