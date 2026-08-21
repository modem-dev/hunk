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
export const HUNK_EXTENSION_API_VERSION = 7;
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
 * One hunk of a reviewed file, summarized for extensions.
 *
 * A stable public view of the parsed diff: enough to build a hunk list, a
 * progress checklist, or an annotation navigator without reaching into the
 * opaque `metadata`. The shape matches what the agent session surface reports
 * for hunks, so the two external views of a review never disagree.
 */
export interface ExtensionDiffHunk {
  /**
   * The hunk's position within its file, in review-stream render order.
   *
   * This is the same index `selectedHunkIndex` reports and
   * `actions.selectHunk(fileId, hunkIndex)` accepts, so a hunk list built from
   * these summaries can highlight and drive the selection directly.
   */
  index: number;
  /** The unified-diff `@@` header, including any trailing context text. */
  header: string;
  /**
   * Inclusive old-side line span the hunk covers, context lines included.
   *
   * Omitted when the hunk carries no usable line numbers — which real parsed
   * diffs always do; only a transform-synthesized hunk can lack them.
   */
  oldRange?: [number, number];
  /** Inclusive new-side line span the hunk covers, context lines included. */
  newRange?: [number, number];
}

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
   * metadata is rejected, and the previous changeset is kept. On the read-only
   * views Hunk hands outward (event payloads, pane props, a command's
   * selection) it is guarded like the rest of the view: reads pass through,
   * writes into it are refused.
   */
  metadata: unknown;
  /**
   * How this file changed, using the same vocabulary VCS adapters report.
   *
   * Present on the read-only views Hunk hands outward (event payloads, pane
   * props); a transform that synthesizes a file may omit it, and the file is
   * treated as an ordinary `"change"`.
   */
  changeType?: ExtensionVcsFileChangeType;
  /** True when `stats` were counted from a partial read and undercount the file. */
  statsTruncated?: boolean;
  /**
   * Summaries of the hunks the diff engine parsed from this file, in render
   * order — empty for a file with nothing to select (binary, skipped).
   *
   * Like `changeType`, this is filled on the read-only views Hunk hands
   * outward (event payloads, pane props, a command's selection). It is
   * derived from `metadata` at that boundary, so a transform neither receives
   * nor needs to produce it — a `hunks` value on a transform's returned file
   * is ignored in favor of what the metadata actually parses to.
   */
  hunks?: readonly ExtensionDiffHunk[];
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
/* Terminal key events                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The parts of a terminal key event chord matching reads.
 *
 * Structural on purpose: any object carrying these fields works, including
 * OpenTUI's `KeyEvent` and the synthetic events Hunk probes matchers with.
 */
