import { resolve } from "node:path";
import { readHunkStateRecord, updateHunkStateRecord } from "../core/hunkState";
import { resolveHunkStatePath } from "../core/paths";

/**
 * Repo-local extensions run arbitrary code from the repository under review,
 * which is exactly the code a reviewer has not read yet. Decisions are stored
 * per repo root in Hunk's shared state file so a trusted repo stays trusted
 * across sessions and an untrusted one is never executed silently.
 */
const EXTENSION_TRUST_STATE_KEY = "extensionTrust";

export type ExtensionTrustDecision = "trusted" | "denied";
/** Trust for a repo with no recorded decision yet. */
export type ExtensionTrustState = ExtensionTrustDecision | "unknown";
export type ExtensionTrustMap = Record<string, ExtensionTrustDecision>;

export interface ExtensionTrustOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the state file path; falls back to the user-scoped state location. */
  statePath?: string;
}

/** Resolve the state file backing trust decisions, if the environment has one. */
function resolveStatePath(options: ExtensionTrustOptions) {
  return options.statePath ?? resolveHunkStatePath(options.env ?? process.env);
}

/** Normalize one repo root into the stable key used in persisted state. */
function toTrustKey(repoRoot: string) {
  return resolve(repoRoot);
}

/** Accept only the recorded decisions Hunk understands. */
function normalizeDecision(value: unknown): ExtensionTrustDecision | undefined {
  return value === "trusted" || value === "denied" ? value : undefined;
}

/** Read every persisted repo-root trust decision. */
export function readExtensionTrust(options: ExtensionTrustOptions = {}): ExtensionTrustMap {
  const statePath = resolveStatePath(options);
  if (!statePath) {
    return {};
  }

  const stored = readHunkStateRecord(statePath)[EXTENSION_TRUST_STATE_KEY];
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return {};
  }

  const trust: ExtensionTrustMap = {};
  for (const [repoRoot, decision] of Object.entries(stored as Record<string, unknown>)) {
    const normalized = normalizeDecision(decision);
    if (normalized) {
      trust[repoRoot] = normalized;
    }
  }

  return trust;
}

/** Resolve the trust state for one repo root, defaulting to `unknown`. */
export function resolveRepoTrust(
  repoRoot: string,
  options: ExtensionTrustOptions = {},
): ExtensionTrustState {
  return readExtensionTrust(options)[toTrustKey(repoRoot)] ?? "unknown";
}

/** Persist one repo-root trust decision without disturbing other state keys. */
export function writeExtensionTrust(
  repoRoot: string,
  decision: ExtensionTrustDecision,
  options: ExtensionTrustOptions = {},
) {
  const statePath = resolveStatePath(options);
  if (!statePath) {
    throw new Error("Could not resolve the Hunk state path because HOME/XDG_CONFIG_HOME is unset.");
  }

  updateHunkStateRecord(statePath, {
    [EXTENSION_TRUST_STATE_KEY]: {
      ...readExtensionTrust(options),
      [toTrustKey(repoRoot)]: decision,
    },
  });

  return statePath;
}
