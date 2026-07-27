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
/* User-facing errors                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The `name` Hunk recognizes as "this failure is meant for the user".
 *
 * Detection is structural rather than `instanceof`, so an extension bundled
 * with its own copy of this class — or one written in plain JavaScript that
 * just sets `name` and `suggestions` — still gets the same treatment.
 */
export const HUNK_EXTENSION_USER_ERROR_NAME = "HunkExtensionUserError";

export interface HunkExtensionUserErrorOptions {
  /** Concrete next steps shown under the message, one per line. */
  suggestions?: string[];
}

/**
 * A failure caused by how Hunk was invoked rather than by a bug.
 *
 * Throw this from an adapter operation when the user can fix the problem
 * themselves — no repository here, an unresolvable ref, a missing binary. Hunk
 * prints the message without a stack trace and lists the suggestions beneath
 * it; anything else is reported as an unexpected error.
 *
 * ```ts
 * throw new HunkExtensionUserError("`hunk stash show` is not supported by Mercurial.", {
 *   suggestions: ["Use `hunk show <rev>` to review a commit instead."],
 * });
 * ```
 */
export class HunkExtensionUserError extends Error {
  readonly suggestions: string[];

  constructor(message: string, { suggestions = [] }: HunkExtensionUserErrorOptions = {}) {
    super(message);
    this.name = HUNK_EXTENSION_USER_ERROR_NAME;
    this.suggestions = [...suggestions];
  }
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
  /**
   * How this file changed, using the same vocabulary VCS adapters report.
   *
   * Present on the read-only views Hunk hands outward (event payloads, sidebar
   * props); a transform that synthesizes a file may omit it, and the file is
   * treated as an ordinary `"change"`.
   */
  changeType?: ExtensionVcsFileChangeType;
  /** True when `stats` were counted from a partial read and undercount the file. */
  statsTruncated?: boolean;
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
 * Detection priority of Hunk's Git backend.
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
  /**
   * True when the user asked for moved lines to be detected (`--color-moved`).
   *
   * Hunk reads move classes back out of the patch itself: emit ANSI-colored
   * diff text that paints moved additions cyan and moved deletions magenta —
   * what `git diff --color-moved` produces — and those lines render as moved.
   * A backend with no notion of moved lines can ignore this.
   */
  colorMoved?: boolean;
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

/* -------------------------------------------------------------------------- */
/* Exact file sources                                                          */
/* -------------------------------------------------------------------------- */

/** How one reviewed file changed. */
export type ExtensionVcsFileChangeType =
  | "change"
  | "rename-pure"
  | "rename-changed"
  | "new"
  | "deleted";

/** Which side of a change a source read asks for. */
export type ExtensionVcsFileSide = "old" | "new";

/** The one file and side Hunk wants full source text for. */
export interface ExtensionVcsFileSourceRequest {
  /** Repo-root-relative path of the file under review. */
  path: string;
  /** The file's former path, when this change renamed it. */
  previousPath?: string;
  changeType: ExtensionVcsFileChangeType;
  isUntracked: boolean;
  /**
   * The side being read.
   *
   * `old` is the file before the change and `new` after it, so a `new` file has
   * no old side and a `deleted` one has no new side.
   */
  side: ExtensionVcsFileSide;
}

/**
 * Read one reviewed file's full text on one side.
 *
 * A patch only carries the lines that changed plus a little context, so this is
 * what lets Hunk expand context beyond the hunk, highlight against the real
 * file, and word-diff accurately. Return `null` when the side has no content —
 * a missing path, or the absent side of an added or deleted file — rather than
 * throwing.
 *
 * Hunk calls this at most once per file and side and caches what it resolves,
 * so the reader does not need its own cache. It is never called for a file the
 * diff reports as binary. Resolve the revisions the read needs while your
 * operation is loading and close over them: the request describes the file, not
 * the commits, because only the adapter knows how to name them.
 */
export type ExtensionVcsFileSourceReader = (
  request: ExtensionVcsFileSourceRequest,
) => Promise<string | null>;

/* -------------------------------------------------------------------------- */
/* Extra reviewed files                                                        */
/* -------------------------------------------------------------------------- */

/** Line counts for one reviewed file. */
export interface ExtensionVcsFileStats {
  additions: number;
  deletions: number;
}

/** One file whose own patch text an adapter produced separately. */
export interface ExtensionVcsExtraPatchFile {
  kind: "patch";
  /** Repo-root-relative path. Hunk labels the file with this, not the patch header. */
  path: string;
  previousPath?: string;
  /** Unified diff text covering exactly this one file. */
  patchText: string;
  isUntracked?: boolean;
}

/** Why a file is listed without a rendered diff. */
export type ExtensionVcsSkippedFileReason = "too-large";

/**
 * One file Hunk should list but not render.
 *
 * Reviewing a multi-hundred-megabyte generated file costs more than it is
 * worth, so an adapter can report the file, its size, and why it was skipped
 * instead of producing a patch nothing will read.
 */
export interface ExtensionVcsSkippedFile {
  kind: "skipped";
  path: string;
  previousPath?: string;
  reason: ExtensionVcsSkippedFileReason;
  /** Defaults to `"change"`. */
  changeType?: ExtensionVcsFileChangeType;
  /** Line counts to show in the sidebar; derived as zero when omitted. */
  stats?: ExtensionVcsFileStats;
  /** True when `stats` were counted from a partial read and undercount the file. */
  statsTruncated?: boolean;
  isUntracked?: boolean;
}

/**
 * One reviewed file that is not part of the operation's main patch text.
 *
 * Hunk builds the diff model for each entry itself, so an adapter describes the
 * file rather than assembling one.
 */
export type ExtensionVcsExtraFile = ExtensionVcsExtraPatchFile | ExtensionVcsSkippedFile;

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
   *
   * Use `extraFiles` instead when your VCS produces better patch text for an
   * unknown file than a plain read of the working copy would.
   */
  untrackedPaths?: string[];
  /**
   * Exact old/new file contents for the files in this result.
   *
   * Optional: without it Hunk falls back to the content the patch itself
   * carries, which renders the same diff with less context available.
   */
  readFileSource?: ExtensionVcsFileSourceReader;
  /**
   * Files to review beside `patchText`, in the order they should appear.
   *
   * Each entry is either its own one-file patch or a skipped placeholder.
   * `readFileSource` covers the patch entries too; skipped entries have no
   * content to read.
   */
  extraFiles?: ExtensionVcsExtraFile[];
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
/* Sidebar views                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Theme tokens a custom sidebar renders with.
 *
 * A curated slice of the active theme rather than the whole internal theme
 * model: every value is a hex color string (or the appearance flag), stable to
 * build UI against, and updated live when the user switches themes. Field
 * names match the `[themes.<id>]` config table where a concept exists there.
 */
export interface ExtensionSidebarTheme {
  appearance: "light" | "dark";
  background: string;
  panel: string;
  panelAlt: string;
  border: string;
  accent: string;
  accentMuted: string;
  text: string;
  muted: string;
  /** Background highlighting the selected row or hunk. */
  selectedHunk: string;
  badgeAdded: string;
  badgeRemoved: string;
  badgeNeutral: string;
  fileNew: string;
  fileDeleted: string;
  fileRenamed: string;
  fileModified: string;
  fileUntracked: string;
  /** Accent for agent-note affordances, like the note-count badge on a file row. */
  noteBorder: string;
}

/**
 * Navigation a custom sidebar can trigger, exactly as the built-in one does.
 *
 * Every action routes through the same review controller the built-in sidebar
 * and keyboard shortcuts use, so the main review stream scrolls, selection
 * updates, and the `selection_changed` lifecycle event fires identically —
 * other extensions cannot tell a custom sidebar drove the navigation. Actions
 * stay valid for as long as the component is mounted; a failure inside one is
 * reported as a warning naming the extension instead of thrown back into the
 * component.
 */
export interface ExtensionSidebarActions {
  /** Jump the review stream to one file, like clicking its sidebar row. */
  selectFile(fileId: string): void;
  /** Jump the review stream to one hunk of one file. */
  selectHunk(fileId: string, hunkIndex: number): void;
  /** Show one toast, attributed to the owning extension. */
  notify(message: string, type?: ExtensionNotifyType): void;
}

/** Everything a custom sidebar component receives, refreshed as the app changes. */
export interface ExtensionSidebarViewProps {
  /**
   * The reviewed files currently visible, in review-stream order.
   *
   * Read-only frozen views, filtered the way the built-in sidebar is: the
   * app's file filter applies before the list reaches the component.
   */
  files: ExtensionDiffFile[];
  selectedFileId: string | null;
  selectedHunkIndex: number | null;
  /** Terminal columns the sidebar pane occupies; height comes from flex layout. */
  width: number;
  theme: ExtensionSidebarTheme;
  actions: ExtensionSidebarActions;
}

/**
 * A custom sidebar component.
 *
 * This is a plain React function component rendered inside Hunk's own tree —
 * import `react` normally (Hunk serves its own instance to extension files, so
 * hooks work; never bundle a copy of React into an extension) and return
 * OpenTUI elements (`box`, `text`, `scrollbox`, ...). The return type is
 * opaque here only because this module publishes no React types; annotate the
 * component with your own `@types/react` and it satisfies this shape.
 */
export type ExtensionSidebarComponent = (props: ExtensionSidebarViewProps) => unknown;

/** A sidebar replacement contributed by an extension. */
export interface ExtensionSidebarView {
  /** Identifies the view in diagnostics and future config selection. */
  id: string;
  component: ExtensionSidebarComponent;
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
  /**
   * Replace the file-navigation sidebar with a custom component.
   *
   * One sidebar view is active per session: the first registration in load
   * order wins, and later ones are skipped with a warning. A view that throws
   * while rendering is reported and Hunk falls back to the built-in sidebar.
   */
  registerSidebarView(view: ExtensionSidebarView): void;
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
