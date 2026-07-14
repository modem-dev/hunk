import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { WATCH_PROTOCOL_VERSION } from "./schema";

export const WATCH_HOST_IDS = [
  "macos-arm64-aarmstrong",
  "linux-x64-sentry-agent",
  "windows-arm64-hunk-windows",
  "windows-x64-gha",
  "macos-arm64-currie",
] as const;

export type WatchHostId = (typeof WATCH_HOST_IDS)[number];

const gitShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const campaignIdSchema = z.string().regex(/^watch-\d{8}T\d{6}Z-b[a-f0-9]{8}-h[a-f0-9]{8}$/);

export const campaignManifestSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.literal(WATCH_PROTOCOL_VERSION),
  campaignId: campaignIdSchema,
  preflightOnly: z.boolean(),
  frozenAt: z.string().datetime(),
  orderSeed: z.string().min(1),
  revisions: z.object({
    base: z.object({ sourceSha: gitShaSchema, sourceRef: z.string().min(1) }),
    candidate: z.object({ sourceSha: gitShaSchema, sourceRef: z.string().min(1) }),
    harness: z.object({ sourceSha: gitShaSchema }),
  }),
  bundleRefs: z.object({
    base: z.string().startsWith("refs/hunk-benchmark/"),
    candidate: z.string().startsWith("refs/hunk-benchmark/"),
    harness: z.string().startsWith("refs/hunk-benchmark/"),
    littleFixtureSource: z.string().startsWith("refs/hunk-benchmark/"),
  }),
  fixtures: z.object({
    "little-repo": z.object({
      sourceSha: gitShaSchema,
      manifestSha256: sha256Schema,
      inputPath: z.literal("inputs/fixtures/little-repo"),
    }),
    "big-repo": z.object({
      sourceSha: gitShaSchema,
      manifestSha256: sha256Schema,
      inputPath: z.literal("inputs/fixtures/big-repo"),
    }),
  }),
  modemFixtureSourceSha: gitShaSchema,
  untrackedPathsExcluded: z.array(z.string()),
  inputChecksumsPath: z.literal("inputs/SHA256SUMS"),
  hostIds: z.array(z.enum(WATCH_HOST_IDS)).min(4),
});

export type CampaignManifest = z.infer<typeof campaignManifestSchema>;

export interface CampaignLayout {
  root: string;
  manifest: string;
  inputs: string;
  bundle: string;
  checksums: string;
  fixtures: Record<"little-repo" | "big-repo", string>;
  hosts: string;
  raw: string;
  summaries: string;
  report: string;
}

/** Create the compact UTC campaign ID from immutable revision SHAs. */
export function campaignIdFor(date: Date, baseSha: string, candidateSha: string): string {
  if (!/^[a-f0-9]{40,64}$/i.test(baseSha) || !/^[a-f0-9]{40,64}$/i.test(candidateSha)) {
    throw new Error("Campaign revisions must be full Git object IDs");
  }
  const compact = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return campaignIdSchema.parse(
    `watch-${compact}-b${baseSha.slice(0, 8).toLowerCase()}-h${candidateSha.slice(0, 8).toLowerCase()}`,
  );
}

/** Resolve every canonical campaign path from one root and ID. */
export function campaignLayout(campaignsDir: string, campaignId: string): CampaignLayout {
  campaignIdSchema.parse(campaignId);
  const root = resolve(campaignsDir, campaignId);
  const inputs = join(root, "inputs");
  return {
    root,
    manifest: join(root, "campaign-manifest.json"),
    inputs,
    bundle: join(inputs, "hunk.bundle"),
    checksums: join(inputs, "SHA256SUMS"),
    fixtures: {
      "little-repo": join(inputs, "fixtures", "little-repo"),
      "big-repo": join(inputs, "fixtures", "big-repo"),
    },
    hosts: join(root, "hosts"),
    raw: join(root, "raw"),
    summaries: join(root, "summaries"),
    report: join(root, "report.md"),
  };
}

