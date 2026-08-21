import { describe, expect, test } from "bun:test";
import {
  findCoverageThresholdFailures,
  formatCoverageSummary,
  parseLcovCoverageTotals,
} from "./check-coverage";

const report = `TN:
SF:src/first.ts
FNF:2
FNH:2
LF:10
LH:9
end_of_record
SF:src/second.ts
FNF:3
FNH:2
LF:20
LH:18
end_of_record
`;

describe("coverage threshold", () => {
  test("aggregates line and function totals across LCOV records", () => {
    expect(parseLcovCoverageTotals(report)).toEqual({
      lines: { hit: 27, found: 30 },
      functions: { hit: 4, found: 5 },
    });
  });

  test("reports each aggregate below the configured threshold", () => {
    const totals = parseLcovCoverageTotals(report);

    expect(findCoverageThresholdFailures(totals)).toEqual(["functions: 80.00% is below 90%"]);
    expect(findCoverageThresholdFailures(totals, 0.75)).toEqual([]);
  });

  test("formats totals for CI logs", () => {
    expect(formatCoverageSummary(parseLcovCoverageTotals(report))).toBe(
      "Coverage totals: 90.00% (27/30) lines, 80.00% (4/5) functions",
    );
  });

  test("rejects reports without usable coverage counters", () => {
    expect(() => parseLcovCoverageTotals("TN:\nend_of_record\n")).toThrow(
      "LCOV report contains no lines coverage data.",
    );
  });
});
