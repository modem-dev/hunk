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
import { sanitizeExtensionPackageDisplay } from "../packageIdentity";
import { readExtensionPackageActivations, setExtensionPackageActivation } from "./activation";

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
  return sanitizeExtensionPackageDisplay(commit).slice(0, 7);
}

/** Phrase one recorded source with its pinned ref, when it has one. */
function describeSource(source: string, ref: string | undefined) {
  const safeSource = sanitizeExtensionPackageDisplay(source);
  return ref !== undefined ? `${safeSource} @ ${sanitizeExtensionPackageDisplay(ref)}` : safeSource;
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

/** Resolve an activation selector without guessing between install and package identities. */
function resolveActivationPackageIds(entries: ReturnType<typeof listExtensions>, selector: string) {
  const install = entries.find((entry) => entry.name === selector);
  const packageMatches = entries.flatMap((entry) =>
    entry.packages.filter((extensionPackage) => extensionPackage.id === selector).map(() => entry),
  );

  if (packageMatches.length > 1) {
    throw new HunkUserError(`Package id "${selector}" is exposed more than once.`, [
      `Remove or rename the duplicate packages before changing activation: ${[
        ...new Set(packageMatches.map((entry) => entry.name)),
      ].join(", ")}.`,
    ]);
  }

  if (install && packageMatches.length === 1) {
    const installPackageIds = [...new Set(install.packages.map((entry) => entry.id))];
    const sameSingleTarget =
      packageMatches[0] === install &&
      installPackageIds.length === 1 &&
      installPackageIds[0] === selector;
    if (!sameSingleTarget) {
      throw new HunkUserError(
        `"${selector}" matches both a managed install name and a package id.`,
        ["Rename one identity before changing activation so Hunk does not disable the wrong code."],
      );
    }
  }

  if (install) {
    return [...new Set(install.packages.map((entry) => entry.id))];
  }
  if (packageMatches.length === 1) {
    return [selector];
  }
  return [];
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
    env,
    log: (line) => io.stderr(`${line}\n`),
  };

  if (input.action === "install") {
    const source = parseExtensionInstallSource(input.source);

    if (!input.yes) {
      if (!io.confirm) {
        throw new HunkUserError(
          "Installing an extension needs a confirmation, and there is no terminal to ask on.",
          [`Re-run with --yes after reviewing ${source.cloneUrl}.`],
        );
      }

      io.stdout(
        `Install ${describeSource(source.cloneUrl, source.ref)}?\n` +
          "Extensions run with your full user permissions. Only install repositories you trust.\n",
      );
      if (!(await io.confirm("Proceed? [y/N] "))) {
        io.stdout("Install cancelled.\n");
        return 1;
      }
    }

    const outcome = installExtension(context, source);
    io.stdout(
      `Installed ${sanitizeExtensionPackageDisplay(outcome.name)}${outcome.version ? ` v${sanitizeExtensionPackageDisplay(outcome.version)}` : ""} at ${shortCommit(outcome.commit)} into ${outcome.directory}.\n`,
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
        "No managed extension installs.\nInstall one with `hunk extension install <owner>/<repo>`.\n",
      );
      return 0;
    }

    const activations = readExtensionPackageActivations(env);
    for (const entry of entries) {
      const version = entry.version
        ? `v${sanitizeExtensionPackageDisplay(entry.version)}`
        : shortCommit(entry.record.commit);
      const missing = entry.present ? "" : " (missing on disk — reinstall or remove)";
      // One managed repository may expose several packages, and each package may
      // activate several entries. Keep all three identities visible in one row.
      const packageSummary = entry.packages
        .map((extensionPackage) => {
          const state = activations[extensionPackage.id] === false ? "disabled" : "enabled";
          const entries = extensionPackage.entries.length
            ? ` [${extensionPackage.entries.map(sanitizeExtensionPackageDisplay).join(", ")}]`
            : "";
          return `${sanitizeExtensionPackageDisplay(extensionPackage.id)} (${state})${entries}`;
        })
        .join(", ");
      io.stdout(
        `${sanitizeExtensionPackageDisplay(entry.name)}  ${version}  ${packageSummary}  ${describeSource(entry.record.cloneUrl, entry.record.ref)}${missing}\n`,
      );
    }
    return 0;
  }

  if (input.action === "enable" || input.action === "disable") {
    const entries = listExtensions(context);
    const packageIds = resolveActivationPackageIds(entries, input.name);
    if (packageIds.length === 0) {
      throw new HunkUserError(`"${input.name}" is not a managed extension package.`, [
        "Run `hunk extension list` to see managed package identities.",
      ]);
    }
    const enabled = input.action === "enable";
    for (const packageId of new Set(packageIds)) {
      if (!setExtensionPackageActivation(packageId, enabled, env)) {
        throw new HunkUserError("Could not resolve the extension activation file.");
      }
      io.stdout(
        `${enabled ? "Enabled" : "Disabled"} ${sanitizeExtensionPackageDisplay(packageId)}.\n`,
      );
    }
    io.stdout("The change applies to new and reloaded Hunk sessions.\n");
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
          ? `Updated ${sanitizeExtensionPackageDisplay(outcome.name)}${outcome.version ? ` to v${sanitizeExtensionPackageDisplay(outcome.version)}` : ""}: ${shortCommit(outcome.previousCommit)} -> ${shortCommit(outcome.commit)}.\n`
          : `${sanitizeExtensionPackageDisplay(outcome.name)} is already up to date (${shortCommit(outcome.commit)}).\n`,
      );
      if (outcome.dependencyWarning) {
        io.stderr(`warning: ${outcome.dependencyWarning}\n`);
      }
    }
    return 0;
  }

  removeExtension(context, input.name);
  io.stdout(`Removed ${sanitizeExtensionPackageDisplay(input.name)}.\n`);
  return 0;
}
