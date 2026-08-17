import { findProjectRootCandidate } from "../core/process/projectRoot";
import type { SessionSelectorInput } from "../core/run/commandInputs";
import type { VcsCatalog } from "../core/vcs/types";

/** Attach the nearest known project boundary to one repo-path session selector. */
export function resolveSessionSelectorBoundary(
  selector: SessionSelectorInput,
  catalog: Pick<VcsCatalog, "adapters">,
): SessionSelectorInput {
  if (!selector.repoRoot) {
    return selector;
  }

  const repoBoundary = findProjectRootCandidate(selector.repoRoot, catalog);
  return repoBoundary ? { ...selector, repoBoundary } : selector;
}
