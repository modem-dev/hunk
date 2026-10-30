import { HunkUserError } from "../../core/run/errors";
import { resolveInstalledExtensionsRoot } from "../../core/run/paths";
import type { ExtensionManageCommandInput } from "../../core/run/commandInputs";
import {
  installExtension,
  listExtensions,
  removeExtension,
  updateExtension,
  type ExtensionManageContext,
} from "./install";
import { parseExtensionInstallSource } from "./source";

/**
 * The I/O one `hunk extension` command runs against.
 *
 * Everything the runner touches outside the managed install root arrives
 * through this seam, so tests can drive install confirmations and read output
 * without owning a terminal.
 */
export interface ExtensionManageIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Ask one yes/no question on a real terminal; absent when there is none. */
  confirm?: (question: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}

/** Shorten one commit sha for display. */
function shortCommit(commit: string) {
  return commit.slice(0, 7);
}

/** Display a Git commit or npm version without shortening package versions. */
function formatRevision(revision: string, commit?: string) {
  return commit ? shortCommit(commit) : `v${revision}`;
}

/** Phrase one recorded source with its pinned ref, when it has one. */
function describeSource(source: string, ref: string | undefined) {
  return ref !== undefined ? `${source} @ ${ref}` : source;
}

/** Resolve the managed install root or explain why there is none. */
function requireInstalledRoot(env: NodeJS.ProcessEnv) {
  const installedRoot = resolveInstalledExtensionsRoot(env);
  if (!installedRoot) {
    throw new HunkUserError(
      "Could not resolve the extension install directory because HOME/XDG_CONFIG_HOME is unset.",
    );
  }

  return installedRoot;
}

/**
 * Run one `hunk extension` command and return its exit code.
 *
 * Install is the only interactive step: extensions execute with the user's
 * full permissions, so a fresh install requires either a terminal confirmation
 * or an explicit `--yes`. Everything else operates on what is already
 * recorded and just prints what it did.
 */
export async function runExtensionManageCommand(
  input: ExtensionManageCommandInput,
  io: ExtensionManageIo,
): Promise<number> {
  const env = io.env ?? process.env;
  const context: ExtensionManageContext = {
    installedRoot: requireInstalledRoot(env),
    log: (line) => io.stderr(`${line}\n`),
    env,
    cwd: process.cwd(),
  };

  if (input.action === "install") {
    const source = parseExtensionInstallSource(input.source);
    const description =
      source.kind === "npm" ? source.spec : describeSource(source.cloneUrl, source.ref);

    if (!input.yes) {
      if (!io.confirm) {
        throw new HunkUserError(
          "Installing an extension needs a confirmation, and there is no terminal to ask on.",
          [`Re-run with --yes after reviewing ${description}.`],
        );
      }

      io.stdout(
        `Install ${description}?\n` +
          "Extensions run with your full user permissions. Only install sources you trust.\n" +
          (source.kind === "npm"
            ? "npm lifecycle scripts will not run during installation.\n"
            : ""),
      );
      if (!(await io.confirm("Proceed? [y/N] "))) {
        io.stdout("Install cancelled.\n");
        return 1;
      }
    }

    const outcome = installExtension(context, source);
    io.stdout(
      `Installed ${outcome.displayName}${outcome.version ? ` v${outcome.version}` : ""} ${outcome.commit ? `at ${shortCommit(outcome.commit)} ` : ""}into ${outcome.directory}.\n`,
    );
    if (outcome.dependencyWarning) {
      io.stderr(`warning: ${outcome.dependencyWarning}\n`);
    }
    io.stdout("New Hunk sessions will load it automatically.\n");
    return 0;
  }

  if (input.action === "list") {
    const entries = listExtensions(context);
    if (entries.length === 0) {
      io.stdout(
        "No managed extension installs.\nInstall one with `hunk extension install <source>`. Sources include owner/repo and npm:<package>.\n",
      );
      return 0;
    }

    for (const entry of entries) {
      const version = entry.version
        ? `v${entry.version}`
        : entry.record.kind === "npm"
          ? `v${entry.record.version}`
          : shortCommit(entry.record.commit);
      const name = entry.record.kind === "npm" ? `npm:${entry.record.packageName}` : entry.name;
      const source =
        entry.record.kind === "npm"
          ? entry.record.source
          : describeSource(entry.record.cloneUrl, entry.record.ref);
      const missing = entry.present ? "" : " (missing on disk — reinstall or remove)";
      // The clone URL plus ref, not the raw spec: a spec like `acme/x@v1`
      // already embeds the ref, and printing both would repeat it.
      io.stdout(`${name}  ${version}  ${source}${missing}\n`);
    }
    return 0;
  }

  if (input.action === "update") {
    const names =
      input.name !== undefined ? [input.name] : listExtensions(context).map((entry) => entry.name);
    if (names.length === 0) {
      io.stdout("No managed extension installs to update.\n");
      return 0;
    }

    for (const name of names) {
      const outcome = updateExtension(context, name);
      io.stdout(
        outcome.changed
          ? `Updated ${outcome.displayName}${outcome.version ? ` to v${outcome.version}` : ""}: ${formatRevision(outcome.previousRevision, outcome.previousCommit)} -> ${formatRevision(outcome.revision, outcome.commit)}.\n`
          : `${outcome.displayName} is already up to date (${formatRevision(outcome.revision, outcome.commit)}).\n`,
      );
      if (outcome.dependencyWarning) {
        io.stderr(`warning: ${outcome.dependencyWarning}\n`);
      }
    }
    return 0;
  }

  removeExtension(context, input.name);
  io.stdout(`Removed ${input.name}.\n`);
  return 0;
}
