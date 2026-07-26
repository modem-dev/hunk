/**
 * The public contract behind `hunkdiff/extension`.
 *
 * This module imports nothing on purpose. Whole-program declaration emission
 * ships every file the entry point reaches, so any import here would publish a
 * slice of Hunk's internals — Pierre's diff types, the git/jj/sl backends —
 * into the package an extension author typechecks against. Keeping the contract
 * self-contained keeps the shipped `.d.ts` tree to this file and its barrel.
 *
 * Shapes internal code genuinely shares with extensions (agent sidecar records,
 * theme config tables) are declared here once and re-exported from their
 * internal homes, so there is still one definition per concept. Shapes that
 * cannot be shared because they reference the diff engine (`DiffFile`,
 * `VcsAdapter`) get a purpose-built public view here, narrow enough that the
 * host can accept it wherever it accepts the internal type.
 */

/**
 * Version of the extension API surface handed to extension factories.
 *
 * Extensions can branch on `hunk.apiVersion` so a newer Hunk can keep loading
 * older extensions without guessing at their expectations.
 */
export const HUNK_EXTENSION_API_VERSION = 1;
export type HunkExtensionApiVersion = typeof HUNK_EXTENSION_API_VERSION;

export type ExtensionNotifyType = "info" | "warning" | "error";

/** Capability object handed to every extension event handler and transform. */
export interface ExtensionContext {
  cwd: string;
  notify(message: string, type?: ExtensionNotifyType): void;
}

/* -------------------------------------------------------------------------- */
/* Agent sidecar records                                                       */
/* -------------------------------------------------------------------------- */

/** One agent-authored note attached to a file, optionally scoped to a line range. */
export interface AgentAnnotation {
  id?: string;
  oldRange?: [number, number];
  newRange?: [number, number];
  summary: string;
  rationale?: string;
  /** Optional STML markup rendered as the note body in place of summary/rationale text. */
  markup?: string;
  tags?: string[];
  confidence?: "low" | "medium" | "high";
  source?: string;
  title?: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  editable?: boolean;
}

/** Every agent annotation that belongs to one reviewed file. */
export interface AgentFileContext {
  path: string;
  summary?: string;
  annotations: AgentAnnotation[];
}

/* -------------------------------------------------------------------------- */
/* Changeset view                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One reviewed file, as extensions see it.
 *
 * Structurally a subset of Hunk's internal `DiffFile`, so the internal value
 * flows into a transform without conversion. Fields the review UI derives for
 * itself are omitted rather than frozen into the contract.
 */
export interface ExtensionDiffFile {
  id: string;
  path: string;
  previousPath?: string;
  patch: string;
  language?: string;
  stats: {
    additions: number;
    deletions: number;
  };
  /**
   * Parsed diff metadata owned by Hunk's diff engine.
   *
   * Opaque on purpose: its shape is not part of the extension contract, and it
   * is what the renderer draws from. Carry it through untouched — spreading a
   * file (`{ ...file, path }`) preserves it. A file returned without usable
   * metadata is rejected, and the previous changeset is kept.
   */
  metadata: unknown;
  agent: AgentFileContext | null;
  isUntracked?: boolean;
  isBinary?: boolean;
  isTooLarge?: boolean;
}

/** One reviewed changeset, as extensions see it. */
export interface ExtensionChangeset {
  id: string;
  sourceLabel: string;
  title: string;
  summary?: string;
  agentSummary?: string;
  files: ExtensionDiffFile[];
}

/** Rewrite a loaded changeset before it reaches the review UI. */
export type ChangesetTransform = (
  changeset: ExtensionChangeset,
  ctx: ExtensionContext,
) => ExtensionChangeset | Promise<ExtensionChangeset>;

/* -------------------------------------------------------------------------- */
/* Theme config tables                                                         */
/* -------------------------------------------------------------------------- */

/** @deprecated Use exact TextMate selectors through CustomSyntaxScopesConfig instead. */
export interface CustomSyntaxColorsConfig {
  default?: string;
  keyword?: string;
  string?: string;
  comment?: string;
  number?: string;
  function?: string;
  property?: string;
  type?: string;
  variable?: string;
  operator?: string;
  punctuation?: string;
}

/** Exact Shiki/TextMate selector-to-hex-color overrides, preserved in declaration order. */
export type CustomSyntaxScopesConfig = Record<string, string>;

/** Every color slot a `[themes.<id>]` table (or `registerTheme` call) may set. */
export interface CustomThemeConfig {
  base?: string;
  label?: string;
  background?: string;
  panel?: string;
  panelAlt?: string;
  border?: string;
  accent?: string;
  accentMuted?: string;
  text?: string;
  muted?: string;
  addedBg?: string;
  removedBg?: string;
  movedAddedBg?: string;
  movedRemovedBg?: string;
  contextBg?: string;
  addedContentBg?: string;
  removedContentBg?: string;
  contextContentBg?: string;
  addedSignColor?: string;
  removedSignColor?: string;
  lineNumberBg?: string;
  lineNumberFg?: string;
  selectedHunk?: string;
  badgeAdded?: string;
  badgeRemoved?: string;
  badgeNeutral?: string;
  fileNew?: string;
  fileDeleted?: string;
  fileRenamed?: string;
  fileModified?: string;
  fileUntracked?: string;
  noteBorder?: string;
  noteBackground?: string;
  noteTitleBackground?: string;
  noteTitleText?: string;
  /** @deprecated Use syntaxScopes. This compatibility field will be removed next major. */
  syntax?: CustomSyntaxColorsConfig;
  syntaxScopes?: CustomSyntaxScopesConfig;
}

