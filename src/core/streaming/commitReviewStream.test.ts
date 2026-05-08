import { describe, expect, test } from "bun:test";
import type { CommitChangeset } from "../types";
import { createCommitReviewStream } from "./commitReviewStream";

async function* logFixture(
  commits: { sha: string; subject: string; files: number }[],
): AsyncGenerator<string> {
  for (const c of commits) {
    yield `commit ${c.sha}`;
    yield `Author: Test <t@example.com>`;
    yield `Date:   2026-01-01 00:00:00 -0000`;
    yield "";
    yield `    ${c.subject}`;
    yield "";
    for (let f = 0; f < c.files; f += 1) {
      const path = `${c.sha.slice(0, 4)}_file${f}.txt`;
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

async function collectAll(
  stream: ReturnType<typeof createCommitReviewStream>,
): Promise<CommitChangeset[]> {
  const out: CommitChangeset[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.subscribe({
      onCommit: (commit) => out.push(commit),
      onComplete: () => resolve(),
      onError: reject,
    });
    // Release back-pressure by reporting a faraway cursor so the producer never parks.
    stream.setConsumedCommitIndex(1_000_000);
  });
  return out;
}

describe("createCommitReviewStream", () => {
  test("emits one CommitChangeset per commit with parsed metadata", async () => {
    const stream = createCommitReviewStream({
      source: logFixture([
        { sha: "abc1234567", subject: "first commit", files: 2 },
        { sha: "def4567890", subject: "second commit", files: 3 },
      ]),
      sourceLabel: "test",
      title: "test",
    });

    const commits = await collectAll(stream);

    expect(commits).toHaveLength(2);
    expect(commits[0]?.metadata.sha).toBe("abc1234567");
    expect(commits[0]?.metadata.shortSha).toBe("abc1234");
    expect(commits[0]?.metadata.subject).toBe("first commit");
    expect(commits[0]?.metadata.author).toBe("Test <t@example.com>");
    expect(commits[0]?.changeset.files).toHaveLength(2);

    expect(commits[1]?.metadata.sha).toBe("def4567890");
    expect(commits[1]?.metadata.subject).toBe("second commit");
    expect(commits[1]?.changeset.files).toHaveLength(3);
  });

  test("flushes the trailing commit on stream completion", async () => {
    const stream = createCommitReviewStream({
      source: logFixture([{ sha: "abc1234567", subject: "only commit", files: 1 }]),
      sourceLabel: "test",
      title: "test",
    });

    const commits = await collectAll(stream);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.metadata.subject).toBe("only commit");
  });

  test("late subscribers receive replay of all prior commits", async () => {
    const stream = createCommitReviewStream({
      source: logFixture([
        { sha: "abc1234567", subject: "first", files: 1 },
        { sha: "def4567890", subject: "second", files: 1 },
      ]),
      sourceLabel: "test",
      title: "test",
    });

    // Wait long enough for both commits to parse and the stream to complete.
    stream.setConsumedCommitIndex(1_000_000);
    await Bun.sleep(100);

    const seen: CommitChangeset[] = [];
    let completed = false;
    stream.subscribe({
      onCommit: (commit) => seen.push(commit),
      onComplete: () => {
        completed = true;
      },
      onError: () => {},
    });

    expect(seen).toHaveLength(2);
    expect(completed).toBe(true);
  });

  test("back-pressure pauses parsing at the high watermark", async () => {
    const stream = createCommitReviewStream({
      source: logFixture(
        Array.from({ length: 50 }, (_, i) => ({
          sha: i.toString(16).padStart(7, "0"),
          subject: `commit ${i}`,
          files: 1,
        })),
      ),
      sourceLabel: "test",
      title: "test",
      lookaheadCommitsHigh: 5,
      lookaheadCommitsLow: 2,
    });

    const seen: CommitChangeset[] = [];
    stream.subscribe({
      onCommit: (commit) => seen.push(commit),
      onComplete: () => {},
      onError: () => {},
    });

    // No setConsumedCommitIndex call → cursor stays at -1, producer parks once 5 ahead.
    // The wrapper emits a commit when it sees the NEXT commit's first line, so an
    // emitted count of HIGH-1 means the producer is now buffering commit #HIGH and
    // about to park.
    await Bun.sleep(100);

    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.length).toBeLessThanOrEqual(6);

    stream.abort();
  });
});
