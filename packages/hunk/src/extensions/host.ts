import { pathToFileURL } from "node:url";
import { findProjectRootCandidate } from "../core/process/projectRoot";
import { EXTENSION_ID_RULE, HUNK_VENDOR_EXTENSION_ID, isValidExtensionId } from "./extensionIds";
import { bindExtensionEventBus } from "./events";
import { registerHostRuntimeModules } from "./hostRuntimeModules";
import { createExtensionNotificationHub, type ExtensionNotificationHub } from "./notifications";
import { describeError, readExtensionFactory, runExtensionFactory } from "./runExtension";
import { resolveRepoTrust, type ExtensionTrustOptions, type ExtensionTrustState } from "./trust";
import {
  createEmptyExtensionRegistry,
  createExtensionContext,
  HUNK_EXTENSION_API_VERSION,
  type ExtensionCandidate,
  type ExtensionFactory,
  type ExtensionLoadIssue,
  type ExtensionLoadResult,
  type ExtensionMetadata,
  type ExtensionRegistry,
} from "./types";

export interface LoadExtensionsOptions {
  candidates: readonly ExtensionCandidate[];
  /** Full candidate order represented after this pass; defaults to `candidates`. */
  allCandidates?: readonly ExtensionCandidate[];
  /** Existing pass to extend when `candidates` contains only a newly discovered suffix. */
  previousLoad?: ExtensionLoadResult;
  cwd: string;
  /** Per-extension `[extension.<id>]` config tables, keyed by extension id. */
  extensionConfigs?: Record<string, Record<string, unknown>>;
  /**
   * Sink `ctx.notify` writes into. Defaults to a fresh hub; pass the existing
   * one when reloading extensions mid-session so the UI keeps receiving them.
   */
  notifications?: ExtensionNotificationHub;
  /** Repo root repo-local candidates belong to; discovered from `cwd` when omitted. */
  repoRoot?: string;
  /** Keep factory bus events queued until a staged caller finishes appending candidates. */
  deferEventBusBinding?: boolean;
  /** Product-owned ids user extension modules may not claim. */
  reservedExtensionIds?: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
  /** Trust lookup seam so tests can drive gating without touching the state file. */
  resolveRepoTrustImpl?: (repoRoot: string, options: ExtensionTrustOptions) => ExtensionTrustState;
  /** Module loader seam; defaults to a plain dynamic import of the absolute path. */
  importExtensionModuleImpl?: (path: string) => Promise<unknown>;
  /** Publish provisional ownership before imports or asynchronous factories can suspend. */
  onProvisionalLoad?: (result: ExtensionLoadResult) => void;
}

/** Read durable retirement without letting control-flow narrowing hide asynchronous revocation. */
function registryRetired(registry: ExtensionRegistry) {
  return registry.eventBusPhase === "closed";
}

/** Import one extension entry file by absolute path, cross-platform. */
async function importExtensionModule(path: string): Promise<unknown> {
  // File URLs are required on Windows, where a drive-letter path is not a valid specifier.
  return await import(pathToFileURL(path).href);
}

/** Report whether an id belongs to Hunk rather than to a user extension. */
function isReservedExtensionId(id: string, reservedIds: ReadonlySet<string>) {
  return id === HUNK_VENDOR_EXTENSION_ID || reservedIds.has(id);
}

/**
 * State why one candidate's id disqualifies it, or nothing when it is usable.
 *
 * Ids come from file stems, folder names, and manifests, and they decide which
 * commands, sidebar views, and config table an extension owns. A stem that is
 * reserved, unparseable, or already taken would silently take over another
 * extension's namespace, so it is refused here with the rule it broke.
 */
