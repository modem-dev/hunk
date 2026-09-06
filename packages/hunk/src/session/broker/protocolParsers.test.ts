import { describe, expect, test } from "bun:test";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../reviewProtocol";
import { hunkSessionProtocolParsers } from "./protocolParsers";

describe("Hunk session protocol parsers", () => {
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
