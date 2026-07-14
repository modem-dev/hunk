#!/usr/bin/env bun

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

export const FIXTURE_LABELS = ["little repo", "big repo"] as const;
export type FixtureLabel = (typeof FIXTURE_LABELS)[number];
export type BenchmarkRevision = "base" | "candidate";

const STARTUP_ORDER = [
  "base",
  "candidate",
  "candidate",
  "base",
  "candidate",
  "base",
  "base",
  "candidate",
  "base",
  "candidate",
] as const satisfies readonly BenchmarkRevision[];

const BASELINE_REF = "refs/heads/hunk-benchmark";
const BENCHMARK_DIR = ".hunk-benchmark";
const TRACKED_PATH = `${BENCHMARK_DIR}/tracked.txt`;
const INITIAL_UNTRACKED_PATH = `${BENCHMARK_DIR}/existing-untracked.txt`;
const MUTATION_UNTRACKED_PATH = `${BENCHMARK_DIR}/mutation-untracked.txt`;
const IGNORED_ROOT = ".hunk-benchmark-ignored";
const FIXED_GIT_DATE = "2000-01-01T00:00:00Z";
const MAX_COMPONENT_LENGTH = 80;
const MAX_RELATIVE_PATH_LENGTH = 240;
const ARTIFACT_FILENAMES = {
  bundle: "fixture.bundle",
  ignoredTree: "ignored-tree.jsonl.gz",
  manifest: "fixture-manifest.json",
  summary: "fixture-summary.md",
  checksums: "checksums.sha256",
} as const;

export interface BuildFixtureOptions {
  sourceGitPath: string;
  sourceSha: string;
  ignoredDirectoryManifestPath: string;
  label: FixtureLabel;
  seed: string;
  scale: number;
  outputDir: string;
}

export interface FixtureCounts {
  totalSubdirectoryCount: number;
  ignoredSubdirectoryCount: number;
  relevantSubdirectoryCount: number;
  trackedFileCount: number;
  untrackedFileCount: number;
  symlinkCount: number;
  symlinkPolicy: "materialize-as-plain-files";
  maximumDepth: number;
}

export interface FixtureManifest {
  schemaVersion: 1;
  label: FixtureLabel;
  sourceSha: string;
  baselineCommit: string;
  seed: string;
  scale: number;
  ignoredRoot: typeof IGNORED_ROOT;
  sourceIgnoredSubdirectoryCount: number;
  counts: FixtureCounts;
  gitCheckoutConfig: {
    coreAutocrlf: false;
    coreSymlinks: false;
  };
  standardState: {
    dirtyTrackedPath: typeof TRACKED_PATH;
    existingUntrackedPath: typeof INITIAL_UNTRACKED_PATH;
  };
}

export interface ReconstructFixtureOptions {
  artifactsDir: string;
  repoDir: string;
}

export interface MutationEvidence {
  beforeSignature: string;
  mutatedSignature: string;
  restoredSignature: string;
}

export interface MutationFixtureOptions extends ReconstructFixtureOptions {
  /** The campaign runner resets before launch, avoiding a watcher-visible reset after readiness. */
  resetBeforeMutation?: boolean;
}

export type MutationObserver = (
  evidence: Omit<MutationEvidence, "restoredSignature"> & { mutationStartedAtMs: number },
) => void | Promise<void>;

interface IgnoredTreeEntry {
  path: string;
}

interface DirectoryGeometry {
  totalSubdirectoryCount: number;
  ignoredSubdirectoryCount: number;
  relevantSubdirectoryCount: number;
  maximumDepth: number;
}

/** Run Git without inheriting user or system configuration. */
function runGit(cwd: string, args: string[], input?: string): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Hunk Benchmark",
      GIT_AUTHOR_EMAIL: "benchmark@hunk.invalid",
      GIT_AUTHOR_DATE: FIXED_GIT_DATE,
      GIT_COMMITTER_NAME: "Hunk Benchmark",
      GIT_COMMITTER_EMAIL: "benchmark@hunk.invalid",
      GIT_COMMITTER_DATE: FIXED_GIT_DATE,
    },
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr).toString("utf8").trim();
    throw new Error(stderr || `git ${args.join(" ")} failed`);
  }
  return Buffer.from(proc.stdout).toString("utf8");
}

