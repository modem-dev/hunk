import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSidecarFileContext, loadSidecarContext } from "./sidecar";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("agent context", () => {
  test("returns null when no sidecar path is provided", async () => {
    await expect(loadSidecarContext()).resolves.toBeNull();
  });

  test("loads and matches annotations by current or previous path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-agent-"));
    tempDirs.push(dir);

    const contextPath = join(dir, "agent.json");
    writeFileSync(
      contextPath,
      JSON.stringify({
        version: 1,
        summary: "Agent summary",
        files: [
          {
            path: "src/example.ts",
            summary: "Explains the file change",
            annotations: [
              {
                newRange: [4, 8],
                summary: "Added a helper",
                confidence: "high",
                tags: ["review", 7],
              },
              {
                summary: "Unknown confidence is omitted",
                confidence: "certain",
              },
            ],
          },
        ],
      }),
    );

    const context = await loadSidecarContext(contextPath);

    expect(context?.summary).toBe("Agent summary");
    expect(findSidecarFileContext(context, "src/example.ts")?.annotations).toHaveLength(2);
    expect(findSidecarFileContext(context, "src/example.ts")?.annotations[0]).toMatchObject({
      confidence: "high",
      tags: ["review"],
    });
    expect(
      findSidecarFileContext(context, "src/example.ts")?.annotations[1]?.confidence,
    ).toBeUndefined();
    expect(findSidecarFileContext(context, "src/renamed.ts", "src/example.ts")?.summary).toBe(
      "Explains the file change",
    );
  });

  test("rejects malformed file and range entries in the sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-agent-invalid-"));
    tempDirs.push(dir);

    const invalidFilePath = join(dir, "invalid-file.json");
    writeFileSync(
      invalidFilePath,
      JSON.stringify({
        version: 1,
        files: [{ summary: "Missing path", annotations: [] }],
      }),
    );

    await expect(loadSidecarContext(invalidFilePath)).rejects.toThrow(
      "Agent context file entries require a non-empty path.",
    );

    const invalidRangePath = join(dir, "invalid-range.json");
    writeFileSync(
      invalidRangePath,
      JSON.stringify({
        version: 1,
        files: [
          {
            path: "src/example.ts",
            annotations: [{ summary: "Bad range", newRange: [1, "two"] }],
          },
        ],
      }),
    );

    await expect(loadSidecarContext(invalidRangePath)).rejects.toThrow(
      "Annotation ranges must be integer tuples.",
    );

    const negativeRangePath = join(dir, "negative-range.json");
    writeFileSync(
      negativeRangePath,
      JSON.stringify({
        version: 1,
        files: [
          {
            path: "src/example.ts",
            annotations: [{ summary: "Bad range", newRange: [0, 2] }],
          },
        ],
      }),
    );

    await expect(loadSidecarContext(negativeRangePath)).rejects.toThrow(
      "Annotation ranges must use positive 1-based line numbers.",
    );

    const reversedRangePath = join(dir, "reversed-range.json");
    writeFileSync(
      reversedRangePath,
      JSON.stringify({
        version: 1,
        files: [
          {
            path: "src/example.ts",
            annotations: [{ summary: "Bad range", newRange: [4, 2] }],
          },
        ],
      }),
    );

    await expect(loadSidecarContext(reversedRangePath)).rejects.toThrow(
      "Annotation ranges must be ordered start..end tuples.",
    );
  });
});
