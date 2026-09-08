import {
  resolveExtensionBootstrapConfig,
  type ExtensionBootstrapConfigResolution,
} from "../core/run/config";
import { findProjectRootCandidate } from "../core/process/projectRoot";
import type { ExtensionCliInvocationInput } from "../core/run/commandInputs";
import { extendVcsCatalog } from "../core/vcs";
import type { VcsCatalog } from "../core/vcs/types";
import { resolveExtensionVcsAdapters } from "../extensions/apply";
import {
  createExtensionCliCollisionIssues,
  resolveExtensionCliCommands,
  type ResolvedExtensionCliCommands,
} from "../extensions/cliCommands";
import { retireExtensionLoadResult } from "../extensions/events";
import { loadStartupExtensions } from "../extensions/startup";
import type { ExtensionLoadResult } from "../extensions/types";

export interface ResolveExtensionCliBootstrapOptions {
  input: ExtensionCliInvocationInput;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  baseVcsCatalog: VcsCatalog;
}

export interface ResolveExtensionCliBootstrapDeps {
  resolveExtensionBootstrapConfigImpl?: typeof resolveExtensionBootstrapConfig;
  loadStartupExtensionsImpl?: typeof loadStartupExtensions;
  findProjectRootCandidateImpl?: typeof findProjectRootCandidate;
}

export interface ResolvedExtensionCliBootstrap {
  configured: ExtensionBootstrapConfigResolution;
  extensions: ExtensionLoadResult;
  commands: ResolvedExtensionCliCommands;
  collisionIssues: readonly import("../extensions/types").ExtensionLoadIssue[];
  discoveryCatalog: VcsCatalog;
}

/** Load the extensions needed to resolve one unknown top-level CLI command. */
export async function resolveExtensionCliBootstrap(
  options: ResolveExtensionCliBootstrapOptions,
  deps: ResolveExtensionCliBootstrapDeps = {},
): Promise<ResolvedExtensionCliBootstrap> {
  const resolveConfig = deps.resolveExtensionBootstrapConfigImpl ?? resolveExtensionBootstrapConfig;
  const loadExtensions = deps.loadStartupExtensionsImpl ?? loadStartupExtensions;
  const findRoot = deps.findProjectRootCandidateImpl ?? findProjectRootCandidate;
  let configured = resolveConfig({
    cwd: options.cwd,
    env: options.env,
    vcsCatalog: options.baseVcsCatalog,
    extensionsEnabled: options.input.extensionsEnabled,
  });
  let extensions: ExtensionLoadResult | undefined;
  let provisional: ExtensionLoadResult | undefined;

  try {
    extensions = await loadExtensions({
      extensions: configured.extensions,
      cwd: options.cwd,
      env: options.env,
      cliExtensionPaths: options.input.extensionPaths,
      projectRoot: configured.projectRoot,
      reservedExtensionIds: options.baseVcsCatalog.reservedIds,
      deferEventBusBinding: true,
      onProvisionalLoad: (result) => {
        provisional = result;
      },
    });

    const adapters = resolveExtensionVcsAdapters(
      extensions.registry,
      options.baseVcsCatalog,
    ).adapters;
    const discoveryCatalog = extendVcsCatalog(options.baseVcsCatalog, adapters);
    const extensionProjectRoot = findRoot(options.cwd, discoveryCatalog);

    if (adapters.length > 0 && extensionProjectRoot !== configured.projectRoot) {
      configured = resolveConfig({
        cwd: options.cwd,
        env: options.env,
        vcsCatalog: discoveryCatalog,
        extensionsEnabled: options.input.extensionsEnabled,
      });
      extensions = await loadExtensions({
        extensions: configured.extensions,
        cwd: options.cwd,
        env: options.env,
        cliExtensionPaths: options.input.extensionPaths,
        projectRoot: configured.projectRoot,
        reservedExtensionIds: options.baseVcsCatalog.reservedIds,
        notifications: extensions.notifications,
        previousLoad: extensions,
        deferEventBusBinding: true,
        onProvisionalLoad: (result) => {
          provisional = result;
        },
      });
    }

    const commands = resolveExtensionCliCommands(extensions.registry);
    const collisionIssues = createExtensionCliCollisionIssues(
      extensions.registry,
      commands.collisions,
    );
    return { configured, extensions, commands, collisionIssues, discoveryCatalog };
  } catch (error) {
    await retireExtensionLoadResult(provisional);
    if (extensions?.registry !== provisional?.registry) {
      await retireExtensionLoadResult(extensions);
    }
    throw error;
  }
}
