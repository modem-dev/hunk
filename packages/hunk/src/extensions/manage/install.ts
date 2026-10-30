import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HunkUserError } from "../../core/run/errors";
import { directoryContainsExtensionEntries } from "../discovery";
import { readInstallRecords, writeInstallRecords, type ExtensionInstallRecord } from "./records";
import type { ExtensionInstallSource, GitExtensionInstallSource } from "./source";
import { stageNpmPackage } from "./npm";

/**
 * Supply managed storage, progress, time, and npm configuration to install operations.
 * The CLI resolves the root once; tests use temporary storage and an isolated registry.
 */
export interface ExtensionManageContext {
  /** Managed install root; created on demand. */
  installedRoot: string;
  /** Progress sink; one short line per step. */
  log: (line: string) => void;
  /** Timestamp seam so tests can pin record times. */
  now?: () => Date;
  /** Package-manager environment, including registry configuration. */
  env?: NodeJS.ProcessEnv;
  /** Launch directory whose project npm configuration applies. */
  cwd?: string;
}

/** Outcome of one install or update, for the runner to phrase. */
export interface ExtensionInstallOutcome {
  name: string;
  displayName: string;
  directory: string;
  commit?: string;
  /** Commit for Git sources or resolved version for npm sources. */
  revision: string;
  /** Version from the installed root's `package.json`, when it declares one. */
  version?: string;
  /** Set when dependencies were declared but could not be installed. */
  dependencyWarning?: string;
}

/** One row of `hunk extension list`. */
export interface ExtensionInstallListEntry {
  name: string;
  record: ExtensionInstallRecord;
  directory: string;
  /** Version from the installed `package.json`, when present. */
  version?: string;
  /** False when the recorded directory is gone from disk. */
  present: boolean;
}

/** Run one git invocation, returning stdout or throwing a user-facing error. */
function runGit(args: string[], options: { cwd?: string } = {}) {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["git", ...args], {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (error) {
    throw new HunkUserError(
      `Could not run git: ${error instanceof Error ? error.message : String(error)}`,
      ["Installing extensions requires a git executable on PATH."],
    );
  }

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr?.toString().trim() ?? "";
    throw new HunkUserError(
      `git ${args[0]} failed${stderr.length > 0 ? `: ${stderr.split("\n").at(-1)}` : "."}`,
    );
  }

  return proc.stdout?.toString() ?? "";
}

/** Read one installed root's package version, tolerating missing or malformed manifests. */
function readInstalledVersion(dir: string) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as unknown;
    if (typeof manifest === "object" && manifest !== null) {
      const version = (manifest as Record<string, unknown>).version;
      if (typeof version === "string" && version.length > 0) {
        return version;
      }
    }
  } catch {
    // No package.json, or not one we can read — the install is still valid.
  }

  return undefined;
}