function describeIdRefusal(
  candidate: ExtensionCandidate,
  claimedBy: ReadonlyMap<string, string>,
  reservedIds: ReadonlySet<string>,
): string | undefined {
  if (isReservedExtensionId(candidate.id, reservedIds)) {
    return `"${candidate.id}" is reserved by Hunk and cannot be an extension id • rename ${candidate.path}`;
  }

  if (!isValidExtensionId(candidate.id)) {
    return `"${candidate.id}" is not a usable extension id • ${EXTENSION_ID_RULE} • rename ${candidate.path}`;
  }

  const owner = claimedBy.get(candidate.id);
  return owner === undefined
    ? undefined
    : `another extension already loaded as "${candidate.id}" (${owner}) • rename ${candidate.path}`;
}

/** One candidate set split into what may load and the ids that were refused. */
interface AcceptedCandidates {
  accepted: ExtensionCandidate[];
  issues: ExtensionLoadIssue[];
}

/**
 * State why one candidate's manifest is incompatible, or nothing when it loads.
 *
 * A manifest that requires a newer extension API than this Hunk provides would
 * fail somewhere inside its factory with whatever error the missing surface
 * happens to produce; refusing it here turns that into one actionable message.
 */
function describeApiVersionRefusal(candidate: ExtensionCandidate): string | undefined {
  if (
    candidate.requiresApiVersion === undefined ||
    candidate.requiresApiVersion <= HUNK_EXTENSION_API_VERSION
  ) {
    return undefined;
  }

  return `requires Hunk extension API v${candidate.requiresApiVersion}, but this Hunk provides v${HUNK_EXTENSION_API_VERSION} • upgrade Hunk to load ${candidate.path}`;
}

/**
 * Gate every candidate before anything is imported.
 *
 * This is the one enforcement point: discovery stays a pure filesystem walk
 * with no issue channel, and every way an id can be produced — file stem,
 * folder name, single- or multi-entry manifest, explicit `--extension` path —
 * arrives here as `candidate.id`, so one gate covers all of them. Duplicates
 * across discovery sources resolve first-wins, the same tiebreak the registry
 * uses everywhere else, with the loser reported rather than silently sharing
 * the winner's config table, command ids, and view keys. Manifest API-version
 * requirements gate here too; a refused candidate does not claim its id, so a
 * compatible same-id candidate from a later source may still load.
 */
function acceptCandidateIds(
  candidates: readonly ExtensionCandidate[],
  reservedIds: ReadonlySet<string>,
  initialClaims: ReadonlyMap<string, string> = new Map(),
): AcceptedCandidates {
  const accepted: ExtensionCandidate[] = [];
  const issues: ExtensionLoadIssue[] = [];
  const claimedBy = new Map(initialClaims);

  for (const candidate of candidates) {
    const refusal =
      describeIdRefusal(candidate, claimedBy, reservedIds) ?? describeApiVersionRefusal(candidate);
    if (refusal !== undefined) {
      issues.push({
        extensionId: candidate.id,
        path: candidate.path,
        origin: candidate.origin,
        message: refusal,
      });
      continue;
    }

    claimedBy.set(candidate.id, candidate.path);
    accepted.push(candidate);
  }

  return { accepted, issues };
}

/** Return the ids a completed candidate prefix owns, including candidates that failed later. */
function collectCandidateClaims(
  candidates: readonly ExtensionCandidate[],
  reservedIds: ReadonlySet<string>,
) {
  const claimedBy = new Map<string, string>();
  for (const candidate of candidates) {
    if (describeIdRefusal(candidate, claimedBy, reservedIds) === undefined) {
      claimedBy.set(candidate.id, candidate.path);
    }
  }
  return claimedBy;
}

/**
 * Load every discovered extension into one registry.
 *
 * Isolation is the contract here: a candidate whose id is refused, that fails
 * to import, has no default export, or throws from its factory becomes an
 * `ExtensionLoadIssue` and is skipped. Repo-local candidates additionally
 * require a recorded trust decision; unknown ones are skipped and reported
 * through `pendingTrustRepoRoot` so the UI can ask and reload.
 */
