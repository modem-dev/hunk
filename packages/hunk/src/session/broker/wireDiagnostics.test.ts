import { afterEach, describe, expect, test } from "bun:test";
import {
  createTestSessionRegistration,
  createTestSessionSnapshot,
} from "../../../../../test/helpers/session-daemon-fixtures";
import { diagnoseSessionRegistration, diagnoseSessionSnapshot } from "./wire";
import { describeSessionWireRejection, reportSessionWireRejection } from "./wireDiagnostics";

const originalDebug = process.env.HUNK_DEBUG;

afterEach(() => {
  if (originalDebug === undefined) delete process.env.HUNK_DEBUG;
  else process.env.HUNK_DEBUG = originalDebug;
});

describe("session wire rejection diagnostics", () => {
  test("a valid registration and snapshot report no rejection", () => {
    expect(diagnoseSessionRegistration(createTestSessionRegistration())).toBeNull();
    expect(diagnoseSessionSnapshot(createTestSessionSnapshot())).toBeNull();
  });

  // Intent: the #1064 skew — a descriptor key the daemon does not know — is named by the parser
  // that rejected it and the key path, never by the payload contents.
  test("names the review descriptor parser for an unknown descriptor key", () => {
    const registration = createTestSessionRegistration({
      info: {
        review: {
          kind: "commit",
          provider: "git",
          title: "feat: something",
          revision: "0123456789abcdef",
          displayRevisionFromTheFuture: "0123456",
        } as never,
      },
    });

    expect(diagnoseSessionRegistration(registration)).toEqual({
      parser: "parseExtensionReviewDescriptor",
      path: "info.review",
    });
  });

  test("names the innermost parser with an indexed path", () => {
    const registration = createTestSessionRegistration();
    const file = registration.info.files[0]!;
    file.hunks = [
      { index: 0, header: "@@" },
      { index: -1, header: "@@" },
    ];
    file.hunkCount = file.hunks.length;

    expect(diagnoseSessionRegistration(registration)).toEqual({
      parser: "parseSessionReviewHunk",
      path: "info.files[0].hunks[1]",
    });
  });

  test("names the info parser for an unknown top-level info key", () => {
    const registration = createTestSessionRegistration();
    (registration.info as unknown as Record<string, unknown>).surprise = true;

    expect(diagnoseSessionRegistration(registration)).toEqual({
      parser: "parseHunkSessionInfo",
      path: "info",
    });
  });

  test("names the envelope parser when the shared envelope itself is malformed", () => {
    expect(
      diagnoseSessionRegistration({ ...createTestSessionRegistration(), registrationVersion: 0 }),
    ).toEqual({ parser: "parseSessionRegistrationEnvelope", path: "" });
    expect(diagnoseSessionSnapshot({ state: createTestSessionSnapshot().state })).toEqual({
      parser: "parseSessionSnapshotEnvelope",
      path: "",
    });
  });

  test("names the live comment parser inside a snapshot", () => {
    const snapshot = createTestSessionSnapshot({
      liveComments: [
        {
          commentId: "c1",
          filePath: "src/example.ts",
          hunkIndex: 0,
          side: "sideways" as never,
          line: 1,
          summary: "x",
          createdAt: "2026-03-22T00:00:00.000Z",
        },
      ],
    });

    expect(diagnoseSessionSnapshot(snapshot)).toEqual({
      parser: "parseSessionLiveCommentSummary",
      path: "state.liveComments[0]",
    });
  });

  test("describes a rejection with the session id and never the payload", () => {
    const registration = createTestSessionRegistration({ sessionId: "abcdef12-rest" });
    (registration.info as unknown as Record<string, unknown>).surprise = "secret-value";

    const description = describeSessionWireRejection("registration", registration);

    expect(description).toBe(
      "rejected registration from session abcdef12-rest: parseHunkSessionInfo returned null at info",
    );
    expect(description).not.toContain("secret-value");
  });

  test("logs only under HUNK_DEBUG=1", () => {
    const registration = createTestSessionRegistration();
    (registration.info as unknown as Record<string, unknown>).surprise = true;
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);

    delete process.env.HUNK_DEBUG;
    reportSessionWireRejection("registration", registration, write);
    expect(lines).toEqual([]);

    process.env.HUNK_DEBUG = "1";
    reportSessionWireRejection("registration", registration, write);
    expect(lines).toEqual([
      "[session:daemon] rejected registration from session session-1: parseHunkSessionInfo returned null at info",
    ]);
  });
});
