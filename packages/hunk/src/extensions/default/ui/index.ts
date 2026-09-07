import { HUNK_VENDOR_EXTENSION_ID } from "../../extensionIds";
import { runExtensionFactory } from "../../runExtension";
import {
  createEmptyExtensionRegistry,
  type ExtensionFactory,
  type ExtensionLoadIssue,
  type ExtensionRegistry,
} from "../../types";
import registerBundledReviewInfo from "./reviewInfo";
import registerBundledSidebar from "./sidebar";

const factories: readonly [string, ExtensionFactory][] = [
  ["files", registerBundledSidebar],
  ["review-info", registerBundledReviewInfo],
];
let cachedRegistry: ExtensionRegistry | undefined;

/** Load bundled UI registrations through the public factory path, once per process. */
export function getBundledUIRegistry(): ExtensionRegistry {
  if (cachedRegistry) return cachedRegistry;
  const registry = createEmptyExtensionRegistry();
  const issues: ExtensionLoadIssue[] = [];
  for (const [id, factory] of factories) {
    runExtensionFactory({
      metadata: {
        id: HUNK_VENDOR_EXTENSION_ID,
        sourcePath: `hunk:bundled/ui/${id}`,
        origin: "bundled",
      },
      registry,
      issues,
      factory,
    });
  }
  if (issues.length > 0 || registry.panes.length !== factories.length) {
    throw new Error(`Bundled UI failed to register: ${issues[0]?.message ?? "missing pane"}`);
  }
  cachedRegistry = registry;
  return registry;
}
