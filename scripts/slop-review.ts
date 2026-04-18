#!/usr/bin/env bun

import type { AgentAnnotation, AgentContext } from "../src/core/types";

type Severity = "strong" | "medium" | "weak";

type OutputMode = "text" | "json" | "agent-context";

interface SlopFindingLocation {
  path: string;
  line: number;
  column?: number;
}

interface SlopFinding {
  ruleId: string;
  family: string;
  severity: Severity;
  scope: string;
  message: string;
  evidence: string[];
  score: number;
  locations: SlopFindingLocation[];
  path?: string;
}

interface SlopFileScore {
  path: string;
  score: number;
  findingCount: number;
}

export interface SlopReport {
  rootDir?: string;
  summary?: {
    findingCount?: number;
    repoScore?: number;
  };
  findings?: SlopFinding[];
  fileScores?: SlopFileScore[];
}

export interface FileFindingOccurrence {
  signature: string;
  path: string;
  finding: SlopFinding;
  locations: SlopFindingLocation[];
  primaryLocation: SlopFindingLocation;
  otherFileCount: number;
}

export interface SlopDeltaSummary {
  baseFindingCount: number;
  headFindingCount: number;
  newFindingCount: number;
  newFileCount: number;
}

export interface SlopDeltaReport {
  summary: SlopDeltaSummary;
  files: Array<{
    path: string;
    findings: Array<{
      ruleId: string;
      severity: Severity;
      message: string;
      score: number;
      locations: SlopFindingLocation[];
    }>;
  }>;
}

interface CliOptions {
  headPath: string;
  basePath?: string;
  outputMode: OutputMode;
  failOnNew: boolean;
}

function usage() {
  return [
    "slop-review",
    "",
    "Compare slop-analyzer reports, optionally fail CI on new findings, and",
    "emit Hunk agent-context JSON for inline review.",
    "",
    "Usage:",
    "  bun run scripts/slop-review.ts --head <report.json> [--base <report.json>] [--json|--agent-context] [--fail-on-new]",
    "",
    "Examples:",
    "  bun run scripts/slop-review.ts --head slop-report.json --agent-context > slop-agent-context.json",
    "  bun run scripts/slop-review.ts --base base-slop.json --head head-slop.json --fail-on-new",
    "  bun run scripts/slop-review.ts --base base-slop.json --head head-slop.json --json",
  ].join("\n");
}

function compareLocations(left: SlopFindingLocation, right: SlopFindingLocation) {
  return (
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    (left.column ?? 1) - (right.column ?? 1)
  );
}

