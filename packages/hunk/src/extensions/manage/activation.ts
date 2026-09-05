import { join } from "node:path";
import { readAppStateRecord, writeAppStateRecord } from "../../core/process/appStateFile";
import { resolveGlobalExtensionsDir } from "../../core/run/paths";
import { normalizeExtensionPackageId } from "../packageIdentity";

/** User-owned activation choices live separately from mutable install metadata. */
export type ExtensionPackageActivationMap = Record<string, boolean>;

const ACTIVATION_FILE_NAME = "activation.json";

/** Resolve the activation preference file without requiring the managed install directory. */
export function resolveExtensionActivationPath(env: NodeJS.ProcessEnv = process.env) {
  const root = resolveGlobalExtensionsDir(env);
  return root ? join(root, ACTIVATION_FILE_NAME) : undefined;
}

/** Read explicit package choices; absent and damaged files mean enabled-by-default. */
export function readExtensionPackageActivations(
  env: NodeJS.ProcessEnv = process.env,
): ExtensionPackageActivationMap {
  const path = resolveExtensionActivationPath(env);
  if (!path) return {};
  const stored = readAppStateRecord(path).packages;
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};

  return Object.fromEntries(
    Object.entries(stored as Record<string, unknown>).filter(
      (entry): entry is [string, boolean] =>
        normalizeExtensionPackageId(entry[0]) !== undefined && typeof entry[1] === "boolean",
    ),
  );
}

/** Replace package choices exactly; update rollback uses this to restore a snapshot. */
export function writeExtensionPackageActivations(
  packages: ExtensionPackageActivationMap,
  env: NodeJS.ProcessEnv = process.env,
) {
  const path = resolveExtensionActivationPath(env);
  if (!path) return false;
  const normalized = Object.fromEntries(
    Object.entries(packages).filter(
      ([id, enabled]) =>
        normalizeExtensionPackageId(id) !== undefined && typeof enabled === "boolean",
    ),
  );
  writeAppStateRecord(path, { packages: normalized });
  return true;
}

/** Persist package choices together while preserving preferences for other packages. */
export function setExtensionPackageActivations(
  updates: ExtensionPackageActivationMap,
  env: NodeJS.ProcessEnv = process.env,
) {
  return writeExtensionPackageActivations(
    { ...readExtensionPackageActivations(env), ...updates },
    env,
  );
}

/** Persist one package choice while preserving preferences for other packages. */
export function setExtensionPackageActivation(
  packageId: string,
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  const normalized = normalizeExtensionPackageId(packageId);
  if (!normalized) return false;
  return setExtensionPackageActivations({ [normalized]: enabled }, env);
}

/** Activation changes an update may apply without guessing about package ownership. */
export interface ExtensionActivationMigration {
  activations: ExtensionPackageActivationMap;
  changed: boolean;
}

/** Plan activation preservation without broadening an explicit package denial. */
export function planExtensionPackageActivationMigration(
  previousPackageIds: readonly string[],
  nextPackageIds: readonly string[],
  activations: ExtensionPackageActivationMap,
): ExtensionActivationMigration | undefined {
  const previous = [...new Set(previousPackageIds)];
  const next = [...new Set(nextPackageIds)];
  const nextSet = new Set(next);
  const previousSet = new Set(previous);
  const removed = previous.filter((id) => !nextSet.has(id));
  const added = next.filter((id) => !previousSet.has(id));
  const deniedPrevious = previous.filter((id) => activations[id] === false);
  const migrated = { ...activations };

  // With no denial to preserve, package topology may evolve normally. Explicit
  // enables and unchanged identities retain their independent stored choices.
  if (deniedPrevious.length === 0) {
    return { activations: migrated, changed: false };
  }

  // One removed identity becoming one new identity is the only unambiguous way
  // to carry a denial forward. Additions beside a denied package and wider
  // identity rewrites could silently introduce enabled code, so require the
  // user to resolve those changes explicitly before updating.
  if (removed.length === 1 && added.length === 1 && deniedPrevious[0] === removed[0]) {
    migrated[added[0]!] = false;
  } else if (added.length > 0) {
    return undefined;
  }

  return {
    activations: migrated,
    changed: JSON.stringify(migrated) !== JSON.stringify(activations),
  };
}

/** Return package ids explicitly disabled by the user. */
export function readDisabledExtensionPackageIds(env: NodeJS.ProcessEnv = process.env) {
  return new Set(
    Object.entries(readExtensionPackageActivations(env))
      .filter(([, enabled]) => !enabled)
      .map(([packageId]) => packageId),
  );
}
