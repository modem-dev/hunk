import { pathToFileURL } from "node:url";
import { findVcsRepoRootCandidate } from "../core/vcs";
import { createExtensionNotificationHub, type ExtensionNotificationHub } from "./notifications";
import { describeError, readExtensionFactory, runExtensionFactory } from "./runExtension";
import { resolveRepoTrust, type ExtensionTrustOptions, type ExtensionTrustState } from "./trust";
import {
  createEmptyExtensionRegistry,
  createExtensionContext,
  type ExtensionCandidate,
  type ExtensionFactory,
  type ExtensionLoadIssue,
  type ExtensionLoadResult,
  type ExtensionMetadata,
} from "./types";

export interface LoadExtensionsOptions {
  candidates: readonly ExtensionCandidate[];
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
  env?: NodeJS.ProcessEnv;
  /** Trust lookup seam so tests can drive gating without touching the state file. */
  resolveRepoTrustImpl?: (repoRoot: string, options: ExtensionTrustOptions) => ExtensionTrustState;
  /** Module loader seam; defaults to a plain dynamic import of the absolute path. */
  importExtensionModuleImpl?: (path: string) => Promise<unknown>;
}

/** Import one extension entry file by absolute path, cross-platform. */
async function importExtensionModule(path: string): Promise<unknown> {
  // File URLs are required on Windows, where a drive-letter path is not a valid specifier.
  return await import(pathToFileURL(path).href);
}

/**
 * Load every discovered extension into one registry.
 *
 * Isolation is the contract here: a candidate that fails to import, has no
 * default export, or throws from its factory becomes an `ExtensionLoadIssue`
 * and is skipped. Repo-local candidates additionally require a recorded trust
 * decision; unknown ones are skipped and reported through
 * `pendingTrustRepoRoot` so the UI can ask and reload.
 */
export async function loadExtensions(options: LoadExtensionsOptions): Promise<ExtensionLoadResult> {
  const registry = createEmptyExtensionRegistry();
  const issues: ExtensionLoadIssue[] = [];
  const importModule = options.importExtensionModuleImpl ?? importExtensionModule;
  const resolveTrust = options.resolveRepoTrustImpl ?? resolveRepoTrust;
  const trustOptions: ExtensionTrustOptions = { env: options.env };

  let repoTrustState: ExtensionTrustState | undefined;
  let repoRoot = options.repoRoot;
  let pendingTrustRepoRoot: string | undefined;

  /** Resolve the repo trust state once per load pass, lazily. */
  const resolveRepoTrustState = () => {
    repoRoot ??= findVcsRepoRootCandidate(options.cwd);
    if (!repoRoot) {
      return "unknown" as const;
    }

    repoTrustState ??= resolveTrust(repoRoot, trustOptions);
    return repoTrustState;
  };

  for (const candidate of options.candidates) {
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
  }

  const notifications = options.notifications ?? createExtensionNotificationHub();
  const context = createExtensionContext(options.cwd, notifications.notify);
  // `registry.extensions` already holds exactly the extensions whose factories
  // completed, in load order, so the loaded list is a copy of it rather than a
  // second tally that could drift.
  const loaded = [...registry.extensions];
  return pendingTrustRepoRoot
    ? { registry, issues, loaded, context, notifications, pendingTrustRepoRoot }
    : { registry, issues, loaded, context, notifications };
}
