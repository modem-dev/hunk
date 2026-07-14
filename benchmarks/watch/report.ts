#!/usr/bin/env bun

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseWatchRunRecord, type BenchmarkRevision, type WatchRunRecord } from "./schema";

/** Calculate a mean while preserving missing-data semantics. */
function mean(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

/** Format a metric without implying precision absent from the raw samples. */
function metric(value: number | null, unit = ""): string {
  return value === null ? "N/A" : `${value.toFixed(2)}${unit}`;
}

/** Find every raw run record beneath one campaign raw directory. */
export function readRawWatchRecords(directory: string): WatchRunRecord[] {
  const records: WatchRunRecord[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        records.push(parseWatchRunRecord(JSON.parse(readFileSync(child, "utf8"))));
      }
    }
  };
  visit(directory);
  return records.sort((left, right) => left.runId.localeCompare(right.runId));
}

/** Render a descriptive per-host report exclusively from versioned measured raw records. */
export function renderWatchMarkdown(records: readonly WatchRunRecord[]): string {
  if (records.length === 0) throw new Error("No watch campaign records to render");
  const first = records[0]!;
  if (records.some((record) => record.host.hostId !== first.host.hostId)) {
    throw new Error("A per-host report cannot mix host IDs");
  }
  if (records.some((record) => record.executionMode !== first.executionMode)) {
    throw new Error("A report cannot mix preflight and final records");
  }
  const lines = [
    `# Watch benchmark — ${first.host.hostId}`,
    "",
    `Campaign: \`${first.campaignId}\` · Protocol: \`${first.protocolVersion}\` · Harness: \`${first.harnessSha}\``,
    "",
    `Execution mode: **${first.executionMode}**.`,
    "",
    `Host: ${first.host.platform}/${first.host.arch} (${first.host.release}), Bun ${first.host.bunVersion}, ${first.host.cpuModel}`,
    "",
    first.executionMode === "preflight"
      ? "> PRELIMINARY PREFLIGHT ONLY — shortened plumbing measurements must not be published as final benchmark evidence."
      : "> This report is descriptive. Raw records are measured; session-count projections below are explicitly derived and are not raw samples.",
    "",
  ];

  const fixtureIds = [...new Set(records.map((record) => record.fixture.id))].sort();
  for (const fixtureId of fixtureIds) {
    const fixtureRecords = records.filter((record) => record.fixture.id === fixtureId);
    const fixture = fixtureRecords[0]!.fixture;
    lines.push(`## ${fixture.label}`, "");
    lines.push(
      `Fixture source: \`${fixture.sourceSha}\` · Manifest SHA256: \`${fixture.manifestSha256}\``,
      "",
      `Directories: ${fixture.counts.totalSubdirectoryCount} total (${fixture.counts.ignoredSubdirectoryCount} ignored, ${fixture.counts.relevantSubdirectoryCount} relevant) · Files: ${fixture.counts.trackedFileCount} tracked, ${fixture.counts.untrackedFileCount} initially untracked`,
      "",
      "| Revision | Valid runs | Failed runs | Startup mean | Observer ready | Idle CPU delta | Max RSS | Git invocations / run | Refresh mean |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    );

    for (const revision of ["base", "candidate"] as const satisfies readonly BenchmarkRevision[]) {
      const revisionRecords = fixtureRecords.filter(
        (record) => record.binary.revision === revision,
      );
      const valid = revisionRecords.filter((record) => record.valid);
      const startups = valid.filter((record) => record.runKind === "startup" && !record.warmup);
      const idle = valid.filter((record) => record.runKind === "idle");
      const git = valid.filter((record) => record.runKind === "git-activity");
      const refresh = valid.filter((record) => record.runKind === "refresh");
      const idleCpu = idle.map((record) => {
        const samples = record.idle?.samples ?? [];
        const firstSample = samples[0]?.cpuTimeMs;
        const finalSample = samples.at(-1)?.cpuTimeMs;
        return firstSample === null ||
          finalSample === null ||
          firstSample === undefined ||
          finalSample === undefined
          ? null
          : finalSample - firstSample;
      });
      const maxRss = idle.flatMap((record) =>
        (record.idle?.samples ?? []).map((sample) => sample.rssBytes),
      );
      lines.push(
        `| ${revision} | ${valid.length} | ${revisionRecords.length - valid.length} | ${metric(mean(startups.map((record) => record.startup?.launchToFirstMarkerMs)), " ms")} | ${metric(mean(valid.map((record) => record.observer.observerReadyMs)), " ms")} | ${metric(mean(idleCpu), " ms")} | ${metric(mean(maxRss) === null ? null : mean(maxRss)! / 1024 / 1024, " MiB")} | ${metric(mean(git.map((record) => record.gitActivity?.totalInvocations)))} | ${metric(mean(refresh.map((record) => record.refresh?.latencyMs)), " ms")} |`,
      );
    }
    lines.push("");

    lines.push(
      "### Projected continuous cost",
      "",
      "| Revision | Sessions | CPU ms / minute | Git invocations / minute |",
      "|---|---:|---:|---:|",
    );
    for (const revision of ["base", "candidate"] as const satisfies readonly BenchmarkRevision[]) {
      const valid = fixtureRecords.filter(
        (record) => record.valid && record.binary.revision === revision,
      );
      const idleRates = valid
        .filter((record) => record.runKind === "idle")
        .map((record) => {
          const samples = record.idle?.samples ?? [];
          const firstCpu = samples[0]?.cpuTimeMs;
          const finalCpu = samples.at(-1)?.cpuTimeMs;
          return firstCpu === null ||
            finalCpu === null ||
            firstCpu === undefined ||
            finalCpu === undefined
            ? null
            : ((finalCpu - firstCpu) / record.idle!.durationMs) * 60_000;
        });
      const gitRates = valid
        .filter((record) => record.runKind === "git-activity")
        .map((record) =>
          record.gitActivity
            ? (record.gitActivity.totalInvocations / record.gitActivity.durationMs) * 60_000
            : null,
        );
      for (const sessions of [1, 3, 5]) {
        const cpu = mean(idleRates);
        const git = mean(gitRates);
        lines.push(
          `| ${revision} | ${sessions} | ${metric(cpu === null ? null : cpu * sessions)} projected | ${metric(git === null ? null : git * sessions)} projected |`,
        );
      }
    }
    lines.push("");
  }

  const failed = records.filter((record) => !record.valid);
  lines.push(
    "## Completeness",
    "",
    `Valid records: ${records.length - failed.length}/${records.length}.`,
  );
  if (failed.length) {
    lines.push("", "Failed records were preserved:", "");
    for (const record of failed) {
      lines.push(
        `- \`${record.runId}\`: ${record.errors.map((error) => error.message).join("; ")}`,
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** Render one host report from raw JSON without scraping prior Markdown. */
function main(args: string[]): void {
  const rawIndex = args.indexOf("--raw");
  const outputIndex = args.indexOf("--output");
  const rawDir = rawIndex >= 0 ? args[rawIndex + 1] : undefined;
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (!rawDir || !output)
    throw new Error("Usage: report.ts --raw <host-raw-dir> --output <report.md>");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, renderWatchMarkdown(readRawWatchRecords(rawDir)));
}

if (import.meta.main) main(process.argv.slice(2));
