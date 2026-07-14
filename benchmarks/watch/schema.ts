import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { arch, cpus, hostname, platform, release } from "node:os";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const WATCH_CAMPAIGN_SCHEMA_VERSION = 1 as const;
export const WATCH_PROTOCOL_VERSION = "watch-v1" as const;
export const WATCH_TERMINAL_GEOMETRY = { columns: 120, rows: 30 } as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const timestampSchema = z.string().datetime();
const revisionSchema = z.enum(["base", "candidate"]);
export const watchHostIdSchema = z.enum([
  "macos-arm64-aarmstrong",
  "linux-x64-sentry-agent",
  "windows-arm64-hunk-windows",
  "windows-x64-gha",
  "macos-arm64-currie",
]);
const fixtureLabelSchema = z.enum(["little repo", "big repo"]);
const runKindSchema = z.enum([
  "cold-startup",
  "warmup",
  "startup",
  "idle",
  "git-activity",
  "refresh",
  "observer-probe",
]);
const cacheLabelSchema = z.enum(["cold-ish", "warm"]);
const observerBackendSchema = z.enum([
  "native-recursive",
  "chokidar-portable",
  "poll-only",
  "not-applicable-legacy-polling",
]);

export const fixtureCountsSchema = z.object({
  totalSubdirectoryCount: z.number().int().nonnegative(),
  ignoredSubdirectoryCount: z.number().int().nonnegative(),
  relevantSubdirectoryCount: z.number().int().nonnegative(),
  trackedFileCount: z.number().int().nonnegative(),
  untrackedFileCount: z.number().int().nonnegative(),
  symlinkCount: z.number().int().nonnegative(),
  symlinkPolicy: z.literal("materialize-as-plain-files"),
  maximumDepth: z.number().int().nonnegative(),
});

export const binaryProvenanceFileSchema = z.object({
  schemaVersion: z.literal(1),
  revision: revisionSchema,
  sourceSha: gitShaSchema,
  executablePath: z.string().min(1),
  sha256: sha256Schema,
  sizeBytes: z.number().int().positive(),
  platform: z.enum(["darwin", "linux", "win32"]),
  arch: z.enum(["arm64", "x64"]),
  fileArchitecture: z.string().min(1),
  processArchitecture: z.enum(["arm64", "x64"]),
  host: z.object({
    hostname: z.string().min(1),
    platform: z.enum(["darwin", "linux", "win32"]),
    release: z.string().min(1),
    arch: z.enum(["arm64", "x64"]),
  }),
  bun: z.object({
    path: z.string().min(1),
    version: z.literal("1.3.14"),
    arch: z.enum(["arm64", "x64"]),
  }),
  build: z.object({
    installCommand: z.array(z.string().min(1)).min(1),
    command: z.array(z.string().min(1)).min(1),
    environment: z.record(z.string(), z.string()),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    durationMs: z.number().nonnegative(),
    order: z.number().int().min(1).max(2),
    stdoutLogPath: z.string().min(1),
    stderrLogPath: z.string().min(1),
  }),
  checksumTool: z.enum(["shasum -a 256", "sha256sum", "Get-FileHash SHA256"]),
  smoke: z.object({
    command: z.array(z.string().min(1)).min(1),
    exitCode: z.literal(0),
    stdoutSha256: sha256Schema,
    stderrSha256: sha256Schema,
    succeeded: z.literal(true),
  }),
});

export const campaignConfigSchema = z.object({
  schemaVersion: z.literal(1),
  campaignId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  hostId: watchHostIdSchema,
  expectedHarnessSha: gitShaSchema,
  protocolVersion: z.literal(WATCH_PROTOCOL_VERSION),
  orderSeed: z.string().min(1),
  preflightOnly: z.boolean().default(false),
  outputDir: z.string().min(1),
  binaries: z.object({
    base: z.object({
      executablePath: z.string().min(1),
      provenancePath: z.string().min(1),
      expectedSourceSha: gitShaSchema,
    }),
    candidate: z.object({
      executablePath: z.string().min(1),
      provenancePath: z.string().min(1),
      expectedSourceSha: gitShaSchema,
    }),
  }),
  fixtures: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
        label: fixtureLabelSchema,
        artifactsDir: z.string().min(1),
        repoDir: z.string().min(1),
        manifestSha256: sha256Schema,
        requiredScreenText: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  startupTimeoutMs: z.number().int().positive().default(30_000),
  refreshTimeoutMs: z.number().int().positive().default(10_000),
  idleDurationMs: z.number().int().positive().default(120_000),
  idleSampleIntervalMs: z.number().int().positive().default(10_000),
  refreshTrials: z.number().int().positive().default(5),
});

