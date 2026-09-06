import { resolveConfiguredCliInput, type HunkConfigResolution } from "../core/run/config";
import { findProjectRootCandidate } from "../core/process/projectRoot";
import type { CliInput } from "../core/run/commandInputs";
import { extendVcsCatalog } from "../core/vcs";
import type { VcsCatalog } from "../core/vcs/types";
import { resolveExtensionVcsAdapters } from "../extensions/apply";
import { bindExtensionEventBus, retireExtensionLoadResult } from "../extensions/events";
import { loadStartupExtensions } from "../extensions/startup";
import type { ExtensionNotificationHub } from "../extensions/notifications";
import type { ExtensionLoadResult } from "../extensions/types";

export interface ResolveConfiguredExtensionsOptions {
  runtimeInput: CliInput;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  baseVcsCatalog: VcsCatalog;
  /** Initial resolution already needed by a caller before extension loading begins. */
  configured?: HunkConfigResolution;
  /** Adapters already known before this load, such as the current live-session catalog. */
  discoveryCatalog?: VcsCatalog;
  notifications?: ExtensionNotificationHub;
  /** Registry already loaded by an extension CLI command before built-in delegation. */
  previousLoad?: ExtensionLoadResult;
  /** Session-owned registry borrowed by an embedded surface without lifecycle authority. */
  borrowedLoad?: ExtensionLoadResult;
  /** Publish provisional ownership before imports or asynchronous factories can suspend. */
  onProvisionalLoad?: (result: ExtensionLoadResult) => void;
  /** Throw when the caller's lifetime ended so no later staged registry can be created. */
  assertActive?: () => void;
}

export interface ResolveConfiguredExtensionsDeps {
  resolveConfiguredCliInputImpl?: typeof resolveConfiguredCliInput;
  loadStartupExtensionsImpl?: typeof loadStartupExtensions;
  findProjectRootCandidateImpl?: typeof findProjectRootCandidate;
}

export interface ResolvedConfiguredExtensions {
  configured: HunkConfigResolution;
  extensions: ExtensionLoadResult;
}

/**
 * Resolve configuration and user extensions, repeating root discovery once when
 * a newly loaded adapter recognizes a repository the starting catalog could not.
 */
export async function resolveConfiguredExtensions(
  options: ResolveConfiguredExtensionsOptions,
  deps: ResolveConfiguredExtensionsDeps = {},
): Promise<ResolvedConfiguredExtensions> {
  const resolveConfiguredCliInputImpl =
    deps.resolveConfiguredCliInputImpl ?? resolveConfiguredCliInput;
  const loadStartupExtensionsImpl = deps.loadStartupExtensionsImpl ?? loadStartupExtensions;
  const findProjectRootCandidateImpl =
    deps.findProjectRootCandidateImpl ?? findProjectRootCandidate;
  let configured =
    options.configured ??
    resolveConfiguredCliInputImpl(options.runtimeInput, {
      cwd: options.cwd,
      env: options.env,
      vcsCatalog: options.discoveryCatalog ?? options.baseVcsCatalog,
    });

  if (options.borrowedLoad) {
    const adapters = resolveExtensionVcsAdapters(
      options.borrowedLoad.registry,
      options.baseVcsCatalog,
    ).adapters;
    const catalog = extendVcsCatalog(options.baseVcsCatalog, adapters);
    const projectRoot = findProjectRootCandidateImpl(options.cwd, catalog);
    if (projectRoot !== configured.projectRoot) {
      configured = resolveConfiguredCliInputImpl(options.runtimeInput, {
        cwd: options.cwd,
        env: options.env,
        vcsCatalog: catalog,
      });
    }
    options.assertActive?.();
    return { configured, extensions: options.borrowedLoad };
  }

  let extensions: ExtensionLoadResult | undefined;
  let provisionalExtensions: ExtensionLoadResult | undefined;
  /** Retain loader ownership locally before forwarding it to a caller that may also suspend. */
  const ownProvisionalLoad = (result: ExtensionLoadResult) => {
    provisionalExtensions = result;
    options.onProvisionalLoad?.(result);
  };
  try {
    options.assertActive?.();
    extensions = await loadStartupExtensionsImpl({
      extensions: configured.extensions,
      cwd: options.cwd,
      env: options.env,
      cliExtensionPaths: configured.input.options.extensionPaths,
      projectRoot: configured.projectRoot,
      reservedExtensionIds: options.baseVcsCatalog.reservedIds,
      notifications: options.notifications ?? options.previousLoad?.notifications,
      previousLoad: options.previousLoad,
      deferEventBusBinding: true,
      onProvisionalLoad: ownProvisionalLoad,
    });

    options.assertActive?.();
    const provisionalAdapters = resolveExtensionVcsAdapters(
      extensions.registry,
      options.baseVcsCatalog,
    ).adapters;
    const provisionalCatalog = extendVcsCatalog(options.baseVcsCatalog, provisionalAdapters);
    const extensionProjectRoot = findProjectRootCandidateImpl(options.cwd, provisionalCatalog);

    if (provisionalAdapters.length > 0 && extensionProjectRoot !== configured.projectRoot) {
      configured = resolveConfiguredCliInputImpl(options.runtimeInput, {
        cwd: options.cwd,
        env: options.env,
        vcsCatalog: provisionalCatalog,
      });
      options.assertActive?.();
      extensions = await loadStartupExtensionsImpl({
        extensions: configured.extensions,
        cwd: options.cwd,
        env: options.env,
        cliExtensionPaths: configured.input.options.extensionPaths,
        projectRoot: configured.projectRoot,
        reservedExtensionIds: options.baseVcsCatalog.reservedIds,
        notifications: extensions.notifications,
        previousLoad: extensions,
        onProvisionalLoad: ownProvisionalLoad,
      });
    } else {
      bindExtensionEventBus(extensions);
    }

    options.assertActive?.();
    return { configured, extensions };
  } catch (error) {
    // A staged loader can reject after publishing a new registry but before
    // assigning its result. Retire the latest provisional wrapper first, then
    // any distinct earlier pass; registry-global retirement deduplicates aliases.
    await retireExtensionLoadResult(provisionalExtensions);
    if (extensions?.registry !== provisionalExtensions?.registry) {
      await retireExtensionLoadResult(extensions);
    }
    if (
      options.previousLoad?.registry !== provisionalExtensions?.registry &&
      options.previousLoad?.registry !== extensions?.registry
    ) {
      await retireExtensionLoadResult(options.previousLoad);
    }
    throw error;
  }
}