/**
 * One custom theme together with the id it is selected by.
 *
 * Config tables (`[custom_theme]`, `[themes.<id>]`) and extension
 * `registerTheme` calls all normalize into this one shape, so the theme model
 * downstream never has to know where a theme came from.
 */
export interface NamedCustomThemeConfig extends CustomThemeConfig {
  id: string;
}

/**
 * A theme contributed by an extension.
 *
 * Identical to a `[themes.<id>]` config table, so config-defined and
 * extension-contributed themes share one validation and merge path.
 */
export type ExtensionThemeConfig = NamedCustomThemeConfig;

/* -------------------------------------------------------------------------- */
/* VCS adapters                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Detection priority of Hunk's core Git backend.
 *
 * Adapters are consulted highest priority first, so this is the baseline every
 * other backend positions itself around. Hunk's bundled Jujutsu and Sapling
 * backends deliberately register above it: a colocated jj or Sapling checkout
 * also contains a `.git` directory, and must not be reviewed as plain Git.
 */
export const HUNK_CORE_VCS_DETECTION_PRIORITY = 0;

/**
 * Detection priority an adapter gets when it does not choose one.
 *
 * Below Git, so installing a backend never silently changes how an existing
 * repository is reviewed. Set `detectionPriority` explicitly to sort above a
 * built-in backend — it is your machine, so it is your call.
 */
export const HUNK_DEFAULT_VCS_DETECTION_PRIORITY = -100;

/** What an adapter reports when it recognizes a directory. */
export interface ExtensionVcsDetection {
  id: string;
  repoRoot: string;
}

/** Ambient information an operation may need to shell out. */
export interface ExtensionVcsLoadContext {
  cwd: string;
  gitExecutable?: string;
}

/**
 * The resolved review options an adapter may need to honor.
 *
 * A deliberately narrow window onto the same options object Hunk resolves from
 * flags and config: an adapter sees the choices that change what a review
 * *contains*, not the ones that decide how it is drawn.
 */
export interface ExtensionVcsReviewOptions {
  /** True when the user asked for tracked changes only (`--exclude-untracked`). */
  excludeUntracked?: boolean;
}

/** Working-tree review request, as extension adapters receive it. */
export interface ExtensionVcsDiffInput {
  kind: "vcs";
  range?: string;
  staged: boolean;
  pathspecs?: string[];
  options: ExtensionVcsReviewOptions;
}

/** Single-revision review request, as extension adapters receive it. */
export interface ExtensionVcsShowInput {
  kind: "show";
  ref?: string;
  pathspecs?: string[];
  options: ExtensionVcsReviewOptions;
}

/** Stash review request, as extension adapters receive it. */
export interface ExtensionVcsStashShowInput {
  kind: "stash-show";
  ref?: string;
  options: ExtensionVcsReviewOptions;
}

/** The patch text one operation produced, plus how to label it in the UI. */
export interface ExtensionVcsPatchResult {
  repoRoot: string;
  sourceLabel: string;
  title: string;
  patchText: string;
  /**
   * Untracked files to review beside the patch, as repo-root-relative paths.
   *
   * Hunk synthesizes each one into an added-file diff from its current
   * contents, skipping binaries and files too large to render, so an adapter
   * only has to list the paths its VCS reports as untracked instead of
   * fabricating patch text that VCS would never produce.
   */
  untrackedPaths?: string[];
}

/* -------------------------------------------------------------------------- */
/* Watch capability                                                            */
/* -------------------------------------------------------------------------- */

/** What kind of state one watch target holds, used to group and explain targets. */
export type ExtensionVcsWatchTargetSource = "content" | "sidecar" | "worktree" | "vcs-metadata";

/** Watch exactly these files inside one directory. */
export interface ExtensionVcsDirectoryEntriesWatchTarget {
  kind: "directory-entries";
  directory: string;
  entries: string[];
  sources: ExtensionVcsWatchTargetSource[];
}

/** Watch one directory recursively, minus the subtrees listed as noise. */
export interface ExtensionVcsDirectoryTreeWatchTarget {
  kind: "directory-tree";
  directory: string;
  ignoredRoots: string[];
  sources: ExtensionVcsWatchTargetSource[];
}

export type ExtensionVcsWatchTarget =
  | ExtensionVcsDirectoryEntriesWatchTarget
  | ExtensionVcsDirectoryTreeWatchTarget;

