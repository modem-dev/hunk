import { describe, expect, test } from "bun:test";
import { drainLines, sniffPatch } from "./patchSniffer";

async function* fromArray(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

describe("sniffPatch", () => {
  test("detects git-style patch via diff --git header", async () => {
    const result = await sniffPatch(
      fromArray(["diff --git a/foo b/foo", "index 1..2 100644", "--- a/foo", "+++ b/foo"]),
    );
    expect(result.kind).toBe("patch");
    expect(result.prefixLines).toEqual(["diff --git a/foo b/foo"]);
  });

  test("detects unified-diff patch via --- followed by +++", async () => {
    const result = await sniffPatch(fromArray(["--- a/foo", "+++ b/foo", "@@ -1 +1 @@"]));
    expect(result.kind).toBe("patch");
    expect(result.prefixLines).toEqual(["--- a/foo", "+++ b/foo"]);
  });

  test("detects patch via standalone @@ header", async () => {
    const result = await sniffPatch(fromArray(["@@ -1,2 +1,2 @@", " context"]));
    expect(result.kind).toBe("patch");
    expect(result.prefixLines).toEqual(["@@ -1,2 +1,2 @@"]);
  });

  test("returns plain when no markers within budget", async () => {
    const result = await sniffPatch(
      fromArray(["# Some Readme", "This is a plain text file.", "Line 3"]),
    );
    expect(result.kind).toBe("plain");
    expect(result.prefixLines).toEqual(["# Some Readme", "This is a plain text file.", "Line 3"]);
  });

  test("does not treat a lone --- without following +++ as a patch", async () => {
    const result = await sniffPatch(
      fromArray(["--- chapter 1", "First paragraph.", "Second paragraph."]),
    );
    expect(result.kind).toBe("plain");
  });

  test("strips ANSI before matching", async () => {
    const result = await sniffPatch(
      fromArray(["\x1b[1mdiff --git a/foo b/foo\x1b[0m", "--- a/foo", "+++ b/foo"]),
    );
    expect(result.kind).toBe("patch");
  });

  test("preserves the rest iterator so downstream can keep consuming", async () => {
    const result = await sniffPatch(
      fromArray(["diff --git a/foo b/foo", "rest line 1", "rest line 2"]),
    );
    expect(result.kind).toBe("patch");
    const drained = await drainLines(result.prefixLines, result.rest);
    expect(drained).toBe("diff --git a/foo b/foo\nrest line 1\nrest line 2\n");
  });

  test("respects maxLines budget", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i += 1) lines.push(`line ${i}`);
    lines.push("diff --git a/foo b/foo");
    const result = await sniffPatch(fromArray(lines), { maxLines: 10 });
    expect(result.kind).toBe("plain");
    expect(result.prefixLines.length).toBe(10);
  });

  test("respects maxBytes budget", async () => {
    const big = "x".repeat(1024);
    const lines = [big, big, big, big, big, "diff --git a/foo b/foo"];
    const result = await sniffPatch(fromArray(lines), { maxBytes: 2048 });
    expect(result.kind).toBe("plain");
  });

  test("handles empty stream", async () => {
    const result = await sniffPatch(fromArray([]));
    expect(result.kind).toBe("plain");
    expect(result.prefixLines).toEqual([]);
  });
});
