import { createGitHubPrExtension } from "@hunk/gh";
import type { ExtensionFactory } from "../../../extension-api/types";
import { HUNK_VENDOR_EXTENSION_ID } from "../../extensionIds";
import { createExtensionNotificationHub, type ExtensionNotificationHub } from "../../notifications";
import { runExtensionFactory } from "../../runExtension";
import {
  createEmptyExtensionLoadResult,
  type ExtensionLoadResult,
  type ExtensionMetadata,
} from "../../types";

/** Static metadata used to select bundled behavior before its factory executes. */
export interface BundledCoreExtensionDefinition {
  selectionId: string;
  registrationId: string;
  sourcePath: string;
  factory: ExtensionFactory;
  commands: readonly string[];
}

/** Session-owned bundled extensions in registration order. */
export const BUNDLED_CORE_EXTENSION_DEFINITIONS: readonly BundledCoreExtensionDefinition[] = [
  {
    selectionId: "hunk.gh",
    registrationId: HUNK_VENDOR_EXTENSION_ID,
    sourcePath: "hunk:bundled/gh",
    factory: createGitHubPrExtension({ env: process.env }),
    commands: ["gh"],
  },
];

/** Find the bundled extension that statically owns one top-level CLI command. */
export function findBundledCoreExtensionByCommand(commandName: string) {
  return BUNDLED_CORE_EXTENSION_DEFINITIONS.find((definition) =>
    definition.commands.includes(commandName),
  );
}

/**
 * Loads enabled, non-rendering bundled extensions into one session-owned registry.
 *
 * Unlike the process-cached VCS and UI registries, these registrations share the current
 * extension-session lifetime because delegated CLI inputs may retain resources until shutdown.
 */
export function loadBundledCoreExtensions(
  cwd: string,
  notifications: ExtensionNotificationHub = createExtensionNotificationHub(),
  enabledSelectionIds: ReadonlySet<string> = new Set(
    BUNDLED_CORE_EXTENSION_DEFINITIONS.map((definition) => definition.selectionId),
  ),
): ExtensionLoadResult {
  const result = createEmptyExtensionLoadResult(cwd, notifications);

  for (const definition of BUNDLED_CORE_EXTENSION_DEFINITIONS) {
    if (!enabledSelectionIds.has(definition.selectionId)) continue;
    const metadata: ExtensionMetadata = {
      id: definition.registrationId,
      sourcePath: definition.sourcePath,
      origin: "bundled",
    };

    runExtensionFactory({
      metadata,
      registry: result.registry,
      issues: result.issues,
      factory: definition.factory,
    });
  }

  result.loaded = [...result.registry.extensions];
  return result;
}
