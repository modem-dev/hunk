import { describe, expect, test } from "bun:test";
import { historyReviewArgs } from "./runInteractiveHistory";

describe("history review child arguments", () => {
  test("encodes provider-owned opaque actions without exposing ids to CLI option parsing", () => {
    const range = historyReviewArgs({
      kind: "revision-range",
      fromRevisionId: "-opaque:merge-parent/α",
      toRevisionId: "opaque:merge-child/β",
    });
    expect(range.slice(0, 2)).toEqual(["diff", "--history-review"]);
    expect(JSON.parse(Buffer.from(range[2]!, "base64url").toString("utf8"))).toEqual({
      kind: "revision-range",
      fromRevisionId: "-opaque:merge-parent/α",
      toRevisionId: "opaque:merge-child/β",
    });

    const root = historyReviewArgs({ kind: "revision-show", revisionId: "-opaque:root/revision" });
    expect(root.slice(0, 2)).toEqual(["show", "--history-review"]);
    expect(JSON.parse(Buffer.from(root[2]!, "base64url").toString("utf8"))).toEqual({
      kind: "revision-show",
      revisionId: "-opaque:root/revision",
    });
  });
});
