import { HUNK_VENDOR_EXTENSION_ID } from "../../extensionIds";
import { runExtensionFactory } from "../../runExtension";
import {
  createEmptyExtensionRegistry,
  type ExtensionFactory,
  type ExtensionLoadIssue,
  type ExtensionRegistry,
} from "../../types";
import registerBundledReviewInfo, { registerBundledComparisonReviewInfo } from "./reviewInfo";
import registerBundledSearch from "./search";
import registerBundledSidebar from "./sidebar";

/** One bundled UI factory and the pane ids it must register, if any. */
interface BundledUIFactory {
  id: string;
  factory: ExtensionFactory;
  paneIds: readonly string[];
}

const factories: readonly BundledUIFactory[] = [
  { id: "files", factory: registerBundledSidebar, paneIds: ["files"] },
  { id: "review-info", factory: registerBundledReviewInfo, paneIds: ["review-info"] },
  {
    id: "comparison-review-info",
    factory: registerBundledComparisonReviewInfo,
    paneIds: ["comparison-review-info"],
  },
  { id: "search", factory: registerBundledSearch, paneIds: [] },
];
let cachedRegistry: ExtensionRegistry | undefined;

/**
 * Load bundled UI registrations through the public factory path, once per process.
 *
 * The registry is process-cached, so factories run once and without config; a bundled command
 * handler must derive session state from its context rather than close over a review.
 */
export function getBundledUIRegistry(): ExtensionRegistry {
  if (cachedRegistry) return cachedRegistry;
  const registry = createEmptyExtensionRegistry();
  const issues: ExtensionLoadIssue[] = [];
  for (const { id, factory } of factories) {
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
  const registeredPaneIds = new Set(registry.panes.map((entry) => entry.pane.id));
  const missingPane = factories
    .flatMap((entry) => entry.paneIds)
    .find((paneId) => !registeredPaneIds.has(paneId));
  if (issues.length > 0 || missingPane !== undefined) {
    throw new Error(
      `Bundled UI failed to register: ${issues[0]?.message ?? `missing pane "${missingPane}"`}`,
    );
  }
  cachedRegistry = registry;
  return registry;
}
