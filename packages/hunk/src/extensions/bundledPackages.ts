import { bundledExtensionPackage as gitPackage } from "@hunk/git";
import { bundledExtensionPackage as jjPackage } from "@hunk/jj";
import { bundledExtensionPackage as saplingPackage } from "@hunk/sapling";
import { runExtensionFactory } from "./runExtension";
import {
  createEmptyExtensionRegistry,
  type ExtensionFactory,
  type ExtensionLoadIssue,
  type ExtensionMetadata,
  type ExtensionRegistry,
} from "./types";

/** Describes one statically linked package and all extension entries it activates. */
type BundledExtensionFactory = (hunk: Parameters<ExtensionFactory>[0]) => void;

export interface BundledExtensionPackage {
  packageId: string;
  packageName: string;
  packageVersion: string;
  /** VCS namespaces this package owns even when activation fails. */
  reservedVcsIds: readonly string[];
  entries: readonly { id: string; factory: BundledExtensionFactory }[];
}

/** Packages activate in provider precedence order; Git remains the mandatory final fallback. */
const BUNDLED_PACKAGES: readonly BundledExtensionPackage[] = [
  jjPackage,
  saplingPackage,
  gitPackage,
];

/** Everything the bundled package tier contributed, plus isolated factory failures. */
export interface BundledExtensionLoad {
  registry: ExtensionRegistry;
  issues: readonly ExtensionLoadIssue[];
}

let bundledLoad: BundledExtensionLoad | undefined;

/** Build stable metadata for one package entry without exposing a filesystem path. */
function bundledMetadata(extensionPackage: BundledExtensionPackage, id: string): ExtensionMetadata {
  return {
    id,
    sourcePath: `package:${extensionPackage.packageName}`,
    origin: "bundled",
    package: {
      id: extensionPackage.packageId,
      name: extensionPackage.packageName,
      version: extensionPackage.packageVersion,
    },
  };
}

/** Activate a package set through the existing factory runner, isolating each entry failure. */
export function loadBundledExtensionPackages(
  packages: readonly BundledExtensionPackage[],
): BundledExtensionLoad {
  const registry = createEmptyExtensionRegistry();
  const issues: ExtensionLoadIssue[] = [];
  for (const extensionPackage of packages) {
    for (const entry of extensionPackage.entries) {
      runExtensionFactory({
        metadata: bundledMetadata(extensionPackage, entry.id),
        registry,
        issues,
        factory: entry.factory,
        synchronous: true,
      });
    }
  }

  return { registry, issues };
}

/** Activate all statically bundled packages once through the existing factory runner. */
export function loadBundledExtensions(): BundledExtensionLoad {
  bundledLoad ??= loadBundledExtensionPackages(BUNDLED_PACKAGES);
  return bundledLoad;
}

/** Return VCS ids reserved by descriptors independently of factory success. */
export function reservedVcsIdsForBundledPackages(packages: readonly BundledExtensionPackage[]) {
  return packages.flatMap((extensionPackage) => extensionPackage.reservedVcsIds);
}

/** Return every statically bundled VCS id. */
export function getBundledReservedVcsIds() {
  return reservedVcsIdsForBundledPackages(BUNDLED_PACKAGES);
}

/** Return bundled VCS adapters in package and entry activation order. */
export function getBundledVcsAdapters() {
  return loadBundledExtensions().registry.vcsAdapters.map((entry) => entry.adapter);
}
