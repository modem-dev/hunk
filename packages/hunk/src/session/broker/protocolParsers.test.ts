import { describe, expect, test } from "bun:test";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../reviewProtocol";
import { hunkSessionProtocolParsers } from "./protocolParsers";

describe("Hunk session protocol parsers", () => {
  test("preserves reply targets for single and batched comment commands", () => {
    const reply = {
      replyTo: "user:parent",
      summary: "Addressed",
    };

    expect(
      hunkSessionProtocolParsers.parseCommandInput("comment", HUNK_REVIEW_PROTOCOL_VERSION, reply),
    ).toEqual(reply);
    expect(
      hunkSessionProtocolParsers.parseCommandInput("comment_batch", HUNK_REVIEW_PROTOCOL_VERSION, {
        comments: [reply],
        revealMode: "none",
      }),
    ).toEqual({ comments: [reply], revealMode: "none" });
  });

  test("preserves existing hunk-first root targets with extra line fields", () => {
    const root = {
      filePath: "a.ts",
      hunkIndex: 1,
      side: "new" as const,
      line: 99,
      summary: "hunk target keeps precedence",
    };

    expect(
      hunkSessionProtocolParsers.parseCommandInput("comment", HUNK_REVIEW_PROTOCOL_VERSION, root),
    ).toEqual(root);
    expect(
      hunkSessionProtocolParsers.parseCommandInput("comment_batch", HUNK_REVIEW_PROTOCOL_VERSION, {
        comments: [root],
      }),
    ).toEqual({ comments: [root] });
  });

  test("rejects comment commands that mix reply and root targets", () => {
    expect(() =>
      hunkSessionProtocolParsers.parseCommandInput("comment", HUNK_REVIEW_PROTOCOL_VERSION, {
        replyTo: "user:parent",
        filePath: "a.ts",
        side: "new",
        line: 1,
        summary: "mixed",
      }),
    ).toThrow();
    expect(() =>
      hunkSessionProtocolParsers.parseCommandInput("comment_batch", HUNK_REVIEW_PROTOCOL_VERSION, {
        comments: [{ replyTo: "user:parent", filePath: "a.ts", hunkIndex: 0, summary: "mixed" }],
      }),
    ).toThrow();
  });

  test("accepts the dim line-highlight tone", () => {
    const input = {
      filePath: "src/App.tsx",
      side: "new" as const,
      line: 42,
      start: 6,
      end: 19,
      tone: "dim" as const,
      reveal: true,
    };

    expect(
      hunkSessionProtocolParsers.parseCommandInput(
        "highlight",
        HUNK_REVIEW_PROTOCOL_VERSION,
        input,
      ),
    ).toEqual(input);

    const result = {
      fileId: "file-1",
      filePath: input.filePath,
      hunkIndex: 0,
      side: input.side,
      line: input.line,
      start: input.start,
      end: input.end,
      tone: input.tone,
      fileMarkCount: 1,
      revealed: "line" as const,
    };
    expect(
      hunkSessionProtocolParsers.parseCommandResult(
        "highlight",
        HUNK_REVIEW_PROTOCOL_VERSION,
        result,
      ),
    ).toEqual(result);
  });
});