export type CampaignConfig = z.infer<typeof campaignConfigSchema>;
export type BinaryProvenanceFile = z.infer<typeof binaryProvenanceFileSchema>;
export type BenchmarkRevision = z.infer<typeof revisionSchema>;
export type WatchRunKind = z.infer<typeof runKindSchema>;
export type ObserverBackend = z.infer<typeof observerBackendSchema>;

const binaryProvenanceSchema = binaryProvenanceFileSchema;

const fixtureSchema = z.object({
  id: z.string().min(1),
  label: fixtureLabelSchema,
  sourceSha: gitShaSchema,
  baselineCommit: gitShaSchema,
  manifestSha256: sha256Schema,
  counts: fixtureCountsSchema,
});

const hostSchema = z.object({
  hostId: z.string().min(1),
  hostname: z.string().min(1),
  platform: z.enum(["darwin", "linux", "win32"]),
  release: z.string().min(1),
  arch: z.enum(["arm64", "x64"]),
  cpuModel: z.string().min(1),
  bunVersion: z.string().min(1),
});

const observerMetricsSchema = z.object({
  metricLabel: z.literal("probe process launch -> observer ready"),
  observerReadyStatus: z.enum([
    "ready",
    "not-applicable-legacy-polling",
    "not-measured",
    "timeout",
    "error",
  ]),
  observerReadyMs: z.number().nonnegative().nullable(),
  planDerivationMs: z.number().nonnegative().nullable(),
  constructionToReadyMs: z.number().nonnegative().nullable(),
  selectedBackend: observerBackendSchema,
  degraded: z.boolean(),
});

const startupMetricsSchema = z.object({
  launchToFirstMarkerMs: z.number().nonnegative().nullable(),
  markerVisible: z.boolean(),
  screenTextSha256: sha256Schema.nullable(),
});

const idleSampleSchema = z.object({
  elapsedMs: z.number().int().nonnegative(),
  cpuTimeMs: z.number().nonnegative().nullable(),
  rssBytes: z.number().int().nonnegative().nullable(),
  alive: z.boolean(),
  degraded: z.boolean().nullable(),
  error: z.string().nullable(),
});

const idleMetricsSchema = z.object({
  durationMs: z.number().int().positive(),
  sampleIntervalMs: z.number().int().positive(),
  samples: z.array(idleSampleSchema).min(1),
  first60SecondSamples: z.array(idleSampleSchema),
  first60SecondSample: idleSampleSchema.nullable(),
  finalCpuTimeMs: z.number().nonnegative().nullable(),
  maximumRssBytes: z.number().int().nonnegative().nullable(),
});

const gitActivitySchema = z.object({
  instrumentationMode: z.literal("git-trace2-event"),
  separateFromHeadlineMetrics: z.literal(true),
  tracePath: z.string().min(1),
  durationMs: z.number().int().positive(),
  totalInvocations: z.number().int().nonnegative(),
  groups: z.record(z.string(), z.number().int().nonnegative()),
  commands: z.array(
    z.object({
      timestamp: timestampSchema,
      family: z.string().min(1),
      arguments: z.array(z.string()),
    }),
  ),
  malformedLineCount: z.number().int().nonnegative(),
  childCpuMs: z.number().nonnegative().nullable(),
  childCpuStatus: z.enum(["measured", "not-available"]),
});

const refreshMetricsSchema = z.object({
  scenario: z.enum(["tracked-write", "atomic-rename", "untracked-create"]),
  marker: z.string().min(1),
  latencyMs: z.number().nonnegative().nullable(),
  correct: z.boolean(),
  timedOut: z.boolean(),
});

const errorSchema = z.object({
  code: z.string().min(1),
  phase: z.string().min(1),
  message: z.string().min(1),
});