export async function loadExtensions(options: LoadExtensionsOptions): Promise<ExtensionLoadResult> {
  // Ids are settled before anything is imported, so a refused candidate never
  // gets a loader hook, let alone an evaluated module.
  const reservedIds = options.reservedExtensionIds ?? new Set<string>();
  const previousCandidates = options.previousLoad?.loadState.candidates ?? [];
  const { accepted, issues: candidateIssues } = acceptCandidateIds(
    options.candidates,
    reservedIds,
    collectCandidateClaims(previousCandidates, reservedIds),
  );
  const issues = [...(options.previousLoad?.issues ?? []), ...candidateIssues];
  // Before any candidate is imported, so its `react` (and `hunkdiff/extension`)
  // imports resolve to the host's own instances rather than the filesystem.
  registerHostRuntimeModules(accepted.map((candidate) => candidate.path));
  const registry = options.previousLoad?.registry ?? createEmptyExtensionRegistry();
  if (!registryRetired(registry)) registry.eventBusPhase = "loading";
  const notifications =
    options.notifications ??
    options.previousLoad?.notifications ??
    createExtensionNotificationHub();
  const context = createExtensionContext(options.cwd, notifications.notify);
  const result: ExtensionLoadResult = {
    registry,
    issues,
    loaded: [...registry.extensions],
    context,
    notifications,
    loadState: {
      candidates: [...(options.allCandidates ?? options.candidates)],
      extensionConfigs: structuredClone(options.extensionConfigs ?? {}),
    },
  };
  options.onProvisionalLoad?.(result);
  if (registryRetired(registry)) return result;
  const importModule = options.importExtensionModuleImpl ?? importExtensionModule;
  const resolveTrust = options.resolveRepoTrustImpl ?? resolveRepoTrust;
  const trustOptions: ExtensionTrustOptions = { env: options.env };

  let repoTrustState: ExtensionTrustState | undefined;
  let repoRoot = options.repoRoot;
  let pendingTrustRepoRoot = options.previousLoad?.pendingTrustRepoRoot;

  /** Resolve the repo trust state once per load pass, lazily. */
  const resolveRepoTrustState = () => {
    repoRoot ??= findProjectRootCandidate(options.cwd);
    if (!repoRoot) {
      return "unknown" as const;
    }

    repoTrustState ??= resolveTrust(repoRoot, trustOptions);
    return repoTrustState;
  };

  for (const candidate of accepted) {
    if (registryRetired(registry)) break;
    if (candidate.origin === "repo") {
      const trust = resolveRepoTrustState();
      if (trust !== "trusted") {
        // Unknown trust is a question for the user; denied trust is already answered.
        if (trust === "unknown" && repoRoot) {
          pendingTrustRepoRoot = repoRoot;
        }
        continue;
      }
    }

    const metadata: ExtensionMetadata = {
      id: candidate.id,
      sourcePath: candidate.path,
      origin: candidate.origin,
    };
    let factory: ExtensionFactory;
    try {
      // Importing is the host's half of loading: it is the part that differs
      // from the bundled tier, which has its factories statically in hand.
      factory = readExtensionFactory(await importModule(candidate.path));
      if (registryRetired(registry)) break;
    } catch (error) {
      issues.push({
        extensionId: candidate.id,
        path: candidate.path,
        origin: candidate.origin,
        message: describeError(error),
      });
      continue;
    }

    await runExtensionFactory({
      metadata,
      registry,
      issues,
      factory,
      config: options.extensionConfigs?.[candidate.id],
    });
    if (registryRetired(registry)) break;
  }

  // `registry.extensions` already holds exactly the extensions whose factories
  // completed, in load order, so the loaded list is a copy of it rather than a
  // second tally that could drift.
  result.loaded = [...registry.extensions];
  if (pendingTrustRepoRoot) {
    result.pendingTrustRepoRoot = pendingTrustRepoRoot;
  } else {
    delete result.pendingTrustRepoRoot;
  }
  if (!options.deferEventBusBinding) {
    bindExtensionEventBus(result);
  }
  return result;
}
