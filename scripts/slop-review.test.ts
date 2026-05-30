import { describe, expect, test } from "bun:test";
import {
  buildAgentContext,
  buildDeltaOccurrences,
  buildDeltaReport,
  formatDeltaText,
  type SlopReport,
} from "./slop-review";

const baseReport: SlopReport = {
  summary: {
    findingCount: 2,
  },
  findings: [
    {
      ruleId: "structure.duplicate-function-signatures",
      family: "structure",
      severity: "medium",
      scope: "file",
      message: "Found 2 duplicated function signatures",
      evidence: ["normalizeUser at line 1", "normalizeTeam at line 1"],
      score: 3,
      path: "src/users/normalize.ts",
      locations: [
        { path: "src/users/normalize.ts", line: 1 },
        { path: "src/teams/normalize.ts", line: 1 },
      ],
    },
    {
      ruleId: "defensive.needless-try-catch",
      family: "defensive",
      severity: "strong",
      scope: "file",
      message: "Found 1 defensive try/catch block",
      evidence: ["line 10: try=1, catch=1"],
      score: 1,
      path: "src/error.ts",
      locations: [{ path: "src/error.ts", line: 10 }],
    },
  ],
  fileScores: [
    { path: "src/users/normalize.ts", score: 3, findingCount: 1 },
    { path: "src/teams/normalize.ts", score: 3, findingCount: 1 },
    { path: "src/error.ts", score: 1, findingCount: 1 },
  ],
};

const headReport: SlopReport = {
  summary: {
    findingCount: 3,
  },
  findings: [
    ...(baseReport.findings ?? []),
    {
      ruleId: "structure.duplicate-function-signatures",
      family: "structure",
      severity: "medium",
      scope: "file",
      message: "Found 3 duplicated function signatures",
      evidence: [
        "normalizeUser at line 1",
        "normalizeTeam at line 1",
        "normalizeAccount at line 1",
      ],
      score: 4.5,
      path: "src/users/normalize.ts",
      locations: [
        { path: "src/users/normalize.ts", line: 1 },
        { path: "src/teams/normalize.ts", line: 1 },
        { path: "src/accounts/normalize.ts", line: 1 },
      ],
    },
  ],
  fileScores: [
    { path: "src/accounts/normalize.ts", score: 4.5, findingCount: 1 },
    { path: "src/users/normalize.ts", score: 4.5, findingCount: 1 },
    { path: "src/teams/normalize.ts", score: 4.5, findingCount: 1 },
    { path: "src/error.ts", score: 1, findingCount: 1 },
  ],
};

describe("slop review helpers", () => {
  test("delta comparison keeps only new per-file occurrences from grouped findings", () => {
    const delta = buildDeltaOccurrences(baseReport, headReport);

    expect(delta).toHaveLength(3);
    expect(delta.map((occurrence) => occurrence.path)).toEqual([
      "src/accounts/normalize.ts",
      "src/users/normalize.ts",
      "src/teams/normalize.ts",
    ]);
  });

  test("agent context groups new findings by file and emits hunk-friendly annotations", () => {
    const context = buildAgentContext(baseReport, headReport);

    expect(context.summary).toContain("3 new findings across 3 files vs base");
    expect(context.files.map((file) => file.path)).toEqual([
      "src/accounts/normalize.ts",
      "src/users/normalize.ts",
      "src/teams/normalize.ts",
    ]);
    expect(context.files[0]).toMatchObject({
      path: "src/accounts/normalize.ts",
      summary: "1 new slop finding · hotspot score 4.50.",
      annotations: [
        {
          summary: "Found 3 duplicated function signatures",
          newRange: [1, 1],
          confidence: "medium",
          source: "slop-analyzer",
          author: "slop-analyzer",
        },
      ],
    });
    expect(context.files[0]?.annotations[0]?.rationale).toContain(
      "Rule: structure.duplicate-function-signatures",
    );
    expect(context.files[0]?.annotations[0]?.rationale).toContain("Also flagged in 2 other files.");
  });

  test("delta report and text summary describe new findings succinctly", () => {
    const delta = buildDeltaReport(baseReport, headReport);
    const text = formatDeltaText(baseReport, headReport);

    expect(delta.summary).toEqual({
      baseFindingCount: 2,
      headFindingCount: 3,
      newFindingCount: 3,
      newFileCount: 3,
    });
    expect(text).toContain("New slop findings: 3 across 3 files");
    expect(text).toContain("- src/accounts/normalize.ts");
    expect(text).toContain("medium  Found 3 duplicated function signatures");
  });
});