/** Return a lowercase SHA256 digest for bytes or text. */
function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Compare protocol paths by their UTF-8 byte representation. */
function compareProtocolPaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/** Validate a relative path against conservative Windows portability limits. */
export function validatePortableRelativePath(path: string): void {
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\")) {
    throw new Error(`Path must be a non-empty slash-separated relative path: ${path}`);
  }
  if (Buffer.byteLength(path, "utf8") > MAX_RELATIVE_PATH_LENGTH) {
    throw new Error(`Portable path exceeds ${MAX_RELATIVE_PATH_LENGTH} bytes: ${path}`);
  }

  const components = path.split("/");
  for (const component of components) {
    if (!component || component === "." || component === "..") {
      throw new Error(`Portable path contains an empty or traversal component: ${path}`);
    }
    if (Buffer.byteLength(component, "utf8") > MAX_COMPONENT_LENGTH) {
      throw new Error(
        `Portable path component exceeds ${MAX_COMPONENT_LENGTH} bytes: ${component}`,
      );
    }
    if (/[\x00-\x1f<>:"|?*]/.test(component)) {
      throw new Error(`Portable path component contains Windows-illegal characters: ${component}`);
    }
    if (/[. ]$/.test(component)) {
      throw new Error(`Portable path component has a trailing dot or space: ${component}`);
    }
    const stem = component.split(".")[0]?.toUpperCase();
    if (stem && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      throw new Error(`Portable path component uses a Windows reserved name: ${component}`);
    }
  }
}

