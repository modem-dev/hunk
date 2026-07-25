import { BUILT_IN_FILE_LANGUAGE_EXTENSIONS, registerFileLanguage } from "../core/fileLanguage";
import type { StartupNotice } from "../core/startupNotice";
import type { Changeset } from "../core/types";
import { detectVcs, isVcsId } from "../core/vcs";
import type { VcsAdapter } from "../core/vcs/types";
import type { ExtensionContext, ExtensionLoadResult, ExtensionRegistry } from "./types";

/**
 * One registration Hunk refused to apply.
 *
 * Kept as data rather than a formatted notice so the same detection logic can
 * surface at startup (as a startup notice) and mid-session (as a toast) without
 * two implementations of the rules themselves.
 */
export interface ExtensionApplyIssue {
  extensionId: string;
  message: string;
}

/** Read an error's message without assuming extension code throws `Error` instances. */
function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
}

/**
 * Register every extension-contributed file-extension → language mapping.
 *
 * Pierre's mapping table is process-global, so this is applied once per load
 * pass. Within extensions the last registration wins, matching how a later
 * config layer overrides an earlier one; Hunk's own `.mts`/`.cts` mappings are
 * never overridden.
 */
export function applyExtensionFileLanguages(registry: ExtensionRegistry): ExtensionApplyIssue[] {
  const issues: ExtensionApplyIssue[] = [];

  for (const { extensionId, extension, language } of registry.fileLanguages) {
    if (BUILT_IN_FILE_LANGUAGE_EXTENSIONS.has(extension)) {
      issues.push({
        extensionId,
        message: `Skipped file language .${extension} from extension ${extensionId} • Hunk defines it`,
      });
      continue;
    }

    registerFileLanguage(extension, language);
  }

  return issues;
}

/** Extension VCS adapters that may join detection and lookup, plus the ones skipped. */
export interface ResolvedExtensionVcsAdapters {
  adapters: VcsAdapter[];
  issues: ExtensionApplyIssue[];
}

/**
 * Filter extension VCS adapters down to the ones Hunk will actually consult.
 *
 * Built-in ids are reserved: an extension may add `hg`, but it may not replace
 * `git`. Duplicate ids between extensions resolve to the first registration so
 * load order stays the tiebreaker everywhere.
 */
export function resolveExtensionVcsAdapters(
  registry: ExtensionRegistry,
): ResolvedExtensionVcsAdapters {
  const adapters: VcsAdapter[] = [];
  const issues: ExtensionApplyIssue[] = [];
  const claimed = new Set<string>();

  for (const { extensionId, adapter } of registry.vcsAdapters) {
    if (isVcsId(adapter.id)) {
      issues.push({
        extensionId,
        message: `Skipped VCS adapter "${adapter.id}" from extension ${extensionId} • a built-in backend owns that id`,
      });
      continue;
    }

    if (claimed.has(adapter.id)) {
      issues.push({
        extensionId,
        message: `Skipped VCS adapter "${adapter.id}" from extension ${extensionId} • another extension already registered it`,
      });
      continue;
    }

    claimed.add(adapter.id);
    adapters.push(adapter);
  }

  return { adapters, issues };
}

/** Everything one load pass contributes to the loading pipeline, plus refused registrations. */
export interface AppliedExtensionRegistrations {
  /** Extension adapters to thread into `loadAppBootstrap`. */
  vcsAdapters: VcsAdapter[];
  issues: ExtensionApplyIssue[];
}

/**
 * Apply the registrations that must land before a changeset is loaded.
 *
 * Startup and mid-session extension reloads both go through here so a newly
 * trusted repo extension contributes exactly what it would have contributed on
 * a fresh launch.
 */
export function applyExtensionRegistrations(
  result: ExtensionLoadResult | undefined,
): AppliedExtensionRegistrations {
  if (!result) {
    return { vcsAdapters: [], issues: [] };
  }

  const languageIssues = applyExtensionFileLanguages(result.registry);
  const vcs = resolveExtensionVcsAdapters(result.registry);
  return { vcsAdapters: vcs.adapters, issues: [...languageIssues, ...vcs.issues] };
}

/**
 * Pick the VCS id an extension adapter detects, when no built-in backend does.
 *
 * Config resolves the session's VCS before extensions have loaded, so this is
 * the point where an extension backend can claim a checkout Hunk would
 * otherwise have treated as a plain Git working tree. Built-in detection keeps
 * priority: a repo any built-in recognizes is left alone.
 */
export function resolveExtensionDetectedVcsId(
  cwd: string,
  adapters: readonly VcsAdapter[],
): string | undefined {
  if (adapters.length === 0 || detectVcs(cwd)) {
    return undefined;
  }

  return detectVcs(cwd, adapters)?.id;
}

/** Report whether one transform result is shaped enough like a changeset to render. */
function isChangesetLike(value: unknown): value is Changeset {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    return false;
  }

  // Only the fields every consumer indexes into are checked; deep validation
  // would just duplicate the DiffFile type without catching more real mistakes.
  return files.every(
    (file) =>
      typeof file === "object" &&
      file !== null &&
      typeof (file as { id?: unknown }).id === "string" &&
      typeof (file as { path?: unknown }).path === "string" &&
      typeof (file as { metadata?: unknown }).metadata === "object",
  );
}

/**
 * Run every registered changeset transform, in registration order.
 *
 * Each transform sees the previous one's output, so extensions compose the way
 * config layers do. A transform that throws or returns something unusable is
 * skipped — the previous changeset carries forward — and the user is told which
 * extension misbehaved, because silently reviewing the wrong file set is worse
 * than a visible warning.
 */
export async function applyExtensionChangesetTransforms(
  result: ExtensionLoadResult | undefined,
  changeset: Changeset,
): Promise<Changeset> {
  if (!result || result.registry.changesetTransforms.length === 0) {
    return changeset;
  }

  let current = changeset;
  for (const { extensionId, transform } of result.registry.changesetTransforms) {
    try {
      const next = await transform(current, result.context);
      if (!isChangesetLike(next)) {
        result.context.notify(
          `Extension ${extensionId} returned an invalid changeset • keeping the previous one`,
          "warning",
        );
        continue;
      }

      current = next;
    } catch (error) {
      result.context.notify(
        `Extension ${extensionId} failed transforming the changeset • ${describeError(error)}`,
        "warning",
      );
    }
  }

  return current;
}

/** Turn refused registrations into startup notices for the first-launch path. */
export function createExtensionApplyNotices(
  issues: readonly ExtensionApplyIssue[],
): StartupNotice[] {
  return issues.map((issue, index) => ({
    key: `extension:apply:${issue.extensionId}:${index}`,
    message: issue.message,
  }));
}

/** Surface refused registrations as toasts for mid-session extension reloads. */
export function reportExtensionApplyIssues(
  issues: readonly ExtensionApplyIssue[],
  context: ExtensionContext,
) {
  for (const issue of issues) {
    context.notify(issue.message, "warning");
  }
}
