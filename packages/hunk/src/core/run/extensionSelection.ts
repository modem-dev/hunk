/** One ordered, launch-scoped override from the Hunk CLI. */
export interface ExtensionSelectionOverride {
  id: string;
  enabled: boolean;
}

export type ExtensionSelectionSource =
  | "default"
  | "user-config"
  | "repo-config"
  | "cli"
  | "master-switch";

/** The resolved enablement of one extension identity for this invocation. */
export interface ExtensionSelectionDecision {
  id: string;
  enabled: boolean;
  source: ExtensionSelectionSource;
}

export interface ResolveExtensionSelectionOptions {
  id: string;
  kind: "bundled" | "user";
  userDisabled?: readonly string[];
  repoDisabled?: readonly string[];
  cliOverrides?: readonly ExtensionSelectionOverride[];
  userExtensionsEnabled?: boolean;
}

/** Resolve one extension identity without performing discovery, imports, or registry mutation. */
export function resolveExtensionSelection({
  id,
  kind,
  userDisabled = [],
  repoDisabled = [],
  cliOverrides = [],
  userExtensionsEnabled = true,
}: ResolveExtensionSelectionOptions): ExtensionSelectionDecision {
  if (kind === "user" && !userExtensionsEnabled) {
    return { id, enabled: false, source: "master-switch" };
  }

  let cliDecision: ExtensionSelectionOverride | undefined;
  for (const override of cliOverrides) {
    if (override.id === id) cliDecision = override;
  }

  if (cliDecision) {
    return { id, enabled: cliDecision.enabled, source: "cli" };
  }
  if (userDisabled.includes(id)) {
    return { id, enabled: false, source: "user-config" };
  }
  if (repoDisabled.includes(id)) {
    return { id, enabled: false, source: "repo-config" };
  }
  return { id, enabled: true, source: "default" };
}

/** Keep the first occurrence order while normalizing exact, non-empty extension IDs. */
export function normalizeExtensionSelectionIds(values: readonly string[]) {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const id = value.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}