/** Read source directory paths from JSONL strings or `{ "path": ... }` records. */
function readSourceIgnoredDirectories(manifestPath: string): string[] {
  const paths = new Set<string>();
  const lines = readFileSync(manifestPath, "utf8").split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid ignored-directory JSONL at line ${index + 1}`);
    }
    const sourcePath =
      typeof parsed === "string"
        ? parsed
        : typeof parsed === "object" && parsed !== null && "path" in parsed
          ? (parsed as { path?: unknown }).path
          : undefined;
    if (typeof sourcePath !== "string") {
      throw new Error(`Ignored-directory line ${index + 1} must be a string or path record`);
    }
    const normalized = sourcePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
      throw new Error(`Ignored source path must be relative: ${sourcePath}`);
    }
    const components = normalized.split("/");
    if (components.some((component) => !component || component === "." || component === "..")) {
      throw new Error(`Ignored source path contains traversal or empty components: ${sourcePath}`);
    }
    for (let depth = 1; depth <= components.length; depth += 1) {
      paths.add(components.slice(0, depth).join("/"));
    }
  }
  return [...paths].sort(compareProtocolPaths);
}

/** Sanitize source paths without retaining source names while preserving tree shape. */
export function createPortableIgnoredTree(
  sourcePaths: readonly string[],
  seed: string,
  scale: number,
): IgnoredTreeEntry[] {
  if (!Number.isSafeInteger(scale) || scale <= 0) {
    throw new Error("Fixture scale must be a positive safe integer");
  }
  if (!seed) throw new Error("Fixture seed must not be empty");

  const childrenByParent = new Map<string, Set<string>>();
  for (const sourcePath of sourcePaths) {
    const components = sourcePath.split("/");
    for (let depth = 1; depth <= components.length; depth += 1) {
      const parent = components.slice(0, depth - 1).join("/");
      const children = childrenByParent.get(parent) ?? new Set<string>();
      children.add(components[depth - 1]!);
      childrenByParent.set(parent, children);
    }
  }

  const mappedBySource = new Map<string, string>();
  for (const [parent, children] of childrenByParent) {
    const orderedChildren = [...children].sort((left, right) => {
      const leftDigest = sha256(`${seed}\0${scale}\0${parent}\0${left}`);
      const rightDigest = sha256(`${seed}\0${scale}\0${parent}\0${right}`);
      return compareProtocolPaths(leftDigest, rightDigest) || compareProtocolPaths(left, right);
    });
    for (const [index, child] of orderedChildren.entries()) {
      const sourcePrefix = parent ? `${parent}/${child}` : child;
      mappedBySource.set(sourcePrefix, `d${index.toString(36)}`);
    }
  }

  const mappedPaths = new Set<string>();
  for (const sourcePath of [...sourcePaths].sort(compareProtocolPaths)) {
    const sourceComponents = sourcePath.split("/");
    const mappedComponents = sourceComponents.map((_, index) => {
      const sourcePrefix = sourceComponents.slice(0, index + 1).join("/");
      return mappedBySource.get(sourcePrefix)!;
    });
    const mappedPath = `${IGNORED_ROOT}/${mappedComponents.join("/")}`;
    validatePortableRelativePath(mappedPath);
    if (mappedPaths.has(mappedPath))
      throw new Error(`Sanitized ignored path collision: ${mappedPath}`);
    mappedPaths.add(mappedPath);
  }
  return [...mappedPaths].sort(compareProtocolPaths).map((path) => ({ path }));
}

/** Select the stored-seed balanced 10-launch startup order or its exact mirror. */
export function startupLaunchOrder(seed: string): BenchmarkRevision[] {
  if (!seed) throw new Error("Startup order seed must not be empty");
  const useMirror = Number.parseInt(sha256(`startup-launch-order-v1\0${seed}`).slice(0, 2), 16) % 2;
  return STARTUP_ORDER.map((revision) =>
    useMirror ? (revision === "base" ? "candidate" : "base") : revision,
  );
}

/** Decode and validate the deterministic ignored-tree artifact. */
function readIgnoredTree(artifactsDir: string): IgnoredTreeEntry[] {
  const compressed = readFileSync(join(artifactsDir, ARTIFACT_FILENAMES.ignoredTree));
  const lines = gunzipSync(compressed).toString("utf8").split("\n").filter(Boolean);
  const entries = lines.map((line, index) => {
    const parsed = JSON.parse(line) as Partial<IgnoredTreeEntry>;
    if (typeof parsed.path !== "string") {
      throw new Error(`Invalid ignored-tree entry at line ${index + 1}`);
    }
    validatePortableRelativePath(parsed.path);
    if (!parsed.path.startsWith(`${IGNORED_ROOT}/`)) {
      throw new Error(`Ignored-tree entry is outside ${IGNORED_ROOT}: ${parsed.path}`);
    }
    return { path: parsed.path };
  });
  const sorted = [...entries].sort((a, b) => compareProtocolPaths(a.path, b.path));
  if (JSON.stringify(entries) !== JSON.stringify(sorted)) {
    throw new Error("Ignored-tree entries are not in stable order");
  }
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error("Ignored-tree artifact contains duplicate paths");
  }
  return entries;
}

/** Configure checkout behavior before materializing any tracked files. */
function configurePortableCheckout(repoDir: string): void {
  runGit(repoDir, ["config", "core.autocrlf", "false"]);
  runGit(repoDir, ["config", "core.symlinks", "false"]);
}

/** Materialize only the directory shape represented by the ignored-tree artifact. */
function materializeIgnoredTree(repoDir: string, entries: readonly IgnoredTreeEntry[]): void {
  mkdirSync(join(repoDir, IGNORED_ROOT), { recursive: true });
  for (const entry of entries)
    mkdirSync(join(repoDir, ...entry.path.split("/")), { recursive: true });
}

/** Enumerate fixture directory geometry while excluding `.git` internals. */
function inspectDirectoryGeometry(repoDir: string): DirectoryGeometry {
  let totalSubdirectoryCount = 0;
  let ignoredSubdirectoryCount = 0;
  let relevantSubdirectoryCount = 0;
  let maximumDepth = 0;

  const visit = (directory: string, components: string[]): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || (components.length === 0 && entry.name === ".git")) continue;
      const childComponents = [...components, entry.name];
      const child = join(directory, entry.name);
      totalSubdirectoryCount += 1;
      maximumDepth = Math.max(maximumDepth, childComponents.length);
      if (childComponents[0] === IGNORED_ROOT) ignoredSubdirectoryCount += 1;
      else relevantSubdirectoryCount += 1;
      visit(child, childComponents);
    }
  };
  visit(repoDir, []);
  return {
    totalSubdirectoryCount,
    ignoredSubdirectoryCount,
    relevantSubdirectoryCount,
    maximumDepth,
  };
}

/** Count tracked symlink entries from the index, independent of checkout representation. */
function countTrackedSymlinks(repoDir: string): number {
  return runGit(repoDir, ["ls-files", "--stage", "-z"])
    .split("\0")
    .filter((entry) => entry.startsWith("120000 ")).length;
}

/** Return all tracked protocol paths and reject submodules or nonportable names. */
function validateTrackedTree(repoDir: string): string[] {
  const stageEntries = runGit(repoDir, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean);
  for (const entry of stageEntries) {
    if (entry.startsWith("160000 "))
      throw new Error("Fixture source must not contain Git submodules");
  }
  const paths = runGit(repoDir, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const path of paths) validatePortableRelativePath(path);
  return paths;
}

/** Apply the standardized dirty tracked and existing untracked state. */
function applyStandardState(repoDir: string, ignoredEntries: readonly IgnoredTreeEntry[]): void {
  materializeIgnoredTree(repoDir, ignoredEntries);
  writeFileSync(
    join(repoDir, ...TRACKED_PATH.split("/")),
    "benchmark fixture baseline\nstandard dirty tracked modification\n",
  );
  writeFileSync(
    join(repoDir, ...INITIAL_UNTRACKED_PATH.split("/")),
    "standard existing untracked file\n",
  );
}

/** Inspect all counts required by the benchmark protocol. */
function inspectFixtureCounts(repoDir: string): FixtureCounts {
  const geometry = inspectDirectoryGeometry(repoDir);
  const trackedFileCount = runGit(repoDir, ["ls-files", "-z"]).split("\0").filter(Boolean).length;
  const untrackedFileCount = runGit(repoDir, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean).length;
  return {
    ...geometry,
    trackedFileCount,
    untrackedFileCount,
    symlinkCount: countTrackedSymlinks(repoDir),
    symlinkPolicy: "materialize-as-plain-files",
  };
}

/** Write one stable JSON document with a trailing newline. */
function writeStableJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Render fixture counts for human-readable campaign records. */
function fixtureSummary(manifest: FixtureManifest): string {
  const counts = manifest.counts;
  return `# ${manifest.label}\n\nSource snapshot: \`${manifest.sourceSha}\`\n\n| Count | Value |\n|---|---:|\n| Total subdirectories | ${counts.totalSubdirectoryCount} |\n| Ignored subdirectories | ${counts.ignoredSubdirectoryCount} |\n| Relevant subdirectories | ${counts.relevantSubdirectoryCount} |\n| Tracked files | ${counts.trackedFileCount} |\n| Initial untracked files | ${counts.untrackedFileCount} |\n| Symlinks | ${counts.symlinkCount} (${counts.symlinkPolicy}) |\n| Maximum depth | ${counts.maximumDepth} |\n`;
}

