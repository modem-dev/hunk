import {
  BUILT_IN_FILE_LANGUAGE_EXTENSIONS,
  replaceExtensionFileLanguages,
  type FileLanguageRegistration,
} from "../core/changeset/fileLanguage";
import type { StartupNotice } from "../core/process/startupNotice";
import type { Changeset } from "../core/changeset/model";
import { detectVcs, extendVcsCatalog, getDefaultVcsAdapter } from "../core/vcs";
import type { VcsAdapter, VcsCatalog } from "../core/vcs/types";
import { sanitizeTerminalLine } from "../lib/terminalText";
import {
  createEmptyExtensionRegistry,
  type ExtensionContext,
  type ExtensionLoadResult,
  type ExtensionRegistry,
  type RegisteredCommand,
  type RegisteredFileView,
  type RegisteredKeyboardMode,
  type RegisteredLineHighlighter,
  type RegisteredPane,
} from "./types";
import { getBundledFileLanguages } from "./default/languages";

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
 * Register every bundled and user-extension file selector and language.
 *
 * Bundled selectors load first so `--no-extensions` still gets shipped defaults; user
 * registrations follow and win ties within a selector category. Hunk's reserved `.mts`/`.cts`
 * extension mappings remain non-overridable.
 */
export function applyExtensionFileLanguages(registry: ExtensionRegistry): ExtensionApplyIssue[] {
  const issues: ExtensionApplyIssue[] = [];
  const registrations: FileLanguageRegistration[] = [];

  for (const { extensionId, matcher, language } of [
    ...getBundledFileLanguages(),
    ...registry.fileLanguages,
  ]) {
    if (matcher.kind === "extension" && BUILT_IN_FILE_LANGUAGE_EXTENSIONS.has(matcher.value)) {
      issues.push({
        extensionId,
        message: `Skipped file language .${matcher.value} from extension ${extensionId} • Hunk defines it`,
      });
      continue;
    }

    registrations.push({ matcher, language });
  }

  replaceExtensionFileLanguages(registrations);
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
  baseCatalog: VcsCatalog,
): ResolvedExtensionVcsAdapters {
  const adapters: VcsAdapter[] = [];
  const issues: ExtensionApplyIssue[] = [];
  const claimed = new Set<string>();

  for (const { extensionId, adapter } of registry.vcsAdapters) {
    if (baseCatalog.reservedIds.has(adapter.id)) {
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

/**
 * Join one extension id and a local view id into the address every registered view is known by.
 *
 * Duplicate resolution, selection lookup, and command-facing id qualification must agree on this
 * exactly, so the format lives here once rather than being re-templated per caller.
 */
export function qualifiedViewKey(extensionId: string, viewId: string) {
  return `${extensionId}:${viewId}`;
}

/** Derive the `<extensionId>:<viewId>` key one registered view is addressed by. */
export function registeredViewKey(registered: { extensionId: string; view: { id: string } }) {
  return qualifiedViewKey(registered.extensionId, registered.view.id);
}

/** Derive the key one pane is addressed by everywhere in the app. */
export function paneKey(registered: RegisteredPane) {
  return qualifiedViewKey(registered.extensionId, registered.pane.id);
}

/** The panes one session offers, plus registrations skipped as duplicates. */
export interface ResolvedExtensionPanes {
  panes: RegisteredPane[];
  issues: ExtensionApplyIssue[];
}

/** Resolve pane identities and replacement ownership in registration order. */
export function resolveExtensionPanes(
  registry: Pick<ExtensionRegistry, "panes">,
): ResolvedExtensionPanes {
  const panes: RegisteredPane[] = [];
  const issues: ExtensionApplyIssue[] = [];
  const claimedKeys = new Set<string>();
  const claimedReplacementTargets = new Set<string>();

  for (const registered of registry.panes) {
    const key = paneKey(registered);
    if (claimedKeys.has(key)) {
      issues.push({
        extensionId: registered.extensionId,
        message: `Skipped duplicate pane "${key}" from extension ${registered.extensionId}`,
      });
      continue;
    }
    const replacementTarget = registered.pane.replaces;
    if (replacementTarget && claimedReplacementTargets.has(replacementTarget)) {
      issues.push({
        extensionId: registered.extensionId,
        message: `Skipped pane "${key}" from extension ${registered.extensionId} • another pane already replaces "${replacementTarget}"`,
      });
      continue;
    }
    claimedKeys.add(key);
    if (replacementTarget) claimedReplacementTargets.add(replacementTarget);
    panes.push(registered);
  }
  return { panes, issues };
}

/** Derive the key one file view is addressed by everywhere in the app. */
export function fileViewKey(registered: RegisteredFileView) {
  return registeredViewKey(registered);
}

/** The file views one session offers, plus registrations skipped as duplicates. */
export interface ResolvedExtensionFileViews {
  views: RegisteredFileView[];
  issues: ExtensionApplyIssue[];
}

/** Resolve file-view identities while retaining registration order as the priority rule. */
export function resolveExtensionFileViews(registry: ExtensionRegistry): ResolvedExtensionFileViews {
  const views: RegisteredFileView[] = [];
  const issues: ExtensionApplyIssue[] = [];
  const claimed = new Set<string>();

  for (const registered of registry.fileViews) {
    const key = fileViewKey(registered);
    if (claimed.has(key)) {
      issues.push({
        extensionId: registered.extensionId,
        message: `Skipped duplicate file view "${key}" from extension ${registered.extensionId}`,
      });
      continue;
    }

    claimed.add(key);
    views.push(registered);
  }

  return { views, issues };
}

/** Derive the key one line highlighter is addressed by everywhere in the app. */
export function lineHighlighterKey(registered: RegisteredLineHighlighter) {
  return qualifiedViewKey(registered.extensionId, registered.highlighter.id);
}

/** The line highlighters one session runs, plus registrations skipped as duplicates. */
export interface ResolvedExtensionLineHighlighters {
  highlighters: RegisteredLineHighlighter[];
  issues: ExtensionApplyIssue[];
}

/** Resolve line-highlighter identities while retaining registration order as the priority rule. */
export function resolveExtensionLineHighlighters(
  registry: ExtensionRegistry,
): ResolvedExtensionLineHighlighters {
  const highlighters: RegisteredLineHighlighter[] = [];
  const issues: ExtensionApplyIssue[] = [];
  const claimed = new Set<string>();

  for (const registered of registry.lineHighlighters) {
    const key = lineHighlighterKey(registered);
    if (claimed.has(key)) {
      issues.push({
        extensionId: registered.extensionId,
        message: `Skipped duplicate line highlighter "${key}" from extension ${registered.extensionId}`,
      });
      continue;
    }

    claimed.add(key);
    highlighters.push(registered);
  }

  return { highlighters, issues };
}

/** Derive the key one session keyboard mode is addressed by everywhere in the app. */
export function keyboardModeKey(registered: RegisteredKeyboardMode) {
  return qualifiedViewKey(registered.extensionId, registered.mode.id);
}

/** The session keyboard modes one session offers, plus duplicate diagnostics. */
export interface ResolvedExtensionKeyboardModes {
  modes: RegisteredKeyboardMode[];
  issues: ExtensionApplyIssue[];
}

/** Resolve session keyboard-mode identities with first registration winning. */
export function resolveExtensionKeyboardModes(
  registry: ExtensionRegistry,
): ResolvedExtensionKeyboardModes {
  const modes: RegisteredKeyboardMode[] = [];
  const issues: ExtensionApplyIssue[] = [];
  const claimed = new Set<string>();

  for (const registered of registry.keyboardModes) {
    const key = keyboardModeKey(registered);
    if (claimed.has(key)) {
      issues.push({
        extensionId: registered.extensionId,
        message: `Skipped duplicate keyboard mode "${key}" from extension ${registered.extensionId}`,
      });
      continue;
    }

    claimed.add(key);
    modes.push(registered);
  }

  return { modes, issues };
}

/** The commands one session offers, plus the registrations skipped as duplicates. */
export interface ResolvedExtensionCommands {
  commands: RegisteredCommand[];
  issues: ExtensionApplyIssue[];
}

/**
 * Collect every extension command a session offers.
 *
 * Command ids are `<extensionId>.<id>`, so duplicates only arise within one
 * extension; the first registration wins and the duplicate is reported. Key
 * *chord* conflicts are not resolved here — they depend on the built-in
 * command table, which is the UI's to build, so the dispatch layer decides
 * them and warns.
 */
export function resolveExtensionCommands(registry: ExtensionRegistry): ResolvedExtensionCommands {
  const commands: RegisteredCommand[] = [];
  const issues: ExtensionApplyIssue[] = [];
  const claimed = new Set<string>();

  for (const registered of registry.commands) {
    const fullId = `${registered.extensionId}.${registered.command.id}`;
    if (claimed.has(fullId)) {
      issues.push({
        extensionId: registered.extensionId,
        message: `Skipped duplicate command "${fullId}" from extension ${registered.extensionId}`,
      });
      continue;
    }

    claimed.add(fullId);
    commands.push(registered);
  }

  return { commands, issues };
}

/** Host-level behavior resolved across every extension in one shared session. */
export interface ResolvedExtensionSessionOptions {
  /** Any transient request wins so a guide cannot accidentally persist practice state. */
  transientViewPreferences: boolean;
}

/** Resolve extension session requests through their documented shared-session policy. */
export function resolveExtensionSessionOptions(
  registry: ExtensionRegistry,
): ResolvedExtensionSessionOptions {
  return {
    transientViewPreferences: registry.sessionOptions.some(
      ({ options }) => options.viewPreferences === "transient",
    ),
  };
}

/** Everything one load pass contributes to the loading pipeline, plus refused registrations. */
export interface AppliedExtensionRegistrations {
  /** Accepted user adapters, retained for notices and extension-facing UI state. */
  vcsAdapters: VcsAdapter[];
  /** Complete bundled plus user catalog used by loading, reload, and watch. */
  vcsCatalog: VcsCatalog;
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
  baseCatalog: VcsCatalog,
): AppliedExtensionRegistrations {
  if (!result) {
    // Still apply bundled file languages when user extensions are absent or disabled.
    return {
      vcsAdapters: [],
      vcsCatalog: baseCatalog,
      issues: applyExtensionFileLanguages(createEmptyExtensionRegistry()),
    };
  }

  const languageIssues = applyExtensionFileLanguages(result.registry);
  const vcs = resolveExtensionVcsAdapters(result.registry, baseCatalog);
  // Resolved again where the UI consumes them; consulted here so skipped
  // duplicate registrations surface through the same notice path as every
  // other refusal.
  const panes = resolveExtensionPanes(result.registry);
  const fileViews = resolveExtensionFileViews(result.registry);
  const lineHighlighters = resolveExtensionLineHighlighters(result.registry);
  const keyboardModes = resolveExtensionKeyboardModes(result.registry);
  const commands = resolveExtensionCommands(result.registry);
  return {
    vcsAdapters: vcs.adapters,
    vcsCatalog: extendVcsCatalog(baseCatalog, vcs.adapters),
    issues: [
      ...languageIssues,
      ...vcs.issues,
      ...panes.issues,
      ...fileViews.issues,
      ...lineHighlighters.issues,
      ...keyboardModes.issues,
      ...commands.issues,
    ],
  };
}

/** Report whether one id names a backend this session actually loaded. */
function ownsVcsId(catalog: VcsCatalog, vcsId: string) {
  return catalog.adapters.some((adapter) => adapter.id === vcsId);
}

/**
 * Re-run checkout detection with the session's full adapter list in hand.
 *
 * Config resolution picks the session's VCS before user extensions have been
 * imported, so its answer only ever saw the bundled backends. This is where
 * that provisional answer is revisited, under one rule for every adapter
 * whatever its origin: the nearest checkout wins, and `detectionPriority` only
 * breaks ties between adapters that recognize the same root. A Mercurial
 * extension's checkout nested inside an outer Git repository is the repository
 * the user is standing in, and which tier registered the backend does not
 * change that. Priority is still what keeps colocated cases sane — a
 * default-priority user adapter loses a same-root tie with Git, so installing
 * an extension does not quietly change how an existing repo is reviewed.
 *
 * Detection itself stays in `detectVcs`, so nearest-root-wins is defined once.
 *
 * An explicit `vcs` a loaded backend owns is not detection and is never
 * overridden: `resolveSessionVcsId` has already honored it, so this returns
 * undefined and the caller keeps that choice. An explicit id nothing owns has
 * already fallen back to detection, so detection is what decides it here too.
 */
export function resolveDetectedVcsIdWithExtensions(
  cwd: string,
  catalog: VcsCatalog,
  explicitVcsId?: string,
): string | undefined {
  if (explicitVcsId !== undefined && ownsVcsId(catalog, explicitVcsId)) {
    return undefined;
  }

  return detectVcs(cwd, catalog)?.id;
}

/** The backend one session will load with, plus a configured id nothing owned. */
export interface ResolvedSessionVcsId {
  vcsId: string | undefined;
  /** Set when the configured id named no loaded backend, so the caller can report it. */
  unknownVcsId?: string;
}

/**
 * Reconcile the configured VCS id against the backends this session actually has.
 *
 * Config accepts any id, because it resolves before user extensions are
 * imported and cannot know which backends will exist. This is where that
 * provisional choice is settled, with the full adapter list in hand.
 *
 * An id a loaded backend owns is honored — `vcs = "hg"` with a Mercurial
 * extension installed is unambiguous user intent, and the whole point of
 * naming a backend explicitly is that it is used. An id nothing owns falls back
 * to detection, which is what already happened, except that it is now reported
 * instead of silently discarded: a typo or an extension that failed to load
 * used to look exactly like working configuration.
 *
 * This deliberately does not consult detection *order* — it only asks whether a
 * backend with that id exists, so it composes with, rather than duplicates,
 * `resolveDetectedVcsIdWithExtensions`.
 */
export function resolveSessionVcsId(
  configuredVcsId: string | undefined,
  cwd: string,
  catalog: VcsCatalog,
): ResolvedSessionVcsId {
  if (!configuredVcsId) {
    return { vcsId: configuredVcsId };
  }

  if (ownsVcsId(catalog, configuredVcsId)) {
    return { vcsId: configuredVcsId };
  }

  // Same fallback config itself would have produced had it dropped the id.
  return {
    vcsId: detectVcs(cwd, catalog)?.id ?? getDefaultVcsAdapter(catalog).id,
    unknownVcsId: configuredVcsId,
  };
}

/** Report a configured `vcs` id no loaded backend recognized. */
export function createUnknownVcsNotice(unknownVcsId: string, fallbackVcsId: string): StartupNotice {
  return {
    key: `vcs:unknown:${unknownVcsId}`,
    message: sanitizeTerminalLine(
      `Unknown vcs "${unknownVcsId}" • falling back to ${fallbackVcsId}. ` +
        "Install an extension that registers it, or fix the id in Hunk config.",
    ),
  };
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
