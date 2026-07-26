import { BUILT_IN_FILE_LANGUAGE_EXTENSIONS, registerFileLanguage } from "../core/fileLanguage";
import type { StartupNotice } from "../core/startupNotice";
import type { Changeset } from "../core/types";
import { detectVcs, isVcsId } from "../core/vcs";
import type { VcsAdapter } from "../core/vcs/types";
import { sanitizeTerminalLine } from "../lib/terminalText";
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
 * Filter user-extension VCS adapters down to the ones Hunk will actually consult.
 *
 * Shipped ids are reserved: an extension may add `hg`, but it may not replace
 * `git`, `jj`, or `sl` — the last two are reserved by the bundled tier, which
 * registers through this same API but is loaded with core adapter resolution.
 * Duplicate ids between extensions resolve to the first registration so load
 * order stays the tiebreaker everywhere.
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
 * Pick the VCS id a user-extension adapter detects, when no shipped backend does.
 *
 * Origin decides how much authority an adapter has over detection. Bundled
 * adapters are product behavior, so they take part in first-class detection
 * through `detectVcs` — a pure jj checkout resolves to `jj` during config
 * resolution, before any user extension has been imported. User adapters get
 * this conservative rule instead: config has already chosen the session's VCS
 * by the time they load, so they may claim a directory nothing shipped
 * recognized, but never override one that was.
 *
 * Both paths run through the same `detectVcs` ordering, so there is still one
 * definition of detection order.
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

/** Report whether one value is a plain object rather than null or an array. */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Report whether one hunk carries the content list the renderer walks. */
function isHunkLike(value: unknown) {
  return isObjectLike(value) && Array.isArray(value.hunkContent);
}

/**
 * Explain why one transform result cannot be reviewed, or return undefined when it can.
 *
 * This validates deeper than the fields this module itself reads, because a
 * file that reaches the review UI without usable `metadata.hunks` throws from
 * inside rendering — well outside the transform's try/catch — and takes the
 * whole app down. The isolation contract in docs/extensions.md promises a
 * misbehaving extension costs the user a warning, not the session, so anything
 * the renderer indexes into unguarded has to be checked here instead.
 */
function describeChangesetIssue(value: unknown): string | undefined {
  if (!isObjectLike(value)) {
    return "not an object";
  }

  const files = value.files;
  if (!Array.isArray(files)) {
    return "files is not an array";
  }

  const claimedIds = new Set<string>();
  for (const [index, file] of files.entries()) {
    const label = `files[${index}]`;
    if (!isObjectLike(file)) {
      return `${label} is not an object`;
    }

    const id = file.id;
    if (typeof id !== "string" || id.length === 0) {
      return `${label}.id is not a non-empty string`;
    }

    // File ids key React rows, the selection model, and note targeting, so two
    // files sharing one id corrupts review state rather than just rendering oddly.
    if (claimedIds.has(id)) {
      return `duplicate file id "${id}"`;
    }
    claimedIds.add(id);

    if (typeof file.path !== "string") {
      return `${label}.path is not a string`;
    }

    // The sidebar and the changeset totals read stats without guarding.
    const stats = file.stats;
    if (
      !isObjectLike(stats) ||
      typeof stats.additions !== "number" ||
      typeof stats.deletions !== "number"
    ) {
      return `${label}.stats is missing addition and deletion counts`;
    }

    // `agent` is optional context, but the note UI treats a present value as a
    // record with annotations rather than checking each access.
    const agent = file.agent;
    if (agent != null && (!isObjectLike(agent) || !Array.isArray(agent.annotations))) {
      return `${label}.agent has no annotations array`;
    }

    const metadata = file.metadata;
    if (!isObjectLike(metadata)) {
      return `${label}.metadata is not an object`;
    }

    if (!Array.isArray(metadata.hunks)) {
      return `${label}.metadata.hunks is not an array`;
    }

    if (!metadata.hunks.every(isHunkLike)) {
      return `${label}.metadata.hunks contains an unusable hunk`;
    }
  }

  return undefined;
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
      const issue = describeChangesetIssue(next);
      if (issue) {
        result.context.notify(
          `Extension ${extensionId} returned an invalid changeset (${issue}) • keeping the previous one`,
          "warning",
        );
        continue;
      }

      // Validated above, so the public changeset view is safe to read as the
      // internal model the rest of the pipeline works with.
      current = next as Changeset;
    } catch (error) {
      result.context.notify(
        `Extension ${extensionId} failed transforming the changeset • ${describeError(error)}`,
        "warning",
      );
    }
  }

  return current;
}

/**
 * Turn refused registrations into startup notices for the first-launch path.
 *
 * The messages quote extension-authored ids, so they are stripped of terminal
 * control sequences before being drawn into the status bar.
 */
export function createExtensionApplyNotices(
  issues: readonly ExtensionApplyIssue[],
): StartupNotice[] {
  return issues.map((issue, index) => ({
    key: `extension:apply:${issue.extensionId}:${index}`,
    message: sanitizeTerminalLine(issue.message),
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