/**
 * Where `--watch` looks for changes to the state one operation reviews.
 *
 * `hybrid` promises the targets cover that state, so Hunk reacts to filesystem
 * events and only recomputes the signature when one fires. `poll-only` says
 * they do not, and is also what an adapter without a `watchPlan` gets: Hunk
 * then polls `watchSignature` on a timer, which still works but costs a
 * subprocess per tick.
 */
export interface ExtensionVcsWatchPlan {
  coverage: "hybrid" | "poll-only";
  targets: ExtensionVcsWatchTarget[];
}

/** One review operation an adapter implements. */
export interface ExtensionVcsOperation<Input> {
  load(input: Input, context: ExtensionVcsLoadContext): Promise<ExtensionVcsPatchResult>;
  /** Optional cheap fingerprint of the reviewed state, for `--watch`. */
  watchSignature?: (input: Input, context: ExtensionVcsLoadContext) => string;
  /**
   * Optional filesystem targets `--watch` observes instead of polling.
   *
   * Leaving this out keeps the polling fallback, so it is a performance
   * refinement rather than a requirement for watch support.
   */
  watchPlan?: (input: Input, context: ExtensionVcsLoadContext) => ExtensionVcsWatchPlan;
}

/**
 * The review operations one adapter supports.
 *
 * Every entry is optional: an operation an adapter leaves out produces a clear
 * "not supported" error for that command instead of a crash.
 */
export interface ExtensionVcsOperations {
  "working-tree-diff"?: ExtensionVcsOperation<ExtensionVcsDiffInput>;
  "revision-show"?: ExtensionVcsOperation<ExtensionVcsShowInput>;
  "stash-show"?: ExtensionVcsOperation<ExtensionVcsStashShowInput>;
}

/**
 * An additional VCS backend contributed by an extension.
 *
 * Narrower than Hunk's internal adapter type on purpose, but structurally
 * compatible with it: the host fills in the operation map it needs and uses the
 * adapter directly.
 */
export interface ExtensionVcsAdapter {
  id: string;
  name: string;
  detect(cwd: string): ExtensionVcsDetection | null;
  operations?: ExtensionVcsOperations;
  /**
   * Where this adapter sits in detection order; higher is consulted first.
   *
   * Detection still prefers the nearest checkout, so priority only decides
   * which backend wins when several recognize the *same* directory — the
   * colocated case, where one working copy carries two sets of markers.
   * Defaults to `HUNK_DEFAULT_VCS_DETECTION_PRIORITY` (below Git), and equal
   * priorities fall back to registration order.
   */
  detectionPriority?: number;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle events                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Why a session reload happened.
 *
 * `watch` is a file/VCS change Hunk noticed itself, `daemon` is an agent
 * command routed through the session broker, and `manual` is a user action
 * (the refresh key, or reloading after granting repo-extension trust).
 */
export type SessionReloadReason = "watch" | "daemon" | "manual";

/** Payload delivered with each lifecycle event, keyed by event name. */
export interface ExtensionEventPayloads {
  startup: { cwd: string };
  changeset_loaded: { changeset: ExtensionChangeset };
  selection_changed: { fileId: string | null; hunkIndex: number | null };
  session_reload: { changeset: ExtensionChangeset; reason: SessionReloadReason };
  shutdown: Record<string, never>;
}

export type ExtensionEventName = keyof ExtensionEventPayloads;

export type ExtensionEventHandler<Event extends ExtensionEventName = ExtensionEventName> = (
  payload: ExtensionEventPayloads[Event],
  ctx: ExtensionContext,
) => void | Promise<void>;

/* -------------------------------------------------------------------------- */
/* The capability object                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The whole capability surface an extension is granted.
 *
 * Registration calls are only valid while the extension factory is running;
 * the host invalidates the object afterwards so deferred callbacks cannot
 * mutate the registry mid-session.
 */
export interface HunkExtensionAPI {
  readonly apiVersion: HunkExtensionApiVersion;
  /** Contribute one selectable theme. */
  registerTheme(theme: ExtensionThemeConfig): void;
  /** Map one file extension (with or without a leading dot) to a highlight language. */
  registerFileLanguage(extension: string, language: string): void;
  /** Contribute one additional VCS backend. */
  registerVcsAdapter(adapter: ExtensionVcsAdapter): void;
  /** Rewrite every loaded changeset before review. */
  transformChangeset(fn: ChangesetTransform): void;
  /** Subscribe to one Hunk lifecycle event. */
  on<Event extends ExtensionEventName>(event: Event, handler: ExtensionEventHandler<Event>): void;
  /**
   * This extension's own `[extension.<id>]` config table.
   *
   * Layered user-then-repo, so a repository under review can influence these
   * values. Treat them as untrusted input for anything exec-adjacent.
   */
  readonly config: Record<string, unknown>;
  /** Record a diagnostic line; collected per extension instead of written to the terminal. */
  log(message: string): void;
}

/** Default export every extension entry file must provide. */
export type ExtensionFactory = (hunk: HunkExtensionAPI) => void | Promise<void>;
