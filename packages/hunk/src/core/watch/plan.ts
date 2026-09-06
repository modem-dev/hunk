import { posix, win32 } from "node:path";
import type {
  ExtensionVcsDirectoryEntriesWatchTarget,
  ExtensionVcsDirectoryTreeWatchTarget,
  ExtensionVcsWatchPlan,
  ExtensionVcsWatchTarget,
  ExtensionVcsWatchTargetSource,
} from "../../extension-api/types";
import { normalizePathForOS } from "../../lib/osPath";
import type { CliInput } from "../run/commandInputs";
import { createVcsWatchPlan, getConfiguredVcsAdapter, operationFromInput } from "../vcs";
import type { VcsCatalog } from "../vcs/types";

/**
 * Watch shapes are declared once in the published extension contract and
 * re-exported here under Hunk's internal names, so an adapter's `watchPlan`
 * returns the same structure core planning consumes with no conversion.
 */
export type WatchTargetSource = ExtensionVcsWatchTargetSource;
export type DirectoryEntriesWatchTarget = ExtensionVcsDirectoryEntriesWatchTarget;
export type DirectoryTreeWatchTarget = ExtensionVcsDirectoryTreeWatchTarget;
export type WatchTarget = ExtensionVcsWatchTarget;
export type WatchPlan = ExtensionVcsWatchPlan;

export interface WatchPlanContext {
  cwd: string;
  platform?: NodeJS.Platform;
  /** Complete catalog retained from the review load. */
  vcsCatalog?: VcsCatalog;
}

interface FileTarget {
  path: string;
  source: WatchTargetSource;
}

const SOURCE_ORDER: WatchTargetSource[] = ["content", "sidecar", "worktree", "vcs-metadata"];

/** Resolve one source path with path semantics for the source platform. */
function resolveSourcePath(path: string, context: WatchPlanContext) {
  const platform = context.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const cwd = normalizePathForOS(context.cwd, platform);
  const inputPath = normalizePathForOS(path, platform);
  return pathApi.resolve(cwd, inputPath);
}

/** Normalize exact file targets into deterministic parent-directory groups. */
function groupFileTargets(fileTargets: FileTarget[], context: WatchPlanContext) {
  const platform = context.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const comparisonKey = (path: string) => (platform === "win32" ? path.toLowerCase() : path);
  const comparePaths = (left: string, right: string) => {
    const leftKey = comparisonKey(left);
    const rightKey = comparisonKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  };
  const groups = new Map<
    string,
    { directory: string; entries: Map<string, string>; sources: Set<WatchTargetSource> }
  >();

  for (const fileTarget of fileTargets) {
    const path = resolveSourcePath(fileTarget.path, context);
    const directory = pathApi.dirname(path);
    const directoryKey = comparisonKey(directory);
    let group = groups.get(directoryKey);

    if (!group) {
      group = { directory, entries: new Map(), sources: new Set() };
      groups.set(directoryKey, group);
    }

    const entryKey = comparisonKey(path);
    if (!group.entries.has(entryKey)) {
      group.entries.set(entryKey, path);
    }
    group.sources.add(fileTarget.source);
  }

  return [...groups.values()]
    .sort((left, right) => comparePaths(left.directory, right.directory))
    .map(
      (group): DirectoryEntriesWatchTarget => ({
        kind: "directory-entries",
        directory: group.directory,
        entries: [...group.entries.values()].sort(comparePaths),
        sources: SOURCE_ORDER.filter((source) => group.sources.has(source)),
      }),
    );
}

/** Build a backend-neutral plan for observing one reloadable review input. */
export function resolveWatchPlan(input: CliInput, context: WatchPlanContext): WatchPlan | null {
  if (input.options.agentContext === "-") {
    return null;
  }

  const fileTargets: FileTarget[] = [];
  let coverage: WatchPlan["coverage"] = "hybrid";
  let adapterTargets: WatchTarget[] = [];

  switch (input.kind) {
    case "diff":
    case "difftool":
      fileTargets.push(
        { path: input.left, source: "content" },
        { path: input.right, source: "content" },
      );
      break;
    case "patch":
      if (!input.file || input.file === "-") {
        return null;
      }
      fileTargets.push({ path: input.file, source: "content" });
      break;
    case "vcs":
    case "show":
    case "stash-show": {
      if (!context.vcsCatalog) {
        throw new Error("VCS-backed watch plans require a composed VCS catalog.");
      }
      const adapter = getConfiguredVcsAdapter(input.options.vcs, context.vcsCatalog);
      const adapterPlan = createVcsWatchPlan(
        adapter,
        operationFromInput(input),
        { cwd: context.cwd },
        context.vcsCatalog,
      );
      coverage = adapterPlan.coverage;
      adapterTargets = adapterPlan.targets;
      break;
    }
  }

  if (input.options.agentContext) {
    fileTargets.push({ path: input.options.agentContext, source: "sidecar" });
    coverage = "hybrid";
  }

  return {
    coverage,
    targets: [...adapterTargets, ...groupFileTargets(fileTargets, context)],
  };
}
