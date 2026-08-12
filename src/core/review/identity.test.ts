import { describe, expect, test } from "bun:test";
import {
  reviewContentDigest,
  reviewFileContentIdentity,
  reviewFileKey,
  reviewSourceIdentity,
} from "./identity";

/** The facts one unchanged file reports every time it is projected. */
function contentInput(overrides: Partial<Parameters<typeof reviewFileContentIdentity>[0]> = {}) {
  return {
    path: "src/alpha.ts",
    changeKind: "change",
    patch: "@@ -1 +1 @@\n-a\n+b\n",
    stats: { additions: 1, deletions: 1, truncated: false },
    flags: { untracked: false, binary: false, tooLarge: false, partial: false },
    hunkSignature: "0,1,1,0,1,1,0",
    additionLines: ["b\n"],
    deletionLines: ["a\n"],
    ...overrides,
  };
}

describe("reviewContentDigest", () => {
  test("is stable and fixed width for the same parts", () => {
    const digest = reviewContentDigest(["alpha", "beta"]);

    expect(digest).toBe(reviewContentDigest(["alpha", "beta"]));
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
  });

  test("frames parts so a different split cannot produce the same digest", () => {
    expect(reviewContentDigest(["ab", "c"])).not.toBe(reviewContentDigest(["a", "bc"]));
    expect(reviewContentDigest(["a", ""])).not.toBe(reviewContentDigest([""]));
  });

  test("distinguishes order", () => {
    expect(reviewContentDigest(["a", "b"])).not.toBe(reviewContentDigest(["b", "a"]));
  });
});

describe("reviewFileContentIdentity", () => {
  test("is unchanged when nothing about the file changed", () => {
    expect(reviewFileContentIdentity(contentInput())).toBe(
      reviewFileContentIdentity(contentInput()),
    );
  });

  test("changes when the rendered lines change, even at identical geometry", () => {
    expect(reviewFileContentIdentity(contentInput({ additionLines: ["c\n"] }))).not.toBe(
      reviewFileContentIdentity(contentInput()),
    );
  });

  test("changes when a line moves from one side to the other", () => {
    expect(
      reviewFileContentIdentity(contentInput({ additionLines: ["a\n", "b\n"], deletionLines: [] })),
    ).not.toBe(
      reviewFileContentIdentity(contentInput({ additionLines: ["a\n"], deletionLines: ["b\n"] })),
    );
  });

  test("changes when the same content is re-parsed at another context width", () => {
    expect(reviewFileContentIdentity(contentInput({ hunkSignature: "3,1,7,0,1,7,0" }))).not.toBe(
      reviewFileContentIdentity(contentInput()),
    );
  });

  test("changes when a flag flips without the content moving", () => {
    expect(
      reviewFileContentIdentity(
        contentInput({
          flags: { untracked: true, binary: false, tooLarge: false, partial: false },
        }),
      ),
    ).not.toBe(reviewFileContentIdentity(contentInput()));
  });
});

describe("reviewFileKey", () => {
  const key = { sourceLabel: "HEAD", path: "src/alpha.ts", duplicateIndex: 0 };

  test("addresses the same file the same way regardless of its content", () => {
    expect(reviewFileKey(key)).toBe(reviewFileKey({ ...key }));
  });

  test("separates two entries for the same path", () => {
    expect(reviewFileKey({ ...key, duplicateIndex: 1 })).not.toBe(reviewFileKey(key));
  });

  test("separates the same path in two different reviews", () => {
    expect(reviewFileKey({ ...key, sourceLabel: "HEAD~1" })).not.toBe(reviewFileKey(key));
  });

  test("separates a renamed file from an unrenamed one at the same path", () => {
    expect(reviewFileKey({ ...key, previousPath: "src/old.ts" })).not.toBe(reviewFileKey(key));
  });
});

describe("reviewSourceIdentity", () => {
  const base = { path: "src/alpha.ts", contentIdentity: "content-1" };

  test("stays put while the content behind the file does", () => {
    expect(reviewSourceIdentity(base)).toBe(reviewSourceIdentity({ ...base }));
  });

  test("moves when the file's content identity moves", () => {
    expect(reviewSourceIdentity({ ...base, contentIdentity: "content-2" })).not.toBe(
      reviewSourceIdentity(base),
    );
  });

  test("moves when the reader addresses a different source snapshot", () => {
    expect(reviewSourceIdentity({ ...base, fetcherCacheKey: "worktree:2" })).not.toBe(
      reviewSourceIdentity({ ...base, fetcherCacheKey: "worktree:1" }),
    );
  });
});
