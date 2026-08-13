import { resolveConfiguredCliInput, type HunkConfigResolution } from "../core/config";
import { findProjectRootCandidate } from "../core/projectRoot";
import type { CliInput } from "../core/types";
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

  let extensions: ExtensionLoadResult | undefined;
  try {
    extensions = await loadStartupExtensionsImpl({
      extensions: configured.extensions,
      cwd: options.cwd,
      env: options.env,
      cliExtensionPaths: configured.input.options.extensionPaths,
      projectRoot: configured.projectRoot,
      reservedExtensionIds: options.baseVcsCatalog.reservedIds,
      notifications: options.notifications,
      deferEventBusBinding: true,
    });

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
      extensions = await loadStartupExtensionsImpl({
        extensions: configured.extensions,
        cwd: options.cwd,
        env: options.env,
        cliExtensionPaths: configured.input.options.extensionPaths,
        projectRoot: configured.projectRoot,
        reservedExtensionIds: options.baseVcsCatalog.reservedIds,
        notifications: extensions.notifications,
        previousLoad: extensions,
      });
    } else {
      bindExtensionEventBus(extensions);
    }

    return { configured, extensions };
  } catch (error) {
    await retireExtensionLoadResult(extensions);
    throw error;
  }
}
