import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  looksLikePatchInput,
  pagePlainText,
  resolveTextPagerCommand,
  type PlainTextPagerDeps,
} from "../src/core/pager";

function createPagerDeps(overrides: Partial<PlainTextPagerDeps> = {}): PlainTextPagerDeps {
  return {
    stdout: {
      isTTY: true,
      write() {
        return true;
      },
    },
    spawnImpl() {
      const pager = new EventEmitter() as EventEmitter & { stdin: PassThrough };
      pager.stdin = new PassThrough();
      queueMicrotask(() => {
        pager.emit("close", 0);
      });
      return pager as never;
    },
    ...overrides,
  };
}

describe("general pager detection", () => {
  test("detects git-style patch input even when ANSI-colored", () => {
    const patch = [
      "\u001b[1mdiff --git a/src/example.ts b/src/example.ts\u001b[m",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1,2 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "+export const extra = true;",
    ].join("\n");

    expect(looksLikePatchInput(patch)).toBe(true);
  });

  test("detects common patch shapes across line endings and terminal wrappers", () => {
    const patchFixtures = [
      [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1 +1 @@",
        "-export const value = 1;",
        "+export const value = 2;",
      ],
      [
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1 +1,2 @@",
        "-export const value = 1;",
        "+export const value = 2;",
        "+export const extra = true;",
      ],
      [
        "header",
        "@@ -10,0 +11,2 @@",
        "+export const inserted = true;",
        "+export const added = true;",
      ],
    ];

    for (const lines of patchFixtures) {
      for (const newline of ["\n", "\r\n"]) {
        const patch = lines.join(newline);
        expect(looksLikePatchInput(patch)).toBe(true);
        expect(looksLikePatchInput(`\u001b]0;title\u0007${patch}\u001bPignored\u001b\\`)).toBe(
          true,
        );
      }
    }
  });

  test("does not misclassify partial diff markers or plain git pager text as a patch", () => {
    const fixtures = [
      ["* main", "  feat/persist-view-config", "  release/0.1.0"].join("\n"),
      ["--- separator only", "still prose"].join("\n"),
      ["+++ banner only", "still prose"].join("\n"),
      ["@@section heading", "still prose"].join("\n"),
      ["\u001b]0;title\u0007--- looks patchy", "+++but is just text"].join("\n"),
    ];

    for (const fixture of fixtures) {
      expect(looksLikePatchInput(fixture)).toBe(false);
    }
  });
});

describe("plain text pager fallback", () => {
  test("falls back to less when no pager is configured", () => {
    expect(resolveTextPagerCommand({})).toBe("less -R");
  });

  test("prefers HUNK_TEXT_PAGER and avoids recursive hunk launches", () => {
    expect(resolveTextPagerCommand({ HUNK_TEXT_PAGER: "bat --paging=always" })).toBe(
      "bat --paging=always",
    );
    expect(resolveTextPagerCommand({ HUNK_TEXT_PAGER: "hunk pager" })).toBe("less -R");
    expect(resolveTextPagerCommand({ PAGER: "env FOO=1 hunk pager" })).toBe("less -R");
  });

  test("writes directly to stdout when not attached to a terminal", async () => {
    let written = "";
    let spawnCalled = false;

    await pagePlainText(
      "plain text output",
      {},
      createPagerDeps({
        stdout: {
          isTTY: false,
          write(chunk) {
            written += String(chunk);
            return true;
          },
        },
        spawnImpl() {
          spawnCalled = true;
          throw new Error("spawn should not be called");
        },
      }),
    );

    expect(written).toBe("plain text output");
    expect(spawnCalled).toBe(false);
  });

  test("throws when the pager exits with a non-zero status", async () => {
    const pager = new EventEmitter() as EventEmitter & { stdin: PassThrough };
    pager.stdin = new PassThrough();
    let written = "";
    pager.stdin.on("data", (chunk) => {
      written += String(chunk);
    });

    const promise = pagePlainText(
      "needs pager",
      { PAGER: "less -R" },
      createPagerDeps({
        spawnImpl(command, options) {
          expect(command).toBe("less -R");
          expect(options.shell).toBe(true);
          queueMicrotask(() => {
            pager.emit("close", 1);
          });
          return pager as never;
        },
      }),
    );

    await expect(promise).rejects.toThrow("Pager command failed: less -R");
    expect(written).toBe("needs pager");
  });
});
