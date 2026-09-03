import gitExtension from "./git";
import jjExtension from "./jujutsu";
import slExtension from "./sapling";
import { runExtensionFactory } from "../../runExtension";
import {
  createEmptyExtensionRegistry,
  type ExtensionFactory,
  type ExtensionLoadIssue,
  type ExtensionMetadata,
  type ExtensionRegistry,
} from "../../types";

/**
 * The bundled extension tier.
 *
 * Every VCS backend Hunk ships — Git, Jujutsu, Sapling — is an extension,
 * registered through the same `registerVcsAdapter` a third-party author calls.
 * There are no core-registered adapters left, which is the point: a capability
 * Hunk ships on cannot quietly outgrow the API it publishes, and Git is the
 * backend that exercises every integration point there is.
 *
 * Three things separate this tier from user extensions:
 *
 * - The factories are **statically imported**, so they compile into the binary
 *   and load synchronously. Adapter resolution happens during config
 *   resolution, long before the async user-extension pass, and the session's
 *   backend has to be there for it.
 * - They are **implicitly trusted**: they are Hunk's own code, so there is no
 *   discovery, no trust prompt, and no `[extension.<id>]` config table.
 * - They stay loaded under `--no-extensions` and `[extensions] enabled =
 *   false`. Those switches exist to triage *user* extensions; losing VCS
 *   support from a debugging flag would break every workflow there is.
 *
 * Failure isolation still applies — a throwing factory becomes a load issue
 * rather than a crash — even though these factories are Hunk's own and that
 * path should be unreachable.
 *
 * File-language selectors live in `default/languages/` as plain registration
 * data that `applyExtensionFileLanguages` prepends; that path must stay free of
 * `runExtension` so startup does not pull the diff engine. The app composition
 * root reads `getBundledVcsAdapters` and builds the core catalog. A bundled
 * extension that registered a theme or a changeset transform would also have to
 * be threaded through `applyExtensionRegistrations`, which today only sees the
 * user-extension load result for those kinds.
 */

interface BundledExtensionDefinition {
  id: string;
  factory: ExtensionFactory;
}

/**
 * Every bundled extension, in load order.
 *
 * Load order only breaks ties: detection order comes from each adapter's
 * `detectionPriority`, assembled by the app-owned catalog.
 */
const BUNDLED_EXTENSIONS: readonly BundledExtensionDefinition[] = [
  { id: "jj", factory: jjExtension },
  { id: "sl", factory: slExtension },
  { id: "git", factory: gitExtension },
];

/** Everything the bundled tier contributed, plus any factory that failed. */
export interface BundledExtensionLoad {
  registry: ExtensionRegistry;
  issues: readonly ExtensionLoadIssue[];
}

let bundledLoad: BundledExtensionLoad | undefined;

/**
 * Build the bundled extension metadata for one definition.
 *
 * `sourcePath` names a module inside the binary rather than a file on disk, so
 * notices keyed by it stay stable and never point at a path a user could edit.
 */
function bundledMetadata(id: string): ExtensionMetadata {
  return { id, sourcePath: `hunk:bundled/${id}`, origin: "bundled" };
}

/**
 * Load every bundled extension once per process, synchronously.
 *
 * Memoized because adapter resolution asks for it from config resolution, the
 * static pager, watch planning, and the interactive app — all of which must see
 * the same adapter identities.
 */
export function loadBundledExtensions(): BundledExtensionLoad {
  if (bundledLoad) {
    return bundledLoad;
  }

  const registry = createEmptyExtensionRegistry();
  const issues: ExtensionLoadIssue[] = [];

  for (const { id, factory } of BUNDLED_EXTENSIONS) {
    // Bundled factories are synchronous by construction, so `runExtensionFactory`
    // has fully applied (or rolled back) each one before it returns.
    runExtensionFactory({ metadata: bundledMetadata(id), registry, issues, factory });
  }

  bundledLoad = { registry, issues };
  return bundledLoad;
}

/** Return the VCS backends the bundled tier registered, in registration order. */
export function getBundledVcsAdapters() {
  return loadBundledExtensions().registry.vcsAdapters.map((entry) => entry.adapter);
}