/** Write SHA256 checksums for every content artifact. */
function writeChecksums(outputDir: string): void {
  const filenames = [
    ARTIFACT_FILENAMES.bundle,
    ARTIFACT_FILENAMES.ignoredTree,
    ARTIFACT_FILENAMES.manifest,
    ARTIFACT_FILENAMES.summary,
  ].sort(compareProtocolPaths);
  const lines = filenames.map(
    (filename) => `${sha256(readFileSync(join(outputDir, filename)))}  ${filename}`,
  );
  writeFileSync(join(outputDir, ARTIFACT_FILENAMES.checksums), `${lines.join("\n")}\n`);
}

/** Verify content artifacts before reconstructing a fixture. */
export function verifyFixtureArtifacts(artifactsDir: string): void {
  const checksumPath = join(artifactsDir, ARTIFACT_FILENAMES.checksums);
  const lines = readFileSync(checksumPath, "utf8").trim().split(/\r?\n/);
  const seen = new Set<string>();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    const [, expected, filename] = match;
    if (!filename || basename(filename) !== filename)
      throw new Error(`Invalid artifact filename: ${filename}`);
    const actual = sha256(readFileSync(join(artifactsDir, filename)));
    if (actual !== expected) throw new Error(`Checksum mismatch for ${filename}`);
    seen.add(filename);
  }
  for (const filename of [
    ARTIFACT_FILENAMES.bundle,
    ARTIFACT_FILENAMES.ignoredTree,
    ARTIFACT_FILENAMES.manifest,
    ARTIFACT_FILENAMES.summary,
  ]) {
    if (!seen.has(filename)) throw new Error(`Missing checksum for ${filename}`);
  }
}

