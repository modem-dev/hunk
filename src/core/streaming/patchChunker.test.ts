import { describe, expect, test } from "bun:test";
import { chunkPatchStream, type ChunkEvent } from "./patchChunker";

async function* fromArray(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

async function collect(events: AsyncIterable<ChunkEvent>): Promise<ChunkEvent[]> {
  const out: ChunkEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function fileChunks(events: ChunkEvent[]): string[] {
  return events.map((event) => event.chunkText);
}

/**
 * Reference port of the legacy splitPatchIntoFileChunks helper used by loaders.ts.
 * The streaming chunker must emit the same chunk text for the same input — this is the
 * regression net for the "no behavior change in parsing" claim.
 */
function legacySplit(rawPatch: string): string[] {
  const patch = rawPatch.replaceAll("\r\n", "\n");
  const lines = patch.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  const hasGitHeaders = lines.some((line) => line.startsWith("diff --git "));

  const flush = () => {
    if (current.length > 0) {
      chunks.push(`${current.join("\n").trimEnd()}\n`);
      current = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (hasGitHeaders && line.startsWith("diff --git ")) {
      flush();
      current.push(line);
      continue;
    }
    if (!hasGitHeaders && line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      flush();
      current.push(line);
      current.push(lines[index + 1]!);
      index += 1;
      continue;
    }
    if (current.length > 0) current.push(line);
  }

  flush();
  return chunks;
}

describe("chunkPatchStream", () => {
  test("emits one event per file in a git-style multi-file patch", async () => {
    const patch = [
      "diff --git a/foo.ts b/foo.ts",
      "index 1..2 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/bar.ts b/bar.ts",
      "index 3..4 100644",
      "--- a/bar.ts",
      "+++ b/bar.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ];
    const events = await collect(chunkPatchStream(fromArray(patch)));
    expect(fileChunks(events)).toEqual(legacySplit(`${patch.join("\n")}\n`));
    expect(events.every((e) => e.commitHeaderText === null)).toBe(true);
  });

  test("emits one event per file in a unified-diff multi-file patch", async () => {
    const patch = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- a/bar.ts",
      "+++ b/bar.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ];
    const events = await collect(chunkPatchStream(fromArray(patch)));
    expect(fileChunks(events)).toEqual(legacySplit(`${patch.join("\n")}\n`));
  });

  test("does not split inside a git-style file on its `--- ` and `+++ ` lines", async () => {
    const patch = [
      "diff --git a/only.ts b/only.ts",
      "index 1..2 100644",
      "--- a/only.ts",
      "+++ b/only.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ];
    const events = await collect(chunkPatchStream(fromArray(patch)));
    expect(events).toHaveLength(1);
  });

  test("ignores leading garbage before the first file header", async () => {
    const patch = [
      "preamble line that is not a patch",
      "another line",
      "diff --git a/foo b/foo",
      "--- a/foo",
      "+++ b/foo",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ];
    const events = await collect(chunkPatchStream(fromArray(patch)));
    expect(fileChunks(events)).toEqual(legacySplit(`${patch.join("\n")}\n`));
  });

  test("flushes the trailing file when stream ends mid-content", async () => {
    const patch = [
      "diff --git a/foo b/foo",
      "--- a/foo",
      "+++ b/foo",
      "@@ -1 +1 @@",
      "-x",
      // no trailing `+y` — simulate a truncated stream
    ];
    const events = await collect(chunkPatchStream(fromArray(patch)));
    expect(events).toHaveLength(1);
  });

  test("handles ANSI-colored headers", async () => {
    const patch = [
      "\x1b[1mdiff --git a/foo b/foo\x1b[0m",
      "--- a/foo",
      "+++ b/foo",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ];
    const events = await collect(chunkPatchStream(fromArray(patch)));
    expect(events).toHaveLength(1);
  });

  test("emits no events for an empty stream", async () => {
    const events = await collect(chunkPatchStream(fromArray([])));
    expect(events).toEqual([]);
  });

  test("emits no events for an all-noise stream with no patch headers", async () => {
    const events = await collect(
      chunkPatchStream(fromArray(["just", "some", "non-patch", "text", "here"])),
    );
    expect(events).toEqual([]);
  });

  test("captures verbatim commit metadata and rides it on the next file event", async () => {
    const log = [
      "commit f3919b9b41b9b065853fe81519ec0fa50b2b340e",
      "Author: Alice <alice@example.com>",
      "Date:   2026-01-01 10:00:00 -0700",
      "",
      "    second commit",
      "",
      "diff --git a/foo.ts b/foo.ts",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "commit e0c39a066a4978bae2c842dcffd11a3590d54048",
      "Author: Alice <alice@example.com>",
      "Date:   2026-01-01 09:00:00 -0700",
      "",
      "    first commit",
      "",
      "diff --git a/bar.ts b/bar.ts",
      "--- a/bar.ts",
      "+++ b/bar.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ];
    const events = await collect(chunkPatchStream(fromArray(log)));
    expect(events).toHaveLength(2);

    const [first, second] = events as [ChunkEvent, ChunkEvent];

    // First file's commitHeaderText carries the verbatim "second commit" block.
    expect(first.commitHeaderText).toContain("commit f3919b9b41b9b065853fe81519ec0fa50b2b340e");
    expect(first.commitHeaderText).toContain("Author: Alice <alice@example.com>");
    expect(first.commitHeaderText).toContain("    second commit");
    // The file chunk itself does not contain commit metadata.
    expect(first.chunkText).not.toContain("commit ");
    expect(first.chunkText).not.toContain("Author:");
    expect(first.chunkText).toContain("foo.ts");

    // Second file carries the second commit's metadata. The "second commit" header from
    // the first iteration must NOT bleed in.
    expect(second.commitHeaderText).toContain("commit e0c39a066a4978bae2c842dcffd11a3590d54048");
    expect(second.commitHeaderText).toContain("    first commit");
    expect(second.commitHeaderText).not.toContain("second commit");
    expect(second.chunkText).toContain("bar.ts");
  });

  test("multiple files under one commit only carry headerText on the first file", async () => {
    const log = [
      "commit abc1234",
      "Author: Bob <bob@example.com>",
      "Date:   2026-02-02",
      "",
      "    one commit, two files",
      "",
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/y.ts b/y.ts",
      "--- a/y.ts",
      "+++ b/y.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d",
    ];
    const events = await collect(chunkPatchStream(fromArray(log)));
    expect(events).toHaveLength(2);
    expect(events[0]!.commitHeaderText).toContain("one commit, two files");
    expect(events[1]!.commitHeaderText).toBeNull();
  });

  test("does not match a context line that looks like 'commit <hex>'", async () => {
    // Lines inside a hunk start with ' ', '+', or '-'. Our COMMIT_HEADER regex is
    // anchored at line start, so a context line containing the literal "commit abc1234"
    // cannot match — but verify explicitly so a future regex tweak that loosened the
    // anchoring would fail this test.
    const patch = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1 +1 @@",
      "-old",
      "+commit abc1234567",
    ];
    const events = await collect(chunkPatchStream(fromArray(patch)));
    expect(events).toHaveLength(1);
    expect(events[0]!.commitHeaderText).toBeNull();
  });
});
