import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { HistoryRuntime } from "./types";
import { historyReviewArgs, runInteractiveHistory } from "./runInteractiveHistory";

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

describe("interactive history loading", () => {
  test("q interrupts an exhaustive read and closes the provider", async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.assign(stdin, { isTTY: true, setRawMode() {} });
    Object.assign(stdout, { isTTY: true, columns: 80, rows: 12 });
    let reads = 0;
    let readAborted = false;
    let closed = false;
    const runtime: HistoryRuntime = {
      input: {
        kind: "history",
        color: "never",
        format: "compact",
        ascii: false,
        interactive: true,
        extensionsEnabled: false,
        extensionPaths: [],
      },
      source: {
        async read({ signal }) {
          reads += 1;
          if (reads === 1) {
            return {
              commits: [
                {
                  revisionId: "a".repeat(40),
                  displayId: "aaaaaaaa",
                  parentRevisionIds: [],
                  subject: "First",
                  authorName: "Ada",
                  authoredAt: "2026-01-01T00:00:00Z",
                  decorations: [],
                },
              ],
              done: false,
            };
          }
          return await new Promise((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                readAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
        async close() {},
      },
      providerId: "test",
      providerName: "Test",
      repoRoot: "/repo",
      notices: [],
      customThemes: [],
      async planReview() {
        return { kind: "revision-show", revisionId: "a".repeat(40) };
      },
      async close() {
        closed = true;
      },
    };

    const running = runInteractiveHistory(runtime, { stdin, stdout });
    while (reads < 1) await Bun.sleep(1);
    // Terminals may coalesce the exhaustive-navigation key and quit.
    stdin.write("Gq");
    await running;
    expect(reads).toBe(2);

    expect(readAborted).toBe(true);
    expect(closed).toBe(true);
  });
});