/** Read the committed fixture manifest after basic schema validation. */
export function readFixtureManifest(artifactsDir: string): FixtureManifest {
  const manifest = JSON.parse(
    readFileSync(join(artifactsDir, ARTIFACT_FILENAMES.manifest), "utf8"),
  ) as FixtureManifest;
  if (manifest.schemaVersion !== 1 || !FIXTURE_LABELS.includes(manifest.label)) {
    throw new Error("Unsupported fixture manifest");
  }
  return manifest;
}

/** Build sanitized, deterministic fixture artifacts from an exact Git snapshot. */
export function buildFixture(options: BuildFixtureOptions): FixtureManifest {
  if (!FIXTURE_LABELS.includes(options.label))
    throw new Error(`Unsupported fixture label: ${options.label}`);
  if (!/^[a-f0-9]{40,64}$/i.test(options.sourceSha))
    throw new Error("sourceSha must be a full Git object ID");

  const sourceDirectories = readSourceIgnoredDirectories(options.ignoredDirectoryManifestPath);
  const ignoredEntries = createPortableIgnoredTree(sourceDirectories, options.seed, options.scale);
  const tempRoot = mkdtempSync(join(tmpdir(), "hunk-watch-fixture-build-"));
  const repoDir = join(tempRoot, "repo");
  const outputDir = resolve(options.outputDir);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  try {
    mkdirSync(repoDir);
    runGit(repoDir, ["init", "--quiet"]);
    configurePortableCheckout(repoDir);
    runGit(repoDir, [
      "fetch",
      "--quiet",
      "--no-tags",
      resolve(options.sourceGitPath),
      options.sourceSha,
    ]);
    const fetchedSha = runGit(repoDir, ["rev-parse", "FETCH_HEAD^{commit}"]).trim();
    if (fetchedSha.toLowerCase() !== options.sourceSha.toLowerCase()) {
      throw new Error(`Fetched ${fetchedSha}, expected ${options.sourceSha}`);
    }
    runGit(repoDir, ["checkout", "--quiet", "--detach", fetchedSha]);
    const sourceTrackedPaths = validateTrackedTree(repoDir);
    for (const reservedPath of [TRACKED_PATH, INITIAL_UNTRACKED_PATH, MUTATION_UNTRACKED_PATH]) {
      if (sourceTrackedPaths.includes(reservedPath))
        throw new Error(`Source snapshot uses reserved path: ${reservedPath}`);
    }
    if (existsSync(join(repoDir, IGNORED_ROOT))) {
      throw new Error(`Source snapshot uses reserved directory: ${IGNORED_ROOT}`);
    }

    const gitignorePath = join(repoDir, ".gitignore");
    const priorGitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    const separator = priorGitignore && !priorGitignore.endsWith("\n") ? "\n" : "";
    const ignoreRule = `/${IGNORED_ROOT}/`;
    const nextGitignore = priorGitignore.split(/\r?\n/).includes(ignoreRule)
      ? priorGitignore
      : `${priorGitignore}${separator}${ignoreRule}\n`;
    writeFileSync(gitignorePath, nextGitignore);
    mkdirSync(join(repoDir, BENCHMARK_DIR), { recursive: true });
    writeFileSync(join(repoDir, ...TRACKED_PATH.split("/")), "benchmark fixture baseline\n");
    runGit(repoDir, ["add", "--", ".gitignore", TRACKED_PATH]);

    const tree = runGit(repoDir, ["write-tree"]).trim();
    const baselineCommit = runGit(
      repoDir,
      ["commit-tree", tree],
      "Create deterministic watch benchmark baseline\n",
    ).trim();
    runGit(repoDir, ["update-ref", BASELINE_REF, baselineCommit]);
    runGit(repoDir, ["checkout", "--quiet", "-B", "hunk-benchmark", baselineCommit]);

    const ignoredJsonl =
      ignoredEntries.map((entry) => JSON.stringify(entry)).join("\n") +
      (ignoredEntries.length ? "\n" : "");
    writeFileSync(
      join(outputDir, ARTIFACT_FILENAMES.ignoredTree),
      gzipSync(Buffer.from(ignoredJsonl), { level: 9 }),
    );
    runGit(repoDir, ["bundle", "create", join(outputDir, ARTIFACT_FILENAMES.bundle), BASELINE_REF]);

    applyStandardState(repoDir, ignoredEntries);
    const counts = inspectFixtureCounts(repoDir);
    if (counts.ignoredSubdirectoryCount !== ignoredEntries.length + 1) {
      throw new Error("Ignored tree reconstruction count does not match its manifest");
    }
    if (counts.untrackedFileCount !== 1) {
      throw new Error("Standard fixture state must contain exactly one untracked file");
    }

    const manifest: FixtureManifest = {
      schemaVersion: 1,
      label: options.label,
      sourceSha: options.sourceSha.toLowerCase(),
      baselineCommit,
      seed: options.seed,
      scale: options.scale,
      ignoredRoot: IGNORED_ROOT,
      sourceIgnoredSubdirectoryCount: sourceDirectories.length,
      counts,
      gitCheckoutConfig: { coreAutocrlf: false, coreSymlinks: false },
      standardState: {
        dirtyTrackedPath: TRACKED_PATH,
        existingUntrackedPath: INITIAL_UNTRACKED_PATH,
      },
    };
    writeStableJson(join(outputDir, ARTIFACT_FILENAMES.manifest), manifest);
    writeFileSync(join(outputDir, ARTIFACT_FILENAMES.summary), fixtureSummary(manifest));
    writeChecksums(outputDir);
    return manifest;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** Assert that a reconstructed checkout matches all manifest invariants. */
function verifyReconstructedState(repoDir: string, manifest: FixtureManifest): void {
  const actualCommit = runGit(repoDir, ["rev-parse", "HEAD"]).trim();
  if (actualCommit !== manifest.baselineCommit)
    throw new Error("Fixture is not at its baseline commit");
  const counts = inspectFixtureCounts(repoDir);
  if (JSON.stringify(counts) !== JSON.stringify(manifest.counts)) {
    throw new Error(`Fixture counts differ from manifest: ${JSON.stringify(counts)}`);
  }
  if (runGit(repoDir, ["remote"]).trim())
    throw new Error("Reconstructed fixture must not retain remotes");
  if (runGit(repoDir, ["config", "--get", "core.autocrlf"]).trim() !== "false") {
    throw new Error("core.autocrlf must be false");
  }
  if (runGit(repoDir, ["config", "--get", "core.symlinks"]).trim() !== "false") {
    throw new Error("core.symlinks must be false");
  }
}

/** Reset an existing checkout to the exact standardized benchmark state. */
export function resetFixtureState(options: ReconstructFixtureOptions): FixtureManifest {
  verifyFixtureArtifacts(options.artifactsDir);
  const manifest = readFixtureManifest(options.artifactsDir);
  const ignoredEntries = readIgnoredTree(options.artifactsDir);
  runGit(options.repoDir, ["reset", "--hard", "--quiet", manifest.baselineCommit]);
  rmSync(join(options.repoDir, IGNORED_ROOT), { recursive: true, force: true });
  runGit(options.repoDir, ["clean", "-ffd", "--quiet"]);
  applyStandardState(options.repoDir, ignoredEntries);
  verifyReconstructedState(options.repoDir, manifest);
  return manifest;
}

/** Reconstruct a fixture without creating a remote or checking out platform-native symlinks. */
export function reconstructFixture(options: ReconstructFixtureOptions): FixtureManifest {
  verifyFixtureArtifacts(options.artifactsDir);
  if (existsSync(options.repoDir) && readdirSync(options.repoDir).length > 0) {
    throw new Error(`Fixture destination is not empty: ${options.repoDir}`);
  }
  mkdirSync(options.repoDir, { recursive: true });
  runGit(options.repoDir, ["init", "--quiet"]);
  configurePortableCheckout(options.repoDir);
  runGit(options.repoDir, [
    "fetch",
    "--quiet",
    "--no-tags",
    join(resolve(options.artifactsDir), ARTIFACT_FILENAMES.bundle),
    BASELINE_REF,
  ]);
  runGit(options.repoDir, ["checkout", "--quiet", "-B", "hunk-benchmark", "FETCH_HEAD"]);
  return resetFixtureState(options);
}

/** Hash Git's tracked diff plus sorted untracked paths and bytes. */
export function authoritativeGitSignature(repoDir: string): string {
  const hash = createHash("sha256");
  hash.update(runGit(repoDir, ["diff", "--binary", "--full-index", "HEAD", "--"]));
  const untracked = runGit(repoDir, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort(compareProtocolPaths);
  for (const path of untracked) {
    hash.update(path);
    hash.update("\0");
    const absolutePath = join(repoDir, ...path.split("/"));
    if (!lstatSync(absolutePath).isFile())
      throw new Error(`Untracked signature path is not a file: ${path}`);
    hash.update(readFileSync(absolutePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Execute one mutation, prove its Git signature changed, then restore after observation. */
async function mutateAndRestore(
  options: MutationFixtureOptions,
  mutate: () => void,
  observe?: MutationObserver,
): Promise<MutationEvidence> {
  if (options.resetBeforeMutation !== false) resetFixtureState(options);
  const beforeSignature = authoritativeGitSignature(options.repoDir);
  let mutatedSignature = beforeSignature;
  try {
    const mutationStartedAtMs = performance.now();
    mutate();
    mutatedSignature = authoritativeGitSignature(options.repoDir);
    if (mutatedSignature === beforeSignature) {
      throw new Error("Mutation did not change the authoritative Git signature");
    }
    await observe?.({ beforeSignature, mutatedSignature, mutationStartedAtMs });
  } finally {
    resetFixtureState(options);
  }
  const restoredSignature = authoritativeGitSignature(options.repoDir);
  if (restoredSignature !== beforeSignature)
    throw new Error("Mutation did not restore standard fixture state");
  return { beforeSignature, mutatedSignature, restoredSignature };
}

/** Benchmark an ordinary in-place tracked-file write and restore after observation. */
export function ordinaryTrackedWrite(
  options: MutationFixtureOptions,
  observe?: MutationObserver,
): Promise<MutationEvidence> {
  return mutateAndRestore(
    options,
    () => {
      const trackedPath = join(options.repoDir, ...TRACKED_PATH.split("/"));
      writeFileSync(trackedPath, `${readFileSync(trackedPath, "utf8")}ordinary tracked write\n`);
    },
    observe,
  );
}

/** Benchmark a temp-file plus atomic rename over the tracked benchmark file. */
export function atomicRenameTrackedWrite(
  options: MutationFixtureOptions,
  observe?: MutationObserver,
): Promise<MutationEvidence> {
  return mutateAndRestore(
    options,
    () => {
      const trackedPath = join(options.repoDir, ...TRACKED_PATH.split("/"));
      const tempPath = join(dirname(trackedPath), "tracked.txt.tmp");
      writeFileSync(tempPath, `${readFileSync(trackedPath, "utf8")}atomic tracked write\n`);
      renameSync(tempPath, trackedPath);
    },
    observe,
  );
}

/** Benchmark creation of a relevant, non-ignored untracked file. */
export function relevantUntrackedCreation(
  options: MutationFixtureOptions,
  observe?: MutationObserver,
): Promise<MutationEvidence> {
  return mutateAndRestore(
    options,
    () => {
      writeFileSync(
        join(options.repoDir, ...MUTATION_UNTRACKED_PATH.split("/")),
        "relevant untracked mutation\n",
      );
    },
    observe,
  );
}

/** Read a required CLI option from a minimal `--name value` argument list. */
function cliOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

/** Run fixture build and reconstruction commands for campaign preparation. */
function main(args: string[]): void {
  const [command, ...options] = args;
  if (command === "build") {
    const label = cliOption(options, "--label") as FixtureLabel;
    const manifest = buildFixture({
      sourceGitPath: cliOption(options, "--source-git"),
      sourceSha: cliOption(options, "--source-sha"),
      ignoredDirectoryManifestPath: cliOption(options, "--ignored-manifest"),
      label,
      seed: cliOption(options, "--seed"),
      scale: Number(cliOption(options, "--scale")),
      outputDir: cliOption(options, "--output"),
    });
    console.log(`${manifest.label}: ${manifest.counts.totalSubdirectoryCount} subdirectories`);
    return;
  }
  if (command === "reconstruct") {
    const manifest = reconstructFixture({
      artifactsDir: cliOption(options, "--artifacts"),
      repoDir: cliOption(options, "--repo"),
    });
    console.log(
      `${manifest.label}: reconstructed ${manifest.counts.totalSubdirectoryCount} subdirectories`,
    );
    return;
  }
  throw new Error("Usage: fixture.ts build|reconstruct [options]");
}

if (import.meta.main) main(process.argv.slice(2));
