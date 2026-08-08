#!/usr/bin/env bun

export interface LcovCoverageTotals {
  lines: { hit: number; found: number };
  functions: { hit: number; found: number };
}

export const MINIMUM_COVERAGE = 0.9;

/** Parse aggregate line and function totals from an LCOV report. */
export function parseLcovCoverageTotals(report: string): LcovCoverageTotals {
  const totals: LcovCoverageTotals = {
    lines: { hit: 0, found: 0 },
    functions: { hit: 0, found: 0 },
  };

  for (const line of report.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;

    const value = Number(line.slice(separator + 1));
    if (!Number.isSafeInteger(value) || value < 0) continue;

    switch (line.slice(0, separator)) {
      case "LH":
        totals.lines.hit += value;
        break;
      case "LF":
        totals.lines.found += value;
        break;
      case "FNH":
        totals.functions.hit += value;
        break;
      case "FNF":
        totals.functions.found += value;
        break;
    }
  }

  for (const [name, total] of Object.entries(totals)) {
    if (total.found === 0) {
      throw new Error(`LCOV report contains no ${name} coverage data.`);
    }
    if (total.hit > total.found) {
      throw new Error(`LCOV report has more hit than found ${name}.`);
    }
  }

  return totals;
}

/** Return human-readable failures for totals below the required ratio. */
export function findCoverageThresholdFailures(
  totals: LcovCoverageTotals,
  minimum = MINIMUM_COVERAGE,
): string[] {
  return Object.entries(totals).flatMap(([name, total]) => {
    const ratio = total.hit / total.found;
    return ratio < minimum
      ? [`${name}: ${(ratio * 100).toFixed(2)}% is below ${(minimum * 100).toFixed(0)}%`]
      : [];
  });
}

/** Format one concise aggregate coverage summary for CI logs. */
export function formatCoverageSummary(totals: LcovCoverageTotals): string {
  const format = ({ hit, found }: { hit: number; found: number }) =>
    `${((hit / found) * 100).toFixed(2)}% (${hit}/${found})`;
  return `Coverage totals: ${format(totals.lines)} lines, ${format(totals.functions)} functions`;
}

if (import.meta.main) {
  const reportPath = process.argv[2] ?? "coverage/lcov.info";
  const totals = parseLcovCoverageTotals(await Bun.file(reportPath).text());
  console.log(formatCoverageSummary(totals));

  const failures = findCoverageThresholdFailures(totals);
  if (failures.length > 0) {
    throw new Error(
      `Coverage threshold failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }
}