export const watchRunRecordSchema = z
  .object({
    schemaVersion: z.literal(WATCH_CAMPAIGN_SCHEMA_VERSION),
    protocolVersion: z.literal(WATCH_PROTOCOL_VERSION),
    measurement: z.literal("measured"),
    executionMode: z.enum(["preflight", "final"]),
    campaignId: z.string().min(1),
    orderSeed: z.string().min(1),
    harnessSha: gitShaSchema,
    campaignShas: z.object({
      base: gitShaSchema,
      candidate: gitShaSchema,
      harness: gitShaSchema,
    }),
    host: hostSchema,
    binary: binaryProvenanceSchema,
    fixture: fixtureSchema,
    runId: z.string().min(1),
    runKind: runKindSchema,
    trial: z.number().int().nonnegative(),
    orderIndex: z.number().int().nonnegative(),
    startupLaunchIndex: z.number().int().nonnegative().nullable(),
    cacheLabel: cacheLabelSchema,
    warmup: z.boolean(),
    retryAttempt: z.number().int().min(0).max(1),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    terminal: z.object({
      columns: z.literal(WATCH_TERMINAL_GEOMETRY.columns),
      rows: z.literal(WATCH_TERMINAL_GEOMETRY.rows),
      menuMarker: z.literal("File  View"),
      requiredScreenText: z.array(z.string().min(1)).min(1),
      parser: z.enum(["ghostty-opentui", "xterm-headless-fallback"]),
      rawLogPath: z.string().min(1),
    }),
    startup: startupMetricsSchema.nullable(),
    observer: observerMetricsSchema,
    idle: idleMetricsSchema.nullable(),
    gitActivity: gitActivitySchema.nullable(),
    refresh: refreshMetricsSchema.nullable(),
    valid: z.boolean(),
    errors: z.array(errorSchema),
    cleanupComplete: z.boolean(),
  })
  .superRefine((record, context) => {
    const required = {
      startup:
        record.runKind === "cold-startup" ||
        record.runKind === "warmup" ||
        record.runKind === "startup",
      idle: record.runKind === "idle",
      gitActivity: record.runKind === "git-activity",
      refresh: record.runKind === "refresh",
    };
    for (const [field, expected] of Object.entries(required)) {
      const present = record[field as "startup" | "idle" | "gitActivity" | "refresh"] !== null;
      if ((!expected && present) || (record.valid && expected && !present)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} does not match run kind`,
        });
      }
    }
    if (record.valid && (record.errors.length > 0 || !record.cleanupComplete)) {
      context.addIssue({
        code: "custom",
        message: "Valid records cannot contain errors or cleanup leaks",
      });
    }
  });

export type WatchRunRecord = z.infer<typeof watchRunRecordSchema>;
export type HostMetadata = WatchRunRecord["host"];
export type VerifiedBinary = WatchRunRecord["binary"];
export type FixtureRecord = WatchRunRecord["fixture"];
export type ObserverMetrics = WatchRunRecord["observer"];
export type IdleSample = NonNullable<WatchRunRecord["idle"]>["samples"][number];

/** Read and validate a campaign configuration document. */
export function readCampaignConfig(path: string): CampaignConfig {
  return campaignConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Return a lowercase SHA256 digest for one file. */
export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Verify an absolute compiled executable against its immutable provenance document. */
export function verifyBinaryProvenance(
  revision: BenchmarkRevision,
  executablePath: string,
  provenancePath: string,
  expectedSourceSha?: string,
): VerifiedBinary {
  if (!isAbsolute(executablePath)) throw new Error(`${revision} executable path must be absolute`);
  if (!isAbsolute(provenancePath)) throw new Error(`${revision} provenance path must be absolute`);
  if (!existsSync(executablePath)) throw new Error(`${revision} executable does not exist`);
  const provenance = binaryProvenanceFileSchema.parse(
    JSON.parse(readFileSync(provenancePath, "utf8")),
  );
  if (provenance.revision !== revision) {
    throw new Error(`${revision} provenance revision mismatch`);
  }
  if (!isAbsolute(provenance.executablePath) || provenance.executablePath !== executablePath) {
    throw new Error(`${revision} provenance executable path mismatch`);
  }
  if (expectedSourceSha && provenance.sourceSha !== expectedSourceSha.toLowerCase()) {
    throw new Error(`${revision} source SHA does not match campaign configuration`);
  }
  const actualSha256 = fileSha256(executablePath);
  if (actualSha256 !== provenance.sha256) {
    throw new Error(`${revision} executable SHA256 mismatch`);
  }
  if (provenance.platform !== platform()) {
    throw new Error(
      `${revision} executable platform ${provenance.platform} does not match host ${platform()}`,
    );
  }
  if (provenance.arch !== arch()) {
    throw new Error(
      `${revision} executable architecture ${provenance.arch} does not match host ${arch()}`,
    );
  }
  return provenance;
}

/** Capture stable host metadata repeated in every raw result. */
export function collectHostMetadata(hostId?: string): HostMetadata {
  const detectedPlatform = platform();
  const detectedArch = arch();
  if (!(["darwin", "linux", "win32"] as const).includes(detectedPlatform as never)) {
    throw new Error(`Unsupported benchmark platform: ${detectedPlatform}`);
  }
  if (!(["arm64", "x64"] as const).includes(detectedArch as never)) {
    throw new Error(`Unsupported benchmark architecture: ${detectedArch}`);
  }
  return hostSchema.parse({
    hostId:
      hostId ??
      `${hostname()}-${detectedPlatform}-${detectedArch}`
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-"),
    hostname: hostname(),
    platform: detectedPlatform,
    release: release(),
    arch: detectedArch,
    cpuModel: cpus()[0]?.model ?? "unknown-cpu",
    bunVersion: Bun.version,
  });
}

/** Parse one raw result and reject prose-only or projected artifacts. */
export function parseWatchRunRecord(value: unknown): WatchRunRecord {
  return watchRunRecordSchema.parse(value);
}