export interface ExtensionKeyEvent {
  /** Normalized key name, e.g. `"g"`, `"pageup"`, `"space"`. */
  name?: string;
  /** The characters the terminal reported, e.g. `"G"`, `"{"`. */
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  /** The alt/option modifier. */
  option?: boolean;
  shift?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Session keyboard modes                                                      */
/* -------------------------------------------------------------------------- */

/** What a session keyboard mode did with one key. */
export type ExtensionKeyboardModeKeyResult = "handled" | "pass" | "exit";

/** Renderer-free capabilities available while a session keyboard mode runs. */
export interface ExtensionKeyboardModeContext extends ExtensionContext {
  /** Live access to explicitly public built-in Hunk commands. */
  readonly commands: ExtensionCommandControls;
  /** Invalidate prepared line highlights, e.g. after a prompt submit changes them. */
  readonly highlights: ExtensionLineHighlightControls;
  /**
   * Controls scoped to this extension and activation.
   *
   * They become inert when the activation exits, so retained callbacks cannot inspect, stop, or
   * replace a later mode. A deliberate replacement may be entered while `onKey` is running;
   * ownership changes return `false` while `onEnter` or `onExit` is running.
   */
  readonly keyboardModes: ExtensionKeyboardModeControls;
}

/**
 * One deliberately activated, session-scoped keyboard interpretation.
 *
 * Modes receive keys after host modal/focused surfaces and interactive file
 * views, but before ordinary app commands. They are synchronous because their
 * return value decides ownership of the current terminal key.
 */
export interface ExtensionKeyboardMode {
  /** Identifies the mode within its extension; `<extensionId>:<id>` globally. */
  id: string;
  /** Human-readable label shown while the mode is active. */
  title: string;
  /** Decide whether to consume, pass, or consume-and-exit for one key. */
  onKey(key: ExtensionKeyEvent, ctx: ExtensionKeyboardModeContext): ExtensionKeyboardModeKeyResult;
  /** Runs once before the first key reaches the mode. Must return synchronously; cannot change ownership. */
  onEnter?(ctx: ExtensionKeyboardModeContext): void;
  /** Runs exactly once on every exit path. Must return synchronously; cannot change ownership. */
  onExit?(ctx: ExtensionKeyboardModeContext): void;
}

/* -------------------------------------------------------------------------- */
/* File views                                                                  */
/* -------------------------------------------------------------------------- */

/** A side of a reviewed source document. */
export type ExtensionFileSide = "old" | "new";

/** One added or removed source-line range, inclusive on both ends. */
export interface ExtensionFileChangeRange {
  readonly hunkIndex: number;
  /** Added ranges belong to the new side; removed ranges belong to the old side. */
  readonly kind: "added" | "removed";
  readonly range: readonly [number, number];
}

/** One exact-source range associated with a host-owned file-view row. */
export interface ExtensionFileViewSourceRange {
  readonly side: ExtensionFileSide;
  /** Inclusive, one-based source line range. */
  readonly range: readonly [number, number];
}

/** One symbolic run in a host-rendered file-view row. */
export interface ExtensionFileViewSpan {
  readonly text: string;
  /** A generic semantic color the host maps to its active terminal theme at paint time. */
  readonly tone?: "muted" | "accent" | "accent-muted" | "syntax" | "added" | "removed";
  /** Theme-independent terminal emphasis. */
  readonly attributes?: readonly ("bold" | "italic" | "underline" | "strikethrough")[];
}

/** Bounded paint-only props handed to a custom file-view row component. */
export interface ExtensionFileViewRowComponentProps {
  /** Available terminal columns inside the host-owned row wrapper. */
  readonly width: number;
  /** Fixed terminal rows reserved by the host. */
  readonly height: number;
  /** Whether this row falls inside the selected hunk bounds. */
  readonly selected: boolean;
  /** Zero-based position in the validated file-view layout. */
  readonly rowIndex: number;
  /** Live paint-only semantic colors; theme changes never invalidate layout geometry. */
  readonly theme: ExtensionPaintTheme;
}

/** A row in a host-owned, terminal-safe file-view layout. */
export interface ExtensionFileViewRow {
  /** A stable identifier within this layout result. */
  readonly id: string;
  /**
   * Symbolic host-rendered content, also used if a custom component fails.
   * Component fallback is clipped to the same declared fixed height as the painter.
   */
  readonly spans: readonly ExtensionFileViewSpan[];
  /**
   * Exact-source ranges this row presents. Hunk validates unambiguous, in-bounds mappings and
   * uses them to place host-rendered inline notes; unresolved notes keep the whole file on raw diff.
   */
  readonly sourceRanges?: readonly ExtensionFileViewSourceRange[];
  /**
   * Experimental fixed-height React/OpenTUI painter, clipped inside host-owned geometry.
   * Height and render are one descriptor so a typed layout cannot declare either alone.
   */
  readonly component?: {
    readonly height: number;
    readonly render: (props: ExtensionFileViewRowComponentProps) => unknown;
  };
}

/** The deterministic, symbolic layout returned by a file-view extension. */
export interface ExtensionFileViewLayout {
  readonly rows: readonly ExtensionFileViewRow[];
  /** Inclusive row extents ordered to correspond to `input.file.hunks`. */
  readonly hunkRows: readonly {
    readonly startRow: number;
    readonly endRow: number;
  }[];
}

/** Immutable input a file-view renderer receives for one file. */
export interface ExtensionFileViewInput {
  readonly file: ExtensionDiffFile;
  /** Available terminal columns. Layout must be deterministic for this width. */
  readonly width: number;
  /** Aborts when a resize, reload, selection change, or extension reload supersedes this work. */
  readonly signal: AbortSignal;
  readonly changes: readonly ExtensionFileChangeRange[];
  /**
   * Read one exact full source document. Reads are lazy and deduplicated per
   * file and side for this layout request. A missing side, unavailable source,
   * read failure, or resource-limit refusal resolves to `null`.
   *
   * Patch text is already available as `input.file.patch`; it is deliberately
   * not presented as a document because a patch is not an exact source file.
   */
  readDocument(side: ExtensionFileSide): Promise<string | null>;
}

/** What an interactive file view's key handler did with one key. */
export type ExtensionFileViewModeKeyResult = "handled" | "pass" | "exit";

/** What a mode key handler receives alongside each key. */
export interface ExtensionFileViewModeContext extends ExtensionContext {
  /** The file the view is presenting, as the mode's keys act on it. */
  readonly file: ExtensionDiffFile;
  /** Host-owned presentation controls, including `refresh` for redraws. */
  readonly fileViews: ExtensionFileViewControls;
}

/**
 * An opt-in interactive mode for one registered file view.
 *
 * A file view is otherwise a pure presentation: Hunk owns the keyboard, and a
 * view that wants fold controls, a picker, or a cursor has no way to hear
 * about a keypress. A mode is the opt-in — entered deliberately through
 * `fileViews.enterMode`, never on its own — during which keys reach `onKey`
 * before Hunk's command table. Modes are session-scoped: nothing persists.
 *
 * Only one file-view mode is active at a time. When it is the highest-priority
 * input owner, Escape exits it; every exit path runs `onExit` exactly once.
 */
export interface ExtensionFileViewMode {
  /**
   * Decide what happens to one key, synchronously.
   *
   * The return value *is* the routing decision, so it cannot be awaited:
   * `"handled"` consumes the key, `"pass"` declines it (routing then continues
   * through any active session keyboard mode, the command table, and focused
   * scrolling), and `"exit"` consumes the key and leaves the mode. Start async work here and
   * report it afterwards through `ctx.notify` or `ctx.fileViews.refresh`.
   *
   * Every key the app's modal surfaces do not claim arrives — including plain
   * printable characters, which would otherwise run whatever command is bound
   * to them. When this mode owns input, Escape is the one exception: it is
   * host-owned and exits the mode without ever reaching this handler.
   *
   * A throw is contained: Hunk warns naming the extension, exits the mode, and
   * the review keeps working.
   */
  onKey(key: ExtensionKeyEvent, ctx: ExtensionFileViewModeContext): ExtensionFileViewModeKeyResult;
  /** Runs once when the mode is entered, before any key reaches `onKey`. Must return synchronously. */
  onEnter?(ctx: ExtensionFileViewModeContext): void;
  /** Runs synchronously on every exit — key result, Escape, host auto-exit, or a contained throw. */
  onExit?(ctx: ExtensionFileViewModeContext): void;
}

/** A host-rendered alternative presentation for an individual file in the review stream. */
export interface ExtensionFileView {
  id: string;
  title: string;
  matches(file: ExtensionDiffFile): boolean;
  /** Return `null` whenever the view cannot safely present this file; Hunk renders raw diff. */
  layout(
    input: ExtensionFileViewInput,
  ): ExtensionFileViewLayout | null | Promise<ExtensionFileViewLayout | null>;
  /**
   * Opt this view into receiving keys while its mode is active.
   *
   * Registering a mode changes nothing on its own; a command must call
   * `ctx.fileViews.enterMode(viewId)` to start it.
   */
  mode?: ExtensionFileViewMode;
}

/* -------------------------------------------------------------------------- */
/* Line highlights                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What one line-highlight mark means.
 *
 * Tones rather than colors on purpose: a background is only visible resolved
 * against the background it sits on, which differs per line kind (added,
 * removed, context) and per theme. The host owns that resolution, applying the
 * same minimum-contrast guarantee its own word-diff emphasis uses, so a mark
 * is never invisible on a green line. A transparent cell has no color to blend
 * against, so the host resolves the tint against the background it assumes the
 * terminal shows. `"current"` is the emphatic variant of `"match"` — search
 * uses it for the match the user is on.
 */
export type ExtensionLineHighlightTone = "match" | "current" | "info" | "warning" | "error";

/**
 * One marked character range inside one diff line.
 *
 * Addressed by source coordinates — `(side, line, range)` — rather than by
 * rendered rows, so a mark survives split vs stack layout, line wrapping,
 * horizontal scrolling, and collapsed-context expansion without the extension
 * ever learning Hunk's row model.
 */
export interface ExtensionLineHighlight {
  /** Which side the line belongs to. A context line may be addressed by either side. */
  side: ExtensionFileSide;
  /** 1-based source line number on that side. */
  line: number;
  /**
   * `[start, end)` UTF-16 code-unit offsets into the line's raw source text —
   * the text as it appears in `ExtensionDiffFile.patch` or a `readDocument`
   * result, before Hunk's tab expansion or terminal sanitization. This is what
   * `String.prototype.indexOf` and `RegExp.exec` return, so scanning the patch
   * yields usable offsets directly. The host maps them to terminal columns and
   * widens them to grapheme-cluster boundaries, so an offset inside an emoji or
   * a CJK character marks the whole visible glyph rather than tearing it.
   *
   * Marks paint terminal columns, so a range covering only characters that
   * occupy none — bidi controls, zero-width spaces and joiners — paints
   * nothing.
   */
  range: readonly [number, number];
  /** What the mark means. Defaults to `"match"`. */
  tone?: ExtensionLineHighlightTone;
}

/** The input one line-highlight request receives. */
export interface ExtensionLineHighlightInput {
  readonly file: ExtensionDiffFile;
  /** Aborted when the result can no longer be used (reload, supersession, timeout). */
  readonly signal: AbortSignal;
  /**
   * Read one side's complete source document, exactly like
   * `ExtensionFileViewInput.readDocument`. Resolves `null` whenever the side
   * cannot be read. Patch text is already at hand as `file.patch`.
   */
  readDocument(side: ExtensionFileSide): Promise<string | null>;
}

/**
 * A contributor of character-range marks painted onto diff lines.
 *
 * `highlight` is a pure derivation of the file plus an invalidation epoch: the
 * host calls it per reviewed file, caches the result, and re-calls it only
 * when `ctx.highlights.refresh` bumps the epoch or the review reloads. There
 * is no host-held mark state to go stale. Highlights are paint-only — they
 * change colors, never text or geometry — so the failure mode of a throwing,
 * rejecting, or timed-out `highlight` is "no marks for that file" and nothing
 * else.
 *
 * Marks whose lines never render (a line inside a collapsed gap, a line the
 * patch does not contain) are silently invisible rather than errors: the mark
 * is valid, the review just is not showing that line.
 */
export interface ExtensionLineHighlighter {
  /** Identifies the highlighter within its extension; `<extensionId>:<id>` globally. */
  id: string;
  /** Return every mark for one file, or `null`/empty for none. */
  highlight(
    input: ExtensionLineHighlightInput,
  ): readonly ExtensionLineHighlight[] | null | Promise<readonly ExtensionLineHighlight[] | null>;
}

/** Invalidate prepared line highlights from a command or keyboard-mode handler. */
export interface ExtensionLineHighlightControls {
  /**
   * Mark this highlighter's prepared results stale so `highlight` runs again.
   *
   * Without `fileId` every file's marks for this highlighter are re-derived;
   * with one, only that file's. A `fileId` no reviewed file carries
   * invalidates nothing and warns about nothing: ids can race a reload. Bare
   * ids address the calling extension's own highlighter,
   * `"<extensionId>:<highlighterId>"` addresses any registered one.
   */
  refresh(highlighterId: string, options?: { fileId?: string }): void;
}

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
 * Baseline detection priority used by Hunk's default bundled backend.
 *
 * Adapters are consulted highest priority first. Bundled providers that must
 * win a same-root tie register above this value; user adapters can do the same
 * when their repository metadata establishes the authoritative working copy.
 */
export const HUNK_VCS_DETECTION_BASELINE_PRIORITY = 0;

/** @deprecated Use `HUNK_VCS_DETECTION_BASELINE_PRIORITY`. */
export const HUNK_CORE_VCS_DETECTION_PRIORITY = HUNK_VCS_DETECTION_BASELINE_PRIORITY;

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

/**
 * The two commits a `hunk diff A B` review compares, left unjoined.
 *
 * `A..B` is Git spelling. Jujutsu and Sapling read `..` as a revset over the
 * commits *between* the endpoints, which drops A-side changes once the two have
 * diverged, so Hunk cannot join them before it knows the backend. Each adapter
 * spells this in its own two-sided form.
 */
export interface ExtensionVcsRangeEndpoints {
  from: string;
  to: string;
}

/** Working-tree review request, as extension adapters receive it. */
export interface ExtensionVcsDiffInput {
  kind: "vcs";
  /** A revision or range expression in the backend's own language, as typed. */
  range?: string;
  /** Set instead of `range` when the user named both endpoints as `hunk diff A B`. */
  rangeEndpoints?: ExtensionVcsRangeEndpoints;
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
export type ExtensionVcsFileSide = ExtensionFileSide;

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
 * throwing. Return `{ kind: "too-large", maxBytes }` when reading the source
 * would exceed the adapter's safety limit; Hunk presents that as an unavailable
 * expansion without treating it as an extension failure.
 *
 * Hunk calls this at most once per file and side and caches what it resolves,
 * so the reader does not need its own cache. It is never called for a file the
 * diff reports as binary. Resolve the revisions the read needs while your
 * operation is loading and close over them: the request describes the file, not
 * the commits, because only the adapter knows how to name them.
 */
/** A source side the adapter declined to read because it exceeded its safety limit. */
export interface ExtensionVcsFileSourceTooLarge {
  kind: "too-large";
  /** The byte ceiling the source exceeded, when useful to diagnostics. */
  maxBytes?: number;
}

/** One exact-source read result returned through the public adapter boundary. */
export type ExtensionVcsFileSourceResult = string | null | ExtensionVcsFileSourceTooLarge;

export type ExtensionVcsFileSourceReader = (
  request: ExtensionVcsFileSourceRequest,
) => Promise<ExtensionVcsFileSourceResult>;

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
   * Opaque stable identity for source state not already represented by each file's patch.
   *
   * Reuse a value across loads only when an equal per-file patch plus this key guarantees
   * the same old/new source answers for that file. Hunk uses the combination to retain
   * highlighted output; when omitted, every new reader is treated as a new snapshot.
   */
  sourceCacheKey?: string;
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
/* Docked panes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Theme tokens extension-owned React/OpenTUI painters render with.
 *
 * A curated slice of the active theme rather than the whole internal theme
 * model: every value is a hex color string (or the appearance flag), stable to
 * build UI against, and updated live when the user switches themes. Field
 * names match the `[themes.<id>]` config table where a concept exists there.
 */
export interface ExtensionPaintTheme {
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

/** Theme exposed to extension-owned pane painters. */
export type ExtensionPaneTheme = ExtensionPaintTheme;
/** @deprecated Use ExtensionPaneTheme. */
export type ExtensionSidebarTheme = ExtensionPaneTheme;

/**
 * Navigation any extension surface can trigger, exactly as the built-in
 * sidebar does.
 *
 * Every call routes through the same review controller the built-in sidebar
 * and keyboard shortcuts use, so the main review stream scrolls, selection
 * updates, and the `selection_changed` lifecycle event fires identically —
 * other extensions cannot tell what drove the navigation. Targets are
 * validated against the currently visible (filtered) files: an unknown or
 * hidden file id is refused with a warning naming the extension, and a hunk
 * index is clamped into the file's real hunk range. A failure inside a call is
 * reported the same way instead of thrown back into the caller.
 */
export interface ExtensionReviewNavigation {
  /** Jump the review stream to one file, like clicking its sidebar row. */
  selectFile(fileId: string): void;
  /** Jump the review stream to one hunk of one file. */
  selectHunk(fileId: string, hunkIndex: number): void;
  /**
   * Jump the review stream to one source line, addressed by side and number.
   *
   * The finest navigation target there is: a hunk hundreds of lines tall no
   * longer lands the viewport pages away from the line you meant. `line` is a
   * 1-based number on `side` as the patch numbers it, so a context line
   * answers to either side's number. The revealed line lands where every other
   * Hunk reveal lands — a little below the viewport top — and becomes the
   * current line, so it pairs with a mark from `registerLineHighlighter`.
   *
   * When the review cannot render that line (it sits inside a collapsed gap,
   * or the patch never numbered it) the jump falls back to the hunk containing
   * it; a line no hunk contains is refused with a warning naming the
   * extension.
   */
  revealLine(fileId: string, side: "old" | "new", line: number): void;
}

/**
 * What a custom pane component can trigger: review navigation plus a toast.
 *
 * Actions stay valid for as long as the component is mounted.
 */
export interface ExtensionPaneActions extends ExtensionReviewNavigation {
  /** Show one toast, attributed to the owning extension. */
  notify(message: string, type?: ExtensionNotifyType): void;
}
/** @deprecated Use ExtensionPaneActions. */
export type ExtensionSidebarActions = ExtensionPaneActions;

/**
 * The resolved command bindings available to a custom pane.
 *
 * This mirrors Pi's injected keybindings manager: pane components name a
 * command instead of repeating its default chord, so their local key handling
 * follows the user's `[keybindings]` configuration. The command ids are the
 * same ids documented by Hunk (`"hunk.review.nextFile"`) and extensions
 * (`"<extensionId>.<commandId>"`).
 */
export interface ExtensionPaneKeybindings {
  /** Report whether one terminal key event matches the command's current binding. */
  matches(
    key: {
      name?: string;
      sequence?: string;
      ctrl?: boolean;
      meta?: boolean;
      option?: boolean;
      shift?: boolean;
    },
    commandId: string,
  ): boolean;
  /** Return the command's current chords, or an empty list when it is unbound or unknown. */
  getKeys(commandId: string): readonly string[];
}

/** A terminal edge where a host-owned pane can be docked. */
export type ExtensionPanePlacement = "left" | "right" | "top" | "bottom";

/** Requested pane width or height along its docked edge. */
export interface ExtensionPaneSize {
  preferred: number;
  min?: number;
  max?: number;
}

/** Opaque host renderer for the selected split row. */
export interface ExtensionCurrentLinePaint {
  /** Paint one side as a clipped, no-wrap terminal row. */
  render(side: "old" | "new", width: number): unknown;
}

/** Immutable state used to decide whether an open pane is meaningful this frame. */
export interface ExtensionPaneAvailabilityContext {
  readonly placement: ExtensionPanePlacement;
  readonly files: readonly ExtensionDiffFile[];
  readonly selectedFileId: string | null;
  readonly selectedHunkIndex: number | null;
  readonly currentLine: ExtensionCurrentLinePaint | null;
}

/** Everything a custom pane component receives, refreshed as the app changes. */
export interface ExtensionPaneProps {
  readonly files: readonly ExtensionDiffFile[];
  readonly selectedFileId: string | null;
  readonly selectedHunkIndex: number | null;
  readonly placement: ExtensionPanePlacement;
  /** Exact host-owned component rectangle. */
  readonly width: number;
  readonly height: number;
  readonly theme: ExtensionPaneTheme;
  readonly keybindings: ExtensionPaneKeybindings;
  readonly actions: ExtensionPaneActions;
  /** Non-null only when the registration explicitly requested current-line paint. */
  readonly currentLine: ExtensionCurrentLinePaint | null;
}

/** A React/OpenTUI component mounted inside an exact host-owned rectangle. */
export type ExtensionPaneComponent = (props: ExtensionPaneProps) => unknown;

/** Fields shared by panes on every terminal edge. */
interface ExtensionPaneBase {
  /** Identifies the pane within its extension; `<extensionId>:<id>` globally. */
  id: string;
  title?: string;
  defaultOpen?: boolean;
  /**
   * Start open in place of this pane, which starts closed.
   *
   * Use `"hunk:files"` for the files role or a fully qualified
   * `"<extensionId>:<paneId>"` key to extend a replacement chain. Hunk's
   * files-pane command follows the resolved owner on any terminal edge.
   * Replacement initial defaults take precedence over `defaultOpen`. The first
   * pane registered for a named target owns its slot; later claims are skipped.
   */
  replaces?: string;
  /** Opt into live current-line paint; unrelated panes receive stable null. */
  currentLine?: boolean;
  /** Synchronous frame-availability policy. */
  available?(context: ExtensionPaneAvailabilityContext): boolean;
  component: ExtensionPaneComponent;
}

/** A left/right pane sized explicitly in terminal columns. */
export interface ExtensionVerticalPane extends ExtensionPaneBase {
  /** Defaults to `"left"`. */
  placement?: "left" | "right";
  /** Defaults to 34 preferred and 22 minimum columns. */
  width?: ExtensionPaneSize;
  height?: never;
}

/** A top/bottom pane sized explicitly in terminal rows. */
export interface ExtensionHorizontalPane extends ExtensionPaneBase {
  placement: "top" | "bottom";
  /** Defaults to 8 preferred and 3 minimum rows. */
  height?: ExtensionPaneSize;
  width?: never;
}

/** A docked pane contributed by an extension. */
export type ExtensionPane = ExtensionVerticalPane | ExtensionHorizontalPane;

/** @deprecated Use ExtensionPaneKeybindings. */
export type ExtensionSidebarKeybindings = ExtensionPaneKeybindings;
/** @deprecated Use ExtensionPanePlacement. */
export type ExtensionSidebarPlacement = Extract<ExtensionPanePlacement, "left" | "right">;
/** @deprecated Use ExtensionPaneProps. */
export interface ExtensionSidebarViewProps {
  files: ExtensionDiffFile[];
  selectedFileId: string | null;
  selectedHunkIndex: number | null;
  width: number;
  theme: ExtensionSidebarTheme;
  keybindings: ExtensionSidebarKeybindings;
  actions: ExtensionSidebarActions;
}
/** @deprecated Use ExtensionPaneComponent. */
export type ExtensionSidebarComponent = (props: ExtensionSidebarViewProps) => unknown;
/** @deprecated Use ExtensionPane. */
export interface ExtensionSidebarView {
  id: string;
  title?: string;
  placement?: ExtensionSidebarPlacement;
  defaultOpen?: boolean;
  replacesDefault?: boolean;
  component: ExtensionSidebarComponent;
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One named keyboard command contributed by an extension.
 *
 * Commands are the same mechanism Hunk's own shortcuts run on: a key chord
 * resolves to a command, and the command's handler runs. A chord that
 * collides with a built-in shortcut or an earlier extension binding is
 * refused with a warning — the command stays registered, and any other chord
 * it declared stays bound.
 */
export interface ExtensionCommand {
  /**
   * Identifies the command within its extension; `<extensionId>.<id>` globally.
   *
   * Extension ids and Hunk's own ids never meet: everything built-in is named
   * under the reserved `hunk` id (`hunk.review.nextHunk`), so a command here
   * cannot shadow one of Hunk's, whichever id an extension is installed under.
   */
  id: string;
  /** Human-readable name for command menus and keyboard help. */
  title: string;
  /**
   * Default key chord, e.g. `"ctrl+m"`, `"F2"`, `"G"`, `"y"`, or an array of
   * chords to bind the command to every one of them.
   *
   * Modifiers are `ctrl`, `alt`/`option`, `cmd`/`meta`, and `shift`, joined
   * with `+`; an uppercase letter means its shifted form. `shift` applies to
   * letters and named keys only — for a shifted symbol or digit, bind the
   * character the shift produces (`"!"`, `"{"`), since terminals report the
   * character rather than the combination. Omit to register a command with
   * no binding.
   *
   * These are defaults: a user's `[keybindings]` config table may rebind or
   * unbind the command by its `<extensionId>.<id>` name.
   */
  key?: string | readonly string[];
}

/** Options for invoking one public Hunk command from an extension command. */
export interface ExtensionCommandExecutionOptions {
  /**
   * Positive whole-number magnitude for commands that support counted movement.
   *
   * Counts are applied atomically by the host rather than by repeatedly dispatching the command.
   * Commands without count semantics run once. Values above 10,000 or outside the safe positive
   * integer range are rejected as extension programming errors.
   */
  count?: number;
}

/**
 * Inspect and invoke the public commands owned by Hunk.
 * Canonical ids and documented compatibility aliases resolve to the same command.
 */
export interface ExtensionCommandControls {
  /** Report whether one public `hunk.*` command exists and can run right now; malformed ids return false. */
  isEnabled(commandId: string): boolean;
  /**
   * Invoke one enabled public `hunk.*` command through Hunk's normal command table.
   *
   * Returns `false` for unknown, disabled, non-public, extension-owned, or stale commands.
   * Malformed ids, options, and counts are extension programming errors and throw.
   */
  execute(commandId: string, options?: ExtensionCommandExecutionOptions): boolean;
}

/**
 * Enter, leave, and inspect this extension's registered session keyboard modes.
 * Ownership-changing calls return `false` during `onEnter` and `onExit`.
 */
export interface ExtensionKeyboardModeControls {
  /** Enter one owned mode from a command or `onKey`, replacing the active session mode. */
  enterMode(modeId: string): boolean;
  /** Leave this extension's active mode from a command or `onKey`. */
  exitMode(): boolean;
  /** Report whether this extension owns the active mode, optionally requiring one local id. */
  isActive(modeId?: string): boolean;
}

/** Open, close, and inspect panes from a command handler. */
export interface ExtensionPaneControls {
  /**
   * Resolve one pane: a bare id names this extension's own pane, while a fully
   * qualified `"<extensionId>:<paneId>"` key addresses any registered pane.
   * Use `"hunk:files"` for the literal built-in pane. These controls do not
   * resolve replacement slots; execute `hunk.view.toggleFilesPane` through
   * command controls for the active files role.
   *
   * Opening a left/right pane (here, or via `toggle`) also reveals the sidebar
   * area when it is hidden, so the open is never silent.
   */
  open(viewId: string): void;
  close(viewId: string): void;
  toggle(viewId: string): void;
  isOpen(viewId: string): boolean;
}
/** @deprecated Use ExtensionPaneControls. */
export type ExtensionSidebarControls = ExtensionPaneControls;

/** Select or inspect the active file presentation from an extension command. */
export interface ExtensionFileViewControls {
  /** Select this extension's matching view, or pass `null` to restore raw rendering. */
  select(viewId: string | null): void;
  /** Switch this extension's view on/off, returning to raw when it was active. */
  toggle(viewId: string): void;
  /** Report whether this extension's view is active for the current file. */
  isActive(viewId: string): boolean;
  /**
   * Mark this view's prepared layouts stale so a stateful view can redraw.
   *
   * Hunk treats `layout` as a pure derivation of `(file, width)` and reuses a
   * prepared result until one of those — or the registration itself — changes.
   * A view that keeps its own state (a fold, a toggled overlay) has no such
   * change to announce, so this is how it asks for a re-derivation.
   *
   * Every prepared layout of this view is invalidated at once, and each file
   * currently presenting it re-runs `matches` and `layout`. Files on raw diff
   * or on another view do no work. The previously prepared rows stay on screen
   * until the replacement resolves, so a refresh never flashes back to raw
   * diff; a re-layout that declines, throws, or times out falls back to raw
   * exactly like any other failed layout, with the same single warning.
   *
   * Pass `{ fileId }` when the state that changed belongs to one file — a fold
   * or an edit buffer the view keeps per file. Only that file's prepared layout
   * for this view is invalidated; the other files presenting the view keep
   * their rows and do no work, which matters because a view can be presenting
   * every matching file in the changeset at once. A `fileId` no reviewed file
   * carries invalidates nothing and warns about nothing: ids can race a reload.
   *
   * Bare ids address the calling extension's own view, `"<extensionId>:<viewId>"`
   * addresses any registered one, and an unknown id warns and does nothing —
   * the same resolution and refusal `select` uses.
   */
  refresh(viewId: string, options?: { fileId?: string }): void;
  /**
   * Make this view the selected file's presentation and give its mode the keys.
   *
   * One step: if the file is not already showing the view, entering selects it
   * — the same state change `select` makes — so the rows the mode acts on are
   * on screen from the moment it holds the keyboard. A command can bind a
   * single key to "enter my editor" rather than asking for two presses.
   *
   * Succeeds — and returns `true` — unless something no selection could fix
   * stops it, each warned by name and answered with `false`: the id resolves to
   * nothing, no file is selected, the view does not `matches` the selected file
   * (or its matcher throws), the file is one Hunk is keeping on raw diff, or the
   * view declares no `mode`. That is exactly the containment `select` applies,
   * so a command can offer the mode without duplicating the host's checks.
   *
   * The view's rows may still be preparing when the mode starts, exactly as
   * after a `refresh`: the previous rows stay on screen until the layout
   * resolves, and a layout that declines or fails falls back to raw diff.
   *
   * While the mode is active, keys the app's modal surfaces do not claim reach
   * `onKey` before Hunk's command table. When the mode is the highest-priority
   * input owner, Escape is host-owned: it exits the mode and never reaches the
   * handler, so there is always a way out.
   *
   * Hunk also exits the mode by itself when the review moves out from under it
   * — the selected file changes, the view stops being that file's presentation
   * (selected or toggled away), a session reload replaces the review — or when
   * `onEnter`/`onKey` throws. `onExit` runs on every one of those paths.
   *
   * One session runs one mode: entering while another mode is active exits that
   * one first, so its `onExit` runs — exactly once, as on any other exit path —
   * before the new mode's `onEnter`.
   *
   * Ids resolve exactly as `select` resolves them.
   */
  enterMode(viewId: string): boolean;
  /**
   * Leave the active mode, whichever view owns it.
   *
   * Global across file views because only one file-view mode is active at a
   * time, and idempotent: calling it with no file-view mode active does nothing.
   */
  exitMode(): void;
  /** Report whether this view's mode is the one currently active. */
  isModeActive(viewId: string): boolean;
}

/**
 * The review selection at one moment, as extensions see it.
 *
 * A snapshot rather than a live window onto the review: the values describe
 * where the user was when the command fired, and never change afterwards.
 */
export interface ExtensionReviewSelection {
  /**
   * The selected file among the currently visible (filtered) files, or `null`.
   *
   * The same frozen read-only view a pane component receives in its `files`
   * prop, so holding or mutating it cannot reach the review model. Extensions
   * only receive visible files, so this is `null` when filtering hides the
   * selected file or when no files are visible.
   */
  readonly file: ExtensionDiffFile | null;
  /**
   * The selected hunk's index within that file, or `null` when no hunk is
   * selected — including whenever `file` is `null`, and for a file with no
   * hunks to select (a binary or skipped file).
   */
  readonly hunkIndex: number | null;
  /**
   * The source line carrying Hunk's current-line marker, or `null` when line
   * navigation is off or the review has not settled on a rendered line yet.
   *
   * `line` is one-based on `side`, matching patch line numbers and
   * `navigation.revealLine`. Context rows use Hunk's canonical new-side
   * address. This copied, frozen target belongs to `file` and `hunkIndex` in
   * this same snapshot; it never exposes renderer cursor state.
   */
  readonly currentLine: {
    readonly side: ExtensionFileSide;
    readonly line: number;
  } | null;
}

/** One question put to the user as a modal confirm dialog. */
export interface ExtensionConfirmOptions {
  title: string;
  /** Optional body lines shown above the actions. */
  body?: string;
  /** Label for the accepting action. Defaults to "ok". */
  confirmLabel?: string;
  /** Label for the dismissing action. Defaults to "cancel". */
  cancelLabel?: string;
}

/** A list of choices put to the user as a modal selector. */
export interface ExtensionSelectOptions {
  title: string;
  /** The choices, shown in order. Must be non-empty. */
  options: readonly string[];
}

/** One line of text asked of the user as a modal input field. */
export interface ExtensionInputOptions {
  title: string;
  placeholder?: string;
  /** Text the field starts with. */
  initial?: string;
}

/**
 * Ask the user questions from a command handler, one modal at a time.
 *
 * Every dialog is drawn by Hunk, not by the extension. Dialogs from installed
 * extensions carry an attribution line naming their source, so a third-party
 * prompt cannot present itself as Hunk asking; Hunk-owned bundled extensions
 * omit that redundant marker. Only one dialog is on screen at a time:
 * concurrent requests queue in call order (FIFO), including across extensions,
 * so a second question waits for the first to be answered rather than replacing it.
 *
 * Escape always cancels, resolving the cancel value (`false`, or `null`).
 * Enter accepts: the confirm action, the highlighted option, or the typed text.
 * A session reload — the refresh key, a watch-triggered reload, an agent
 * command — cancels open and queued dialogs the same way: the review they
 * asked about is being replaced. A dialog raised while the app is tearing
 * down resolves its cancel value immediately, so a handler awaiting one is
 * never left hanging.
 *
 * Bad arguments are a programming error rather than a user answer, so they
 * reject instead of resolving: a missing or blank `title`, or a `select` with
 * no options. Because a dialog call is only useful awaited, the rejection
 * surfaces through the same path as any other handler failure — a warning toast
 * naming the extension.
 */
export interface ExtensionDialogs {
  /** Resolves true on confirm, false on cancel/escape. */
  confirm(options: ExtensionConfirmOptions): Promise<boolean>;
  /** Resolves the chosen option, or null on cancel/escape. */
  select(options: ExtensionSelectOptions): Promise<string | null>;
  /** Resolves the submitted text, or null on cancel/escape. */
  input(options: ExtensionInputOptions): Promise<string | null>;
}

/** One whole-document replacement an extension asks the host to write. */
export interface ExtensionWorkspaceWriteRequest {
  /** The reviewed file to write, by its `ExtensionDiffFile.id`. */
  fileId: string;
  /** The complete replacement text for the file's new side. */
  text: string;
}

/**
 * How a write attempt settled.
 *
 * The three refusals are different kinds of answer, not degrees of failure:
 * `"unavailable"` means the write was never possible for this review or this
 * file, `"cancelled"` means the user was asked and said no, and `"failed"`
 * means the filesystem refused the write Hunk actually attempted. Each carries
 * a `detail` sentence fit to show a person.
 */
export type ExtensionWorkspaceWriteResult =
  | { ok: true }
  | { ok: false; reason: "unavailable" | "cancelled" | "failed"; detail: string };

/**
 * The reviewed files as whole documents, read and written through the host.
 *
 * Extension isolation is crash containment rather than a sandbox, so an
 * extension can already reach `node:fs` and read or write wherever your shell
 * can. This is the supported alternative, and what it buys is everything that a
 * direct filesystem call skips: the target can only be a file the user is
 * reviewing, named by review id rather than by path; a write asks the user
 * first, in a prompt naming the extension doing the asking; and the review
 * reloads afterwards so what you are looking at is what is on disk. An
 * extension that reaches reviewed files any other way is outside the contract,
 * and outside anything the user agreed to.
 *
 * The two halves are deliberately not symmetric, because they are not the same
 * kind of act. Reading exposes exactly what the review already shows the user,
 * so it is available in every review kind and never prompts. Writing changes
 * the user's files, so it is working-tree only and always asks.
 *
 * Writes are available exactly when the session is reviewing the working tree —
 * a `vcs` diff review with no revision range and without `--staged` — and can
 * reload it. A revision show, a stash show, a range diff, a staged diff, patch
 * input, and a file-pair diff have no working-tree document to replace, and
 * every write against them resolves `"unavailable"`; so does a session whose
 * review cannot be rebuilt after a write, which is one started with
 * `--agent-context -`, since the reload every write promises could not happen.
 * A file with no new side (deleted) and a file Hunk never read as text (binary,
 * skipped for size) are `"unavailable"` for the same reason as the first group
 * — there is no document to replace.
 */
export interface ExtensionWorkspace {
  /**
   * Read one exact full source document from a reviewed file.
   *
   * The document a file view gets from `ExtensionFileViewInput.readDocument`,
   * reachable from a command handler: ask for the `"old"` or `"new"` side of a
   * file in the current changeset and get its complete source text. Patch text
   * is already at hand as `ExtensionDiffFile.patch` and is deliberately not
   * this, because a patch is not an exact source file.
   *
   * Resolves `null`, rather than rejecting, for every way a read comes back
   * empty-handed: no reviewed file carries that id, the side does not exist
   * (the `"old"` side of an added file, the `"new"` side of a deletion), Hunk
   * has no source to read for this file at all, the read failed, or the
   * document is past the host's source-size cap. A probe is an ordinary
   * question here, the same way `canWriteDocument` answers instead of throwing.
   * The promise **rejects** only for a `side` that is neither `"old"` nor
   * `"new"`, which is a bug in the extension rather than an answer.
   *
   * Unlike writes, reads work in every review kind — a revision show, a stash
   * entry, a range diff, patch input — and never prompt. Reading the `"new"`
   * side, transforming the text, and passing the result to `writeDocument` is
   * the pairing this exists for.
   */
  readDocument(fileId: string, side: ExtensionFileSide): Promise<string | null>;
  /**
   * Whether `writeDocument` could currently succeed for this reviewed file.
   *
   * The affordance probe behind a menu entry or a mode indicator: the same
   * review, file, and path checks a write makes, minus the dialog and the
   * filesystem. It never prompts and never touches disk, so a `true` here still
   * describes what the user could allow rather than what they have allowed, and
   * a write can still come back `"cancelled"` or `"failed"`.
   *
   * Because it asks nothing of the filesystem, it is optimistic about what only
   * the filesystem knows: a write additionally verifies its target at write
   * time and refuses `"unavailable"` for a reviewed path that is a symlink,
   * sits under a linked directory pointing out of the repository, or has left
   * the working tree since the review was built. The action is never optimistic
   * about those; only the affordance is.
   */
  canWriteDocument(fileId: string): boolean;
  /**
   * Replace one reviewed file's contents on disk, with the user's consent.
   *
   * Every write asks first. Hunk draws a confirm dialog through the same
   * attributed, FIFO-queued modal system as `ctx.dialogs` — naming your
   * extension and the file's path, and framing the write as the overwrite it
   * is — so a write can no more present itself as Hunk's own than a dialog can.
   * Declining, or pressing Escape, resolves `{ ok: false, reason: "cancelled" }`:
   * a normal answer, never an exception.
   *
   * Before the prompt, Hunk verifies that the path it would write is the file
   * the prompt names: a reviewed path that is a symlink, or that sits under a
   * directory link leading out of the repository, resolves `"unavailable"`
   * without asking, and so does one that has left the working tree since the
   * review was built — a write recreates nothing the user deleted. Hunk checks
   * again after consent, refusing a target deleted or replaced by an unsafe
   * path while the prompt was open.
   *
   * On success Hunk reloads the session the same way the refresh key does, so
   * the review an extension sees afterwards reflects what it wrote. That holds
   * for every write that can happen: a session whose review could not be
   * rebuilt refuses writes rather than accepting one it would then hide.
   * Authority is checked immediately before the filesystem call; once that
   * irreversible write starts, the promise reports its actual outcome even if
   * another reload wins meanwhile, and success reconciles the review then active.
   * Graceful shutdown waits for a started write to settle. The promise settles
   * on the write itself, not on its follow-up reload — a handler that
   * resumes immediately is looking at the changeset it was called with.
   *
   * A filesystem that refuses the write resolves `"failed"` with a
   * human-readable `detail`. The promise **rejects** only for a malformed
   * request — a missing or non-string `fileId` or `text` — which is a bug in
   * the extension rather than an answer, and surfaces through the same warning
   * path as any other handler failure.
   */
  writeDocument(request: ExtensionWorkspaceWriteRequest): Promise<ExtensionWorkspaceWriteResult>;
}

/** Host-level behavior one extension may request for the current review session. */
export interface ExtensionSessionOptions {
  /**
   * Treat view-setting changes as temporary practice or presentation state.
   *
   * When `"transient"`, Hunk never offers to write the session's final view
   * settings into the user's config on quit. Any extension requesting
   * transient behavior makes the shared session transient.
   */
  viewPreferences?: "default" | "transient";
}

/** What a command handler receives when its key fires. */
export interface ExtensionCommandContext extends ExtensionContext {
  /** Live access to the public built-in command table. */
  readonly commands: ExtensionCommandControls;
  /** Session keyboard modes registered by this command's owning extension. */
  readonly keyboardModes: ExtensionKeyboardModeControls;
  /** Session panes registered by this command's owning extension. */
  readonly panes: ExtensionPaneControls;
  /** Invalidate prepared line highlights so `highlight` re-derives them. */
  readonly highlights: ExtensionLineHighlightControls;
  /** @deprecated Use panes. */
  readonly sidebars: ExtensionSidebarControls;
  /** Host-owned selection controls for alternate file presentations. */
  fileViews: ExtensionFileViewControls;
  /**
   * Where the review was pointing when this command fired.
   *
   * Captured at invocation, not live: a handler that awaits and reads it again
   * still sees the selection the user ran the command from.
   */
  readonly selection: ExtensionReviewSelection;
  /**
   * Navigate the review stream, exactly as a pane's actions do.
   *
   * Live rather than snapshot, the opposite of `selection`: a call acts on the
   * review as it is at that moment, validated against the currently visible
   * files — so a handler that awaits a dialog and then navigates still works,
   * and one racing a reload gets a warning instead of a stale jump.
   */
  readonly navigation: ExtensionReviewNavigation;
  /**
   * Ask the user a question and await the answer.
   *
   * Valid for the handler's promise while this review generation remains
   * current, so a handler may open several dialogs in sequence with work in
   * between. A reload expires retained controls and returns cancel values.
   */
  readonly dialogs: ExtensionDialogs;
  /**
   * Read reviewed files, and write them back to the working tree with the
   * user's consent.
   *
   * Host-mediated on purpose: the file is named by review id, a write asks the
   * user first, and the review reloads after a successful write. Retained reads
   * and writes that have not started expire with this review generation
   * (`null`/`"unavailable"`); an irreversible write already in progress reports
   * its real filesystem outcome.
   */
  readonly workspace: ExtensionWorkspace;
}

export type ExtensionCommandHandler = (ctx: ExtensionCommandContext) => void | Promise<void>;

/** One listener registered on Hunk's extension-to-extension event bus. */
export type ExtensionCustomEventHandler<Payload = unknown> = (
  payload: Payload,
  ctx: ExtensionEventContext,
) => void | Promise<void>;

/**
 * A small in-process event bus shared by every loaded extension.
 *
 * Use a namespaced event name (`"my-extension:status-ready"`) so unrelated
 * extensions cannot accidentally claim the same channel. Delivery is
 * fire-and-forget and isolated like lifecycle events: Hunk never awaits a
 * listener, and one failure becomes a warning without stopping another. Events
 * emitted while extension factories load are queued until every extension has
 * had a chance to subscribe.
 */
export interface ExtensionEventBus {
  on<Payload = unknown>(event: string, handler: ExtensionCustomEventHandler<Payload>): void;
  emit<Payload = unknown>(event: string, payload: Payload): void;
}

/** Context lifecycle and bus listeners receive, with controls scoped to this review generation. */
export interface ExtensionEventContext extends ExtensionContext {
  panes: ExtensionPaneControls;
  /** @deprecated Use panes. */
  sidebars: ExtensionSidebarControls;
  /** Navigate the live review from lifecycle-driven guides and coordinators. */
  readonly navigation: ExtensionReviewNavigation;
  /** Ask attributed, FIFO-queued questions from lifecycle and bus handlers. */
  readonly dialogs: ExtensionDialogs;
  events: Pick<ExtensionEventBus, "emit">;
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
export type ExtensionLayoutMode = "auto" | "split" | "stack";
export type ExtensionResolvedLayout = Exclude<ExtensionLayoutMode, "auto">;

/** A user-authored note as reported by note lifecycle events. */
export interface ExtensionReviewNote {
  id: string;
  fileId: string;
  filePath: string;
  hunkIndex: number;
  side: "old" | "new";
  line: number;
  body: string;
  /** True while the note is still being composed rather than saved. */
  draft: boolean;
}

export interface ExtensionEventPayloads {
  startup: { cwd: string };
  changeset_loaded: { changeset: ExtensionChangeset };
  /** A named built-in or extension command was dispatched in this terminal host. */
  command_executed: { commandId: string };
  selection_changed: { fileId: string | null; hunkIndex: number | null };
  /** The review stream settled on a different file. */
  file_viewed: { file: ExtensionDiffFile; hunkIndex: number | null };
  /** The file-filter query changed, including when it was cleared. */
  filter_changed: { filter: string };
  /** The user committed a different active theme. Selector previews do not emit this event. */
  theme_changed: { themeId: string };
  /** The configured layout mode or responsive resolved layout changed. */
  layout_changed: { mode: ExtensionLayoutMode; layout: ExtensionResolvedLayout };
  /** A watch source observed a change and is waiting to check/reload it. */
  watch_reload_pending: Record<string, never>;
  /** A user saved a new inline review note. */
  note_created: { note: ExtensionReviewNote };
  /** The body of an in-progress inline review note changed. */
  note_edited: { note: ExtensionReviewNote };
  session_reload: { changeset: ExtensionChangeset; reason: SessionReloadReason };
  shutdown: Record<string, never>;
}

export type ExtensionEventName = keyof ExtensionEventPayloads;

export type ExtensionEventHandler<Event extends ExtensionEventName = ExtensionEventName> = (
  payload: ExtensionEventPayloads[Event],
  ctx: ExtensionEventContext,
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
  /** Configure host-level behavior for the review session loading this extension. */
  configureSession(options: ExtensionSessionOptions): void;
  /** Contribute one selectable theme. */
  registerTheme(theme: ExtensionThemeConfig): void;
  /** Map one file extension (with or without a leading dot) to a highlight language. */
  registerFileLanguage(extension: string, language: string): void;
  /** Contribute one additional VCS backend. */
  registerVcsAdapter(adapter: ExtensionVcsAdapter): void;
  /**
   * Register a docked pane on any terminal edge.
   *
   * Any number can be open simultaneously. Hunk owns their exact rectangles,
   * minimum review bounds, availability, and render-failure containment.
   */
  registerPane(pane: ExtensionPane): void;
  /** @deprecated Use registerPane. */
  registerSidebarView(view: ExtensionSidebarView): void;
  /**
   * Register a host-rendered alternative presentation for matching files.
   *
   * The host owns row measurement, scrolling, windowing, selection, and note
   * placement. Rows normally contain symbolic text; the experimental fixed-height
   * row component contract may paint React/OpenTUI content inside clipped host geometry.
   */
  registerFileView(view: ExtensionFileView): void;
  /**
   * Register a contributor of character-range marks painted onto diff lines.
   *
   * Marks are addressed by source coordinates and painted by the host inside
   * its own diff rendering — syntax highlighting, word diff, and layout stay
   * intact. The host resolves each mark's `tone` against the active theme and
   * line kind, guaranteeing visible contrast the way its own word-diff
   * emphasis does, and against an assumed background where the cell itself is
   * transparent.
   */
  registerLineHighlighter(highlighter: ExtensionLineHighlighter): void;
  /**
   * Register one session-scoped keyboard interpretation.
   *
   * Registration alone changes nothing; a command deliberately enters it
   * through `ctx.keyboardModes.enterMode()`.
   */
  registerKeyboardMode(mode: ExtensionKeyboardMode): void;
  /**
   * Register one named command, optionally bound to a key,
   *
   * The handler runs when the key fires outside modal UI (dialogs, menus,
   * focused inputs own their keys first). Handlers receive the standard
   * context plus pane controls, so a command can open the pane its extension
   * registered.
   */
  registerCommand(command: ExtensionCommand, handler: ExtensionCommandHandler): void;
  /** Rewrite every loaded changeset before review. */
  transformChangeset(fn: ChangesetTransform): void;
  /** Subscribe to one Hunk lifecycle or UI event. Handlers receive pane controls. */
  on<Event extends ExtensionEventName>(event: Event, handler: ExtensionEventHandler<Event>): void;
  /** Publish or subscribe to a namespaced event shared with other loaded extensions. */
  readonly events: ExtensionEventBus;
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
