import { describe, expect, test } from "bun:test";
import type { HunkReviewActionV1 } from "./reviewProtocol";
import {
  MAX_REVIEW_NOTE_BYTES,
  parseApplyReviewActionInput,
  parseGetReviewSnapshotInput,
  parseHunkReviewActionV1,
  parseReadReviewResourceInput,
} from "./reviewProtocol";

describe("review protocol generation validation", () => {
  test("rejects 300 KiB and invalid generations in every producer command", () => {
    const invalidGenerations = ["g".repeat(300 * 1024), "generation with spaces", "generation:💥"];

    for (const generation of invalidGenerations) {
      expect(
        parseReadReviewResourceInput({
          sessionId: "session-1",
          generation,
          resourceId: "resource:1",
          offset: 0,
          length: 1,
        }),
      ).toBeNull();
      expect(
        parseApplyReviewActionInput({
          sessionId: "session-1",
          generation,
          action: { type: "notes/set-visibility", visible: true },
        }),
      ).toBeNull();
      expect(parseGetReviewSnapshotInput({ sessionId: "session-1", generation })).toBeNull();
    }
  });

  test("accepts runtime-compatible compact generation identifiers", () => {
    const generation = `generation:${"a".repeat(64)}`;
    expect(parseGetReviewSnapshotInput({ sessionId: "session-1", generation })).toMatchObject({
      generation,
    });
  });
});

describe("browser review action parsing", () => {
  test("accepts every v1 action variant without coupling to reducer actions", () => {
    const actions: HunkReviewActionV1[] = [
      {
        type: "selection/select",
        selection: {
          fileKey: "file:1",
          hunkIndex: 2,
          side: "new",
          line: 12,
          contextDigest: "digest",
        },
        reveal: { kind: "hunk", scrollToNote: true },
      },
      {
        type: "selection/set-line",
        fileKey: "file:1",
        hunkIndex: 2,
        side: "old",
        line: 7,
        contextDigest: "digest",
        reveal: true,
      },
      { type: "filter/set", filter: "src" },
      { type: "notes/set-visibility", visible: true },
      {
        type: "notes/create-user",
        note: {
          fileKey: "file:1",
          hunkIndex: 0,
          side: "new",
          line: 1,
          body: "body",
          markup: "<strong>body</strong>",
        },
      },
      { type: "notes/update-user", noteId: "user:1", body: "next", markup: "" },
      { type: "notes/remove-user", noteId: "user:1" },
      { type: "notes/remove-live", noteId: "mcp:1" },
      { type: "expansion/toggle", fileKey: "file:1", gapId: "before:0" },
      { type: "session/reload" },
      { type: "trust/decide", decision: "trusted" },
    ];

    for (const action of actions) expect(parseHunkReviewActionV1(action)).toEqual(action);
  });

  test("distinguishes unsupported actions from malformed recognized actions", () => {
    expect(parseHunkReviewActionV1({ type: "future/action", payload: true })).toBe("unsupported");
    expect(parseHunkReviewActionV1({ type: "filter/set", filter: "src", extra: true })).toBe(
      "invalid",
    );
    expect(
      parseHunkReviewActionV1({
        type: "selection/select",
        selection: { fileKey: "file:1", hunkIndex: 0, extra: true },
      }),
    ).toBe("invalid");
    expect(
      parseHunkReviewActionV1({
        type: "selection/select",
        selection: { fileKey: "file:1", hunkIndex: 0 },
        reveal: { kind: "hunk", extra: true },
      }),
    ).toBe("invalid");
    expect(
      parseHunkReviewActionV1({
        type: "notes/create-user",
        note: {
          fileKey: "file:1",
          hunkIndex: 0,
          side: "new",
          line: 1,
          body: "body",
          extra: true,
        },
      }),
    ).toBe("invalid");
    expect(parseHunkReviewActionV1(null)).toBe("invalid");
    expect(parseHunkReviewActionV1({})).toBe("invalid");
  });

  test("enforces user note bounds in UTF-8 bytes", () => {
    const create = (body: string, markup?: string) => ({
      type: "notes/create-user",
      note: {
        fileKey: "file:1",
        hunkIndex: 0,
        side: "new",
        line: 1,
        body,
        ...(markup === undefined ? {} : { markup }),
      },
    });
    const update = (body: string, markup?: string) => ({
      type: "notes/update-user",
      noteId: "user:1",
      body,
      ...(markup === undefined ? {} : { markup }),
    });
    const exactAscii = "a".repeat(MAX_REVIEW_NOTE_BYTES);
    const overAscii = `${exactAscii}a`;
    const exactMultibyte = "é".repeat(MAX_REVIEW_NOTE_BYTES / 2);
    const overMultibyte = `${exactMultibyte}é`;

    expect(parseHunkReviewActionV1(create(exactAscii))).not.toBe("invalid");
    expect(parseHunkReviewActionV1(create(exactMultibyte))).not.toBe("invalid");
    expect(parseHunkReviewActionV1(create(overAscii))).toBe("invalid");
    expect(parseHunkReviewActionV1(create(overMultibyte))).toBe("invalid");
    expect(parseHunkReviewActionV1(update("body", exactAscii))).not.toBe("invalid");
    expect(parseHunkReviewActionV1(update("body", overAscii))).toBe("invalid");
  });
});
