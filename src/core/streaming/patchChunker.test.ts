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
  return events
    .filter((event): event is Extract<ChunkEvent, { type: "file" }> => event.type === "file")
    .map((event) => event.chunkText);
}

/**
 * Reference port of the legacy splitPatchIntoFileChunks helper used by loaders.ts.
 * The streaming chunker must emit the same chunk text for the same input — this is the
 * regression net for Phase 2's "no behavior change in parsing" claim.
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
    const chunks = fileChunks(events);
    expect(chunks).toEqual(legacySplit(`${patch.join("\n")}\n`));
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
    const chunks = fileChunks(events);
    expect(chunks).toEqual(legacySplit(`${patch.join("\n")}\n`));
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
    expect(fileChunks(events)).toHaveLength(1);
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
    const chunks = fileChunks(events);
    expect(chunks).toEqual(legacySplit(`${patch.join("\n")}\n`));
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
    expect(events[0]?.type).toBe("file");
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
    expect(events[0]?.type).toBe("file");
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
});