/** Return a lowercase SHA256 digest for one file. */
export function campaignFileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Write stable pretty JSON with a trailing newline. */
export function writeCampaignJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Enumerate regular input files in protocol path order without following symlinks. */
export function listCampaignInputFiles(inputsDir: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const protocolPath = relative(inputsDir, absolute).split(sep).join("/");
      if (protocolPath === "SHA256SUMS") continue;
      if (entry.isSymbolicLink())
        throw new Error(`Campaign inputs cannot contain symlinks: ${protocolPath}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(protocolPath);
      else throw new Error(`Unsupported campaign input: ${protocolPath}`);
    }
  };
  visit(inputsDir);
  return files.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

/** Write a complete checksum inventory for the immutable transferred inputs. */
export function writeCampaignChecksums(inputsDir: string): void {
  const lines = listCampaignInputFiles(inputsDir).map(
    (path) => `${campaignFileSha256(join(inputsDir, ...path.split("/")))}  ${path}`,
  );
  writeFileSync(join(inputsDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

/** Read and validate a final or explicitly preflight-only campaign manifest. */
export function readCampaignManifest(campaignRoot: string): CampaignManifest {
  const manifest = campaignManifestSchema.parse(
    JSON.parse(readFileSync(join(campaignRoot, "campaign-manifest.json"), "utf8")),
  );
  if (
    !manifest.preflightOnly &&
    (manifest.revisions.base.sourceRef !== "origin/main" ||
      manifest.revisions.candidate.sourceRef !== "origin/elucid/file-watch")
  ) {
    throw new Error("Final campaign revisions must use the frozen protocol refs");
  }
  return manifest;
}

/** Reject missing, extra, traversing, or modified campaign input files. */
export function verifyCampaignInputs(campaignRoot: string): CampaignManifest {
  const root = resolve(campaignRoot);
  const manifest = readCampaignManifest(root);
  if (basename(root) !== manifest.campaignId) {
    throw new Error(`Campaign directory must be named ${manifest.campaignId}`);
  }
  const inputsDir = join(root, "inputs");
  const checksumPath = join(inputsDir, "SHA256SUMS");
  if (!existsSync(checksumPath)) throw new Error("Campaign input checksum file is missing");
  const expected = new Map<string, string>();
  for (const line of readFileSync(checksumPath, "utf8").trim().split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([a-f0-9]{64})  ([^\\]+)$/.exec(line);
    if (!match) throw new Error(`Invalid campaign checksum line: ${line}`);
    const [, digest, protocolPath] = match;
    if (
      !protocolPath ||
      protocolPath.startsWith("/") ||
      protocolPath.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Invalid campaign input path: ${protocolPath}`);
    }
    if (expected.has(protocolPath)) throw new Error(`Duplicate campaign checksum: ${protocolPath}`);
    expected.set(protocolPath, digest!);
  }
  const actualFiles = listCampaignInputFiles(inputsDir);
  if (JSON.stringify([...expected.keys()].sort()) !== JSON.stringify(actualFiles)) {
    throw new Error("Campaign checksum inventory does not exactly match transferred inputs");
  }
  for (const [protocolPath, digest] of expected) {
    const absolute = join(inputsDir, ...protocolPath.split("/"));
    if (!lstatSync(absolute).isFile() || campaignFileSha256(absolute) !== digest) {
      throw new Error(`Campaign input checksum mismatch: ${protocolPath}`);
    }
  }
  for (const fixtureId of ["little-repo", "big-repo"] as const) {
    const fixture = manifest.fixtures[fixtureId];
    const manifestPath = join(inputsDir, "fixtures", fixtureId, "fixture-manifest.json");
    if (campaignFileSha256(manifestPath) !== fixture.manifestSha256) {
      throw new Error(`${fixtureId} manifest SHA256 mismatch`);
    }
  }
  return manifest;
}
