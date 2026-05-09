import { describe, expect, test } from "bun:test";
import { createChangesetStream } from "./changesetStream";

/**
 * Generate a synthetic `git log -p` stream of N commits, each with `filesPerCommit`
 * single-line file diffs. Designed for back-pressure tests, not for coverage of the
 * chunker — the patches are minimal but real enough that parsePatchFiles accepts them.
 */
async function* syntheticLog(commits: number, filesPerCommit: number): AsyncGenerator<string> {
  for (let c = 0; c < commits; c += 1) {
    yield `commit ${c.toString(16).padStart(7, "0")}`;
    yield `Author: Test <t@example.com>`;
    yield `Date:   2026-01-01 00:00:00 -0000`;
    yield "";
    yield `    commit ${c} subject`;
    yield "";
    for (let f = 0; f < filesPerCommit; f += 1) {
      const path = `file_${c}_${f}.txt`;
      yield `diff --git a/${path} b/${path}`;
      yield `index 1111111..2222222 100644`;
      yield `--- a/${path}`;
      yield `+++ b/${path}`;
      yield `@@ -1 +1 @@`;
      yield `-old`;
      yield `+new`;
    }
  }
}

describe("createChangesetStream back-pressure", () => {
  test("pauses parsing when commits-ahead exceeds high watermark", async () => {
    const stream = createChangesetStream({
      source: syntheticLog(50, 1),
      sourceLabel: "test",
      title: "test",
      // Tight watermarks so the test runs fast and the pause is observable.
      lookahead: { commitsHigh: 5, commitsLow: 2, filesHigh: 10_000, filesLow: 5_000 },
      // Eager flush so we observe each batch.
      batchIntervalMs: 1,
      batchWatermark: 1,
    });

    const received: number[] = [];
    stream.subscribe({
      onAppend: (files) => {
        for (const file of files) received.push(file.commitIndex ?? -1);
      },
      onComplete: () => {},
      onError: () => {},
    });

    // Let the producer run as much as it will without any consumer signal.
    await Bun.sleep(80);

    // With commitsHigh=5 the producer must stop at 5 commits ahead of the unset
    // consumer position. We allow some slack for the boundary commit-event to land
    // before the next iteration's permit check.
    expect(received.length).toBeGreaterThanOrEqual(5);
    expect(received.length).toBeLessThanOrEqual(7);

    stream.abort();
  });

  test("resumes parsing when consumer advances past low watermark", async () => {
    const stream = createChangesetStream({
      source: syntheticLog(20, 1),
      sourceLabel: "test",
      title: "test",
      lookahead: { commitsHigh: 5, commitsLow: 2, filesHigh: 10_000, filesLow: 5_000 },
      batchIntervalMs: 1,
      batchWatermark: 1,
    });

    let received = 0;
    stream.subscribe({
      onAppend: (files) => {
        received += files.length;
      },
      onComplete: () => {},
      onError: () => {},
    });

    await Bun.sleep(80);
    const beforeAdvance = received;
    expect(beforeAdvance).toBeGreaterThanOrEqual(5);
    expect(beforeAdvance).toBeLessThanOrEqual(7);

    // Advance the consumer past the low watermark. Lookahead drops, producer resumes.
    stream.setConsumedPosition(4, 4);
    await Bun.sleep(80);

    // The consumer at commit 4 with commitsLow=2 should pull lookahead back down,
    // letting the producer resume until the next high watermark trigger.
    expect(received).toBeGreaterThan(beforeAdvance);

    stream.abort();
  });

  test("file watermark catches inputs without commit boundaries", async () => {
    // Produce a single 50-file diff with no commit headers — the kind of input a
    // bare `git diff` produces. Commit-based watermark would never trigger; the
    // file-based one must.
    async function* diffOnly(): AsyncGenerator<string> {
      for (let i = 0; i < 50; i += 1) {
        const path = `file_${i}.txt`;
        yield `diff --git a/${path} b/${path}`;
        yield `--- a/${path}`;
        yield `+++ b/${path}`;
        yield `@@ -1 +1 @@`;
        yield `-old`;
        yield `+new`;
      }
    }

    const stream = createChangesetStream({
      source: diffOnly(),
      sourceLabel: "test",
      title: "test",
      lookahead: { commitsHigh: 100, commitsLow: 50, filesHigh: 10, filesLow: 5 },
      batchIntervalMs: 1,
      batchWatermark: 1,
    });

    let received = 0;
    stream.subscribe({
      onAppend: (files) => {
        received += files.length;
      },
      onComplete: () => {},
      onError: () => {},
    });

    await Bun.sleep(80);

    // filesHigh=10 must pause the producer well before all 50 files arrive.
    expect(received).toBeGreaterThanOrEqual(10);
    expect(received).toBeLessThanOrEqual(12);

    stream.abort();
  });

  test("tags every file with its owning commit index", async () => {
    const stream = createChangesetStream({
      source: syntheticLog(3, 2),
      sourceLabel: "test",
      title: "test",
      // Loose watermarks so all files arrive without pausing.
      lookahead: { commitsHigh: 100, commitsLow: 50, filesHigh: 1_000, filesLow: 500 },
      batchIntervalMs: 1,
      batchWatermark: 1,
    });

    const commitIndexes: number[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.subscribe({
        onAppend: (files) => {
          for (const file of files) commitIndexes.push(file.commitIndex ?? -1);
        },
        onComplete: () => resolve(),
        onError: reject,
      });
    });

    // 3 commits × 2 files each = 6 files, indexes [0,0,1,1,2,2].
    expect(commitIndexes).toEqual([0, 0, 1, 1, 2, 2]);
  });
});