function uniqueSortedLocations(finding: SlopFinding): SlopFindingLocation[] {
  const fallbackPath = finding.path ?? "<unknown>";
  const locations =
    finding.locations.length > 0
      ? finding.locations
      : [
          {
            path: fallbackPath,
            line: 1,
            column: 1,
          },
        ];
  const seen = new Set<string>();

  return [...locations].sort(compareLocations).filter((location) => {
    const key = `${location.path}:${location.line}:${location.column ?? 1}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export function buildFileFindingOccurrences(report: SlopReport | null | undefined) {
  const occurrences: FileFindingOccurrence[] = [];

  for (const finding of report?.findings ?? []) {
    const locationsByPath = new Map<string, SlopFindingLocation[]>();

    for (const location of uniqueSortedLocations(finding)) {
      const existing = locationsByPath.get(location.path) ?? [];
      existing.push(location);
      locationsByPath.set(location.path, existing);
    }

    const otherFileCount = Math.max(0, locationsByPath.size - 1);

    for (const [path, locations] of locationsByPath.entries()) {
      const primaryLocation = locations[0];
      if (!primaryLocation) {
        continue;
      }

      const signature = JSON.stringify({
        ruleId: finding.ruleId,
        family: finding.family,
        severity: finding.severity,
        scope: finding.scope,
        message: finding.message,
        path,
        evidence: finding.evidence,
        locations: locations.map((location) => ({
          line: location.line,
          column: location.column ?? 1,
        })),
      });

      occurrences.push({
        signature,
        path,
        finding,
        locations,
        primaryLocation,
        otherFileCount,
      });
    }
  }

  return occurrences;
}

function fileOrderMap(report: SlopReport | null | undefined) {
  return new Map((report?.fileScores ?? []).map((score, index) => [score.path, index]));
}

function compareOccurrences(
  left: FileFindingOccurrence,
  right: FileFindingOccurrence,
  order: Map<string, number>,
) {
  const leftOrder = order.get(left.path) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = order.get(right.path) ?? Number.MAX_SAFE_INTEGER;

  return (
    leftOrder - rightOrder ||
    left.path.localeCompare(right.path) ||
    compareLocations(left.primaryLocation, right.primaryLocation) ||
    left.finding.ruleId.localeCompare(right.finding.ruleId) ||
    left.finding.message.localeCompare(right.finding.message)
  );
}

export function buildDeltaOccurrences(
  baseReport: SlopReport | null | undefined,
  headReport: SlopReport,
) {
  const baseSignatures = new Set(
    buildFileFindingOccurrences(baseReport).map((occurrence) => occurrence.signature),
  );
  const order = fileOrderMap(headReport);

  return buildFileFindingOccurrences(headReport)
    .filter((occurrence) => !baseSignatures.has(occurrence.signature))
    .sort((left, right) => compareOccurrences(left, right, order));
}

function formatLocation(location: SlopFindingLocation) {
  return `${location.line}:${location.column ?? 1}`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function scoreForPath(report: SlopReport | null | undefined, targetPath: string) {
  return report?.fileScores?.find((file) => file.path === targetPath)?.score;
}

function severityToConfidence(severity: Severity): AgentAnnotation["confidence"] {
  switch (severity) {
    case "strong":
      return "high";
    case "medium":
      return "medium";
    case "weak":
      return "low";
  }
}

function buildAnnotation(occurrence: FileFindingOccurrence, index: number): AgentAnnotation {
  const extraLines = occurrence.locations.slice(1).map((location) => formatLocation(location));
  const rationaleLines = [
    `Rule: ${occurrence.finding.ruleId}`,
    `Severity: ${occurrence.finding.severity}`,
    `Score: ${occurrence.finding.score.toFixed(2)}`,
    occurrence.otherFileCount > 0
      ? `Also flagged in ${pluralize(occurrence.otherFileCount, "other file")}.`
      : null,
    extraLines.length > 0
      ? `Additional flagged lines in this file: ${extraLines.join(", ")}.`
      : null,
    ...(occurrence.finding.evidence.length > 0
      ? ["Evidence:", ...occurrence.finding.evidence.map((evidence) => `- ${evidence}`)]
      : []),
  ].filter((line): line is string => Boolean(line));

  return {
    id: `slop:${occurrence.finding.ruleId}:${index}`,
    newRange: [occurrence.primaryLocation.line, occurrence.primaryLocation.line],
    summary: occurrence.finding.message,
    rationale: rationaleLines.join("\n"),
    tags: [
      "slop",
      occurrence.finding.family,
      occurrence.finding.severity,
      occurrence.finding.ruleId,
    ],
    confidence: severityToConfidence(occurrence.finding.severity),
    source: "slop-analyzer",
    author: "slop-analyzer",
  };
}

export function buildAgentContext(
  baseReport: SlopReport | null | undefined,
  headReport: SlopReport,
): AgentContext {
  const deltaOccurrences = buildDeltaOccurrences(baseReport, headReport);
  const occurrencesByPath = new Map<string, FileFindingOccurrence[]>();

  for (const occurrence of deltaOccurrences) {
    const existing = occurrencesByPath.get(occurrence.path) ?? [];
    existing.push(occurrence);
    occurrencesByPath.set(occurrence.path, existing);
  }

  const files = [...occurrencesByPath.entries()].map(([path, occurrences]) => {
    const score = scoreForPath(headReport, path);
    return {
      path,
      summary:
        score === undefined
          ? `${pluralize(occurrences.length, "new slop finding")}.`
          : `${pluralize(occurrences.length, "new slop finding")} · hotspot score ${score.toFixed(2)}.`,
      annotations: occurrences.map((occurrence, index) => buildAnnotation(occurrence, index)),
    };
  });

  const baseFindingCount = baseReport?.summary?.findingCount ?? 0;
  const headFindingCount = headReport.summary?.findingCount ?? 0;

  return {
    version: 1,
    summary: baseReport
      ? `slop-analyzer found ${pluralize(deltaOccurrences.length, "new finding")} across ${pluralize(files.length, "file")} vs base (${baseFindingCount} -> ${headFindingCount} total findings).`
      : `slop-analyzer found ${pluralize(deltaOccurrences.length, "finding")} across ${pluralize(files.length, "file")}.`,
    files,
  };
}

export function buildDeltaReport(
  baseReport: SlopReport | null | undefined,
  headReport: SlopReport,
): SlopDeltaReport {
  const deltaOccurrences = buildDeltaOccurrences(baseReport, headReport);
  const grouped = new Map<string, SlopDeltaReport["files"][number]>();

  for (const occurrence of deltaOccurrences) {
    const current = grouped.get(occurrence.path) ?? {
      path: occurrence.path,
      findings: [],
    };
    current.findings.push({
      ruleId: occurrence.finding.ruleId,
      severity: occurrence.finding.severity,
      message: occurrence.finding.message,
      score: occurrence.finding.score,
      locations: occurrence.locations,
    });
    grouped.set(occurrence.path, current);
  }

  return {
    summary: {
      baseFindingCount: baseReport?.summary?.findingCount ?? 0,
      headFindingCount: headReport.summary?.findingCount ?? 0,
      newFindingCount: deltaOccurrences.length,
      newFileCount: grouped.size,
    },
    files: [...grouped.values()],
  };
}

export function formatDeltaText(baseReport: SlopReport | null | undefined, headReport: SlopReport) {
  const delta = buildDeltaReport(baseReport, headReport);

  if (delta.summary.newFindingCount === 0) {
    return baseReport
      ? `No new slop findings vs base. (${delta.summary.baseFindingCount} -> ${delta.summary.headFindingCount} total findings)`
      : "No slop findings.";
  }

  return [
    `New slop findings: ${delta.summary.newFindingCount} across ${pluralize(delta.summary.newFileCount, "file")}`,
    ...(baseReport
      ? [
          `Base findings: ${delta.summary.baseFindingCount}`,
          `Head findings: ${delta.summary.headFindingCount}`,
        ]
      : [`Head findings: ${delta.summary.headFindingCount}`]),
    "",
    ...delta.files.flatMap((file) => [
      `- ${file.path}`,
      ...file.findings.map((finding) => {
        const locations = finding.locations.map((location) => formatLocation(location)).join(", ");
        return `  - ${finding.severity}  ${finding.message}  ${finding.ruleId} @ ${locations}`;
      }),
    ]),
  ].join("\n");
}

async function readReport(pathOrDash: string) {
  const text =
    pathOrDash === "-"
      ? await new Response(Bun.stdin.stream()).text()
      : await Bun.file(pathOrDash).text();

  return JSON.parse(text) as SlopReport;
}

export function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }

  let headPath: string | undefined;
  let basePath: string | undefined;
  let outputMode: OutputMode = "text";
  let failOnNew = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    switch (arg) {
      case "--head": {
        headPath = argv[index + 1];
        index += 1;
        break;
      }
      case "--base": {
        basePath = argv[index + 1];
        index += 1;
        break;
      }
      case "--json": {
        if (outputMode !== "text") {
          throw new Error("Specify only one of --json or --agent-context.");
        }
        outputMode = "json";
        break;
      }
      case "--agent-context": {
        if (outputMode !== "text") {
          throw new Error("Specify only one of --json or --agent-context.");
        }
        outputMode = "agent-context";
        break;
      }
      case "--fail-on-new": {
        failOnNew = true;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  if (!headPath) {
    throw new Error("Pass --head <report.json>.");
  }

  if (
    headPath === undefined ||
    headPath.startsWith("--") ||
    (basePath?.startsWith("--") ?? false)
  ) {
    throw new Error("Expected a file path after --head/--base.");
  }

  return {
    headPath,
    basePath,
    outputMode,
    failOnNew,
  };
}

export async function runCli(argv: string[]) {
  const options = parseArgs(argv);
  const [baseReport, headReport] = await Promise.all([
    options.basePath ? readReport(options.basePath) : Promise.resolve(null),
    readReport(options.headPath),
  ]);
  const delta = buildDeltaReport(baseReport, headReport);

  if (options.outputMode === "json") {
    console.log(JSON.stringify(delta, null, 2));
  } else if (options.outputMode === "agent-context") {
    console.log(JSON.stringify(buildAgentContext(baseReport, headReport), null, 2));
  } else {
    console.log(formatDeltaText(baseReport, headReport));
  }

  return options.failOnNew && delta.summary.newFindingCount > 0 ? 1 : 0;
}

if (import.meta.main) {
  try {
    const exitCode = await runCli(process.argv.slice(2));
    process.exit(exitCode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("");
    console.error(usage());
    process.exit(1);
  }
}
