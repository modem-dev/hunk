import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HunkUserError } from "../../core/run/errors";
import { directoryContainsExtensionEntries } from "../discovery";
import { readInstallRecords, writeInstallRecords, type ExtensionInstallRecord } from "./records";
import type { ExtensionInstallSource } from "./source";

/**
 * Everything the managed-install operations need from their caller.
 *
 * The operations are pure filesystem-and-git against `installedRoot`, so the
 * CLI runner resolves the root once from the environment and tests point it at
 * a temp directory; nothing in here reads global state.
 */
export interface ExtensionManageContext {
  /** Managed install root; created on demand. */
  installedRoot: string;
  /** Progress sink; one short line per step. */
  log: (line: string) => void;
  /** Timestamp seam so tests can pin record times. */
  now?: () => Date;
}

/** Outcome of one install or update, for the runner to phrase. */
export interface ExtensionInstallOutcome {
  name: string;
  directory: string;
  commit: string;
  /** Version from the clone's `package.json`, when it declares one. */
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

/** Read one clone's `package.json` version, tolerating anything malformed. */
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
function cloneSource(source: ExtensionInstallSource, destination: string) {
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
 * Clone into a staging directory and validate the layout.
 *
 * Everything that can fail happens against the staging path, so the real
 * install directory is only ever swapped in whole; a failed install or update
 * leaves whatever was there before untouched. Dependencies are deliberately
 * not installed here: an update compares the staged commit first, so an
 * unchanged install never pays for a dependency pass.
 */
function stageClone(context: ExtensionManageContext, source: ExtensionInstallSource) {
  mkdirSync(context.installedRoot, { recursive: true });
  // Pid-suffixed so two overlapping commands for the same name cannot clone
  // into — or clean up — each other's staging directory.
  const stagingDir = join(context.installedRoot, `.staging-${source.name}-${process.pid}`);
  rmSync(stagingDir, { recursive: true, force: true });

  let commit: string;
  try {
    commit = cloneSource(source, stagingDir);

    if (!directoryContainsExtensionEntries(stagingDir)) {
      throw new HunkUserError(`${source.spec} does not contain a Hunk extension.`, [
        'An extension repository needs a package.json with a `hunk` field, an index.* entry, or top-level entry files — see "Publishing an extension" in docs/extensions.md.',
      ]);
    }

    return { stagingDir, commit };
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
 * Swap one staged clone into its final directory.
 *
 * The existing install is moved aside rather than deleted first, so a rename
 * that fails (a file held open on Windows, say) can restore it: the update
 * either lands whole or leaves the previous install exactly where it was.
 * The aside directory is dot-prefixed so discovery never scans it.
 */
function promoteStagedClone(stagingDir: string, directory: string) {
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
 * Install one extension repository into the managed root.
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

  if (records[source.name]) {
    throw new HunkUserError(`"${source.name}" is already installed.`, [
      `Run \`hunk extension update ${source.name}\` to refresh it, or \`hunk extension remove ${source.name}\` first.`,
    ]);
  }

  if (existsSync(directory)) {
    throw new HunkUserError(
      `${directory} already exists but is not a managed install; move it aside before installing "${source.name}".`,
    );
  }

  context.log(`cloning ${source.cloneUrl}${source.ref ? ` @ ${source.ref}` : ""}…`);
  const { stagingDir, commit } = stageClone(context, source);
  const dependencyWarning = prepareStagedDependencies(context, stagingDir);
  promoteStagedClone(stagingDir, directory);

  const timestamp = (context.now?.() ?? new Date()).toISOString();
  saveRecord(context, source.name, {
    source: source.spec,
    cloneUrl: source.cloneUrl,
    ...(source.ref !== undefined ? { ref: source.ref } : {}),
    commit,
    installedAt: timestamp,
    updatedAt: timestamp,
  });

  return {
    name: source.name,
    directory,
    commit,
    version: readInstalledVersion(directory),
    ...(dependencyWarning !== undefined ? { dependencyWarning } : {}),
  };
}

/** Outcome of one update pass over a single managed install. */
export interface ExtensionUpdateOutcome extends ExtensionInstallOutcome {
  previousCommit: string;
  changed: boolean;
}

/**
 * Update one managed install by re-cloning its recorded source.
 *
 * Re-cloning rather than fetching keeps the operation insensitive to how the
 * previous clone was made (shallow, force-pushed ref, moved tag) at the cost
 * of bandwidth, which is the right trade for something run occasionally.
 */
export function updateExtension(
  context: ExtensionManageContext,
  name: string,
): ExtensionUpdateOutcome {
  const records = readInstallRecords(context.installedRoot);
  const record = records[name];
  if (!record) {
    throw new HunkUserError(`"${name}" is not a managed install.`, [
      "Run `hunk extension list` to see managed installs.",
    ]);
  }

  const source: ExtensionInstallSource = {
    spec: record.source,
    cloneUrl: record.cloneUrl,
    ...(record.ref !== undefined ? { ref: record.ref } : {}),
    name,
  };
  const directory = join(context.installedRoot, name);

  context.log(`checking ${record.cloneUrl}${record.ref ? ` @ ${record.ref}` : ""}…`);
  const { stagingDir, commit } = stageClone(context, source);

  if (commit === record.commit && existsSync(directory)) {
    rmSync(stagingDir, { recursive: true, force: true });
    return {
      name,
      directory,
      commit,
      previousCommit: record.commit,
      changed: false,
      version: readInstalledVersion(directory),
    };
  }

  const dependencyWarning = prepareStagedDependencies(context, stagingDir);
  promoteStagedClone(stagingDir, directory);
  saveRecord(context, name, {
    ...record,
    commit,
    updatedAt: (context.now?.() ?? new Date()).toISOString(),
  });

  return {
    name,
    directory,
    commit,
    previousCommit: record.commit,
    changed: true,
    version: readInstalledVersion(directory),
    ...(dependencyWarning !== undefined ? { dependencyWarning } : {}),
  };
}

/** Remove one managed install's directory and record. */
export function removeExtension(context: ExtensionManageContext, name: string) {
  const records = readInstallRecords(context.installedRoot);
  const record = records[name];
  if (!record) {
    throw new HunkUserError(`"${name}" is not a managed install.`, [
      "Run `hunk extension list` to see managed installs.",
    ]);
  }

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