/** Report whether one clone declares npm dependencies its entries may import. */
function declaresDependencies(dir: string) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as unknown;
    if (typeof manifest !== "object" || manifest === null) {
      return false;
    }

    const dependencies = (manifest as Record<string, unknown>).dependencies;
    return (
      typeof dependencies === "object" &&
      dependencies !== null &&
      Object.keys(dependencies as Record<string, unknown>).length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Install a clone's npm dependencies into its own `node_modules`.
 *
 * Hunk itself may be a compiled binary, so this shells out to whatever `bun`
 * is on PATH rather than assuming the running executable can act as a package
 * manager. A missing or failing `bun` degrades to a warning: the extension is
 * installed either way, and the host will report a load issue naming the
 * missing module if the user runs before installing dependencies by hand.
 */
function installDependencies(dir: string): string | undefined {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["bun", "install", "--production"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch {
    return `dependencies not installed — no \`bun\` on PATH; run \`bun install\` (or \`npm install\`) in ${dir}`;
  }

  if (proc.exitCode !== 0) {
    return `dependencies not installed — \`bun install\` failed in ${dir}; run it there to see why`;
  }

  return undefined;
}

/**
 * Clone one source at its requested ref and return the checkout's commit.
 *
 * A ref is usually a branch or tag, which a shallow `--branch` clone fetches
 * in one step; when that fails (a bare commit sha, or a host refusing shallow
 * fetches) the fallback is a full clone plus checkout, which accepts anything
 * `git checkout` does.
 */
function cloneSource(source: GitExtensionInstallSource, destination: string) {
  if (source.ref === undefined) {
    runGit(["clone", "--quiet", "--depth", "1", "--", source.cloneUrl, destination]);
  } else {
    try {
      runGit([
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        source.ref,
        "--",
        source.cloneUrl,
        destination,
      ]);
    } catch {
      rmSync(destination, { recursive: true, force: true });
      runGit(["clone", "--quiet", "--", source.cloneUrl, destination]);
      runGit(["checkout", "--quiet", source.ref], { cwd: destination });
    }
  }

  return runGit(["rev-parse", "HEAD"], { cwd: destination }).trim();
}

/**
 * Acquire either source into hidden staging storage and validate its extension layout.
 * Failures leave the installed directory untouched. Git dependencies wait until commit
 * comparison; npm acquires its complete dependency workspace before version comparison.
 */
function stageSource(context: ExtensionManageContext, source: ExtensionInstallSource) {
  mkdirSync(context.installedRoot, { recursive: true });
  const stagingDir = mkdtempSync(join(context.installedRoot, `.staging-${source.name}-`));

  try {
    if (source.kind === "npm") {
      const version = stageNpmPackage(source, stagingDir, context.env, context.cwd);
      return { stagingDir, revision: version, version };
    }

    const commit = cloneSource(source, stagingDir);

    if (!directoryContainsExtensionEntries(stagingDir)) {
      throw new HunkUserError(`${source.spec} does not contain a Hunk extension.`, [
        'An extension repository needs a package.json with a `hunk` field, an index.* entry, or top-level entry files — see "Publishing an extension" in docs/extensions.md.',
      ]);
    }

    return { stagingDir, revision: commit, commit };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

/** Install a staged clone's npm dependencies when it declares any. */
function prepareStagedDependencies(context: ExtensionManageContext, stagingDir: string) {
  if (!declaresDependencies(stagingDir)) {
    return undefined;
  }

  context.log("installing dependencies…");
  return installDependencies(stagingDir);
}

/**
 * Swap one staged workspace into its final directory.
 *
 * The existing install is moved aside rather than deleted first, so a rename
 * that fails (a file held open on Windows, say) can restore it: the update
 * either lands whole or leaves the previous install exactly where it was.
 * The aside directory is dot-prefixed so discovery never scans it.
 */
function promoteStagedSource(stagingDir: string, directory: string) {
  const previousDir = join(dirname(directory), `.previous-${basename(directory)}`);
  rmSync(previousDir, { recursive: true, force: true });

  const hadPrevious = existsSync(directory);
  if (hadPrevious) {
    renameSync(directory, previousDir);
  }

  try {
    renameSync(stagingDir, directory);
  } catch (error) {
    if (hadPrevious) {
      renameSync(previousDir, directory);
    }
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  rmSync(previousDir, { recursive: true, force: true });
}

/**
 * Persist one record, merging over a fresh read of the stored map.
 *
 * The map is re-read here rather than carried from the operation's start,
 * because a clone sits between the two: merging over that stale snapshot
 * would silently drop any record another process wrote in the meantime. The
 * remaining read-to-write window matches the accepted posture of Hunk's
 * state file (see `updateAppStateRecord`).
 */
function saveRecord(context: ExtensionManageContext, name: string, record: ExtensionInstallRecord) {
  writeInstallRecords(context.installedRoot, {
    ...readInstallRecords(context.installedRoot),
    [name]: record,
  });
}

/**
 * Install one Git or npm extension into the managed root.
 *
 * Refuses a name that is already recorded (update is the explicit path for
 * that) or whose directory already exists unrecorded, so a hand-placed folder
 * is never overwritten by an install that happens to share its name.
 */
export function installExtension(
  context: ExtensionManageContext,
  source: ExtensionInstallSource,
): ExtensionInstallOutcome {
  const records = readInstallRecords(context.installedRoot);
  const directory = join(context.installedRoot, source.name);

  if (Object.hasOwn(records, source.name)) {
    throw new HunkUserError(`"${source.name}" is already installed.`, [
      `Run \`hunk extension update ${source.name}\` to refresh it, or \`hunk extension remove ${source.name}\` first.`,
    ]);
  }

  if (existsSync(directory)) {
    throw new HunkUserError(
      `${directory} already exists but is not a managed install; move it aside before installing "${source.name}".`,
    );
  }

  context.log(`installing ${source.spec}…`);
  const staged = stageSource(context, source);
  const dependencyWarning = prepareAndPromoteSource(context, source, staged.stagingDir, directory);

  const timestamp = (context.now?.() ?? new Date()).toISOString();
  saveRecord(context, source.name, {
    source: source.spec,
    ...sourceRecord(source, staged.revision),
    installedAt: timestamp,
    updatedAt: timestamp,
  });

  return {
    name: source.name,
    displayName: source.kind === "npm" ? source.packageName : source.name,
    directory,
    commit: staged.commit,
    revision: staged.revision,
    version: readInstalledVersion(directory),
    ...(dependencyWarning !== undefined ? { dependencyWarning } : {}),
  };
}

/** Prepare Git dependencies and promote either backend, cleaning staging on every failure path. */
function prepareAndPromoteSource(
  context: ExtensionManageContext,
  source: ExtensionInstallSource,
  stagingDir: string,
  directory: string,
) {
  try {
    const warning =
      source.kind === "git" ? prepareStagedDependencies(context, stagingDir) : undefined;
    promoteStagedSource(stagingDir, directory);
    return warning;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** Build backend-specific persisted identity without inventing Git commits for registry packages. */
function sourceRecord(source: ExtensionInstallSource, revision: string) {
  return source.kind === "npm"
    ? {
        kind: "npm" as const,
        packageName: source.packageName,
        selector: source.selector,
        version: revision,
      }
    : { kind: "git" as const, cloneUrl: source.cloneUrl, ref: source.ref, commit: revision };
}

/** Outcome of one update pass over a single managed install. */
export interface ExtensionUpdateOutcome extends ExtensionInstallOutcome {
  previousCommit?: string;
  previousRevision: string;
  changed: boolean;
}

/**
 * Refresh a managed install by reacquiring its recorded source and comparing backend identity.
 * Git re-cloning avoids assumptions about shallow checkouts or moved refs. npm re-resolves
 * the original selector in isolated storage. Unchanged identities keep the installed workspace.
 */
export function updateExtension(
  context: ExtensionManageContext,
  name: string,
): ExtensionUpdateOutcome {
  const records = readInstallRecords(context.installedRoot);
  name = resolveManagedName(records, name);
  const record = records[name]!;

  const source: ExtensionInstallSource =
    record.kind === "npm"
      ? {
          kind: "npm",
          spec: record.source,
          packageName: record.packageName,
          selector: record.selector,
          name,
        }
      : { kind: "git", spec: record.source, cloneUrl: record.cloneUrl, ref: record.ref, name };
  const previousRevision = record.kind === "npm" ? record.version : record.commit;
  const previousCommit = record.kind === "npm" ? undefined : record.commit;
  const directory = join(context.installedRoot, name);

  context.log(`checking ${record.source}…`);
  const staged = stageSource(context, source);

  if (staged.revision === previousRevision && existsSync(directory)) {
    rmSync(staged.stagingDir, { recursive: true, force: true });
    return {
      name,
      displayName: source.kind === "npm" ? source.packageName : name,
      directory,
      commit: staged.commit,
      revision: staged.revision,
      previousCommit,
      previousRevision,
      changed: false,
      version: readInstalledVersion(directory),
    };
  }

  const dependencyWarning = prepareAndPromoteSource(context, source, staged.stagingDir, directory);
  saveRecord(context, name, {
    ...record,
    ...sourceRecord(source, staged.revision),
    updatedAt: (context.now?.() ?? new Date()).toISOString(),
  });

  return {
    name,
    displayName: source.kind === "npm" ? source.packageName : name,
    directory,
    commit: staged.commit,
    revision: staged.revision,
    previousCommit,
    previousRevision,
    changed: true,
    version: readInstalledVersion(directory),
    ...(dependencyWarning !== undefined ? { dependencyWarning } : {}),
  };
}

/** Resolve a stored directory name or npm package alias without changing existing Git names. */
function resolveManagedName(records: Record<string, ExtensionInstallRecord>, requested: string) {
  if (Object.hasOwn(records, requested)) return requested;
  const packageName = requested.startsWith("npm:") ? requested.slice(4) : requested;
  const entry = Object.entries(records).find(
    ([, record]) => record.kind === "npm" && record.packageName === packageName,
  );
  if (entry) return entry[0];

  throw new HunkUserError(`"${requested}" is not a managed install.`, [
    "Run `hunk extension list` to see managed installs.",
  ]);
}

/** Remove one managed install's directory and record. */
export function removeExtension(context: ExtensionManageContext, name: string) {
  const records = readInstallRecords(context.installedRoot);
  name = resolveManagedName(records, name);

  rmSync(join(context.installedRoot, name), { recursive: true, force: true });
  const { [name]: _removed, ...remaining } = records;
  writeInstallRecords(context.installedRoot, remaining);
}

/** List every managed install, in name order. */
export function listExtensions(context: ExtensionManageContext): ExtensionInstallListEntry[] {
  const records = readInstallRecords(context.installedRoot);

  return Object.entries(records)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, record]) => {
      const directory = join(context.installedRoot, name);
      const present = existsSync(directory);
      const version = present ? readInstalledVersion(directory) : undefined;
      return {
        name,
        record,
        directory,
        present,
        ...(version !== undefined ? { version } : {}),
      };
    });
}
