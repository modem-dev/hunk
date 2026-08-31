import { join } from "node:path";
import type {
  ExtensionVcsFileSourcePathResolver,
  ExtensionVcsFileSourceRequest,
} from "hunkdiff/extension";

/** Resolve only a present new side to its path in a provider's live working tree. */
export function createWorkingTreeSourcePathResolver(
  repoRoot: string,
): ExtensionVcsFileSourcePathResolver {
  return (request: ExtensionVcsFileSourceRequest) =>
    request.side === "new" && request.changeType !== "deleted"
      ? join(repoRoot, request.path)
      : null;
}
