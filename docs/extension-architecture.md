# Extension system architecture

Maintainer-facing map of how the extension system hangs together. The
authoring guide for extension users is [docs/extensions.md](extensions.md);
this doc is about Hunk's own internals. Each module named here carries a
header comment with the full local story — read those for depth; this page
exists so you know which module owns what.

## Tiers and loading

Extensions come in two tiers running through the same per-extension API
object and registry collection (`src/extensions/runExtension.ts`):

- **User extensions** load at interactive-app startup, before
  `loadAppBootstrap` (`src/extensions/startup.ts`, `src/extensions/host.ts`).
  Discovery groups and trust gating: `src/extensions/discovery.ts`,
  `src/extensions/trust.ts`.
- **Bundled extensions** live in `src/extensions/default/` and are compiled
  into the binary. `default/vcs/{git,jujutsu,sapling}` is statically imported
  by the app composition root (`app/vcsCatalog.ts`) and loaded synchronously
  before config resolution, so backends exist without making core import the
  extension host. `default/ui/index.ts` is deliberately not part of that list:
  it synchronously loads the bundled files pane through `runExtensionFactory`
  only where the app resolves UI panes. `default/languages/` ships file-language
  selectors as plain data that `applyExtensionFileLanguages` prepends ahead of
  user extensions, so apply stays off the diff-engine import graph.

Git and the built-in file navigation use the public `registerVcsAdapter` and
`registerPane` paths. The external [Hunk Lens](https://github.com/modem-dev/hunk-lens)
extension exercises current-line pane paint through that same public contract.

Bundled extensions are implicitly trusted and stay loaded under
`--no-extensions`, which governs user extensions only.

An extension id is a file stem the user chose, and it is the namespace that id
owns for commands (`<extensionId>.<commandId>`), panes
(`<extensionId>:<viewId>`), and config (`[extension.<id>]`). `host.ts` is the
one place those ids are vetted — discovery stays a pure filesystem walk, and
every way an id can be derived arrives there as `candidate.id`. It refuses
reserved ids (`hunk`, plus the base catalog's bundled backend ids), ids outside
`/^[A-Za-z0-9][A-Za-z0-9_-]*$/` (a dot or colon would make the composed ids
unsplittable), and the later of two sources claiming one id; each refusal is a
load issue and costs only that extension. The rules themselves are stated in
`src/extensions/extensionIds.ts`.

## One registry, one apply path

Registrations (session behavior, themes, file languages, VCS adapters,
changeset transforms, panes, interactive commands, top-level CLI commands,
lifecycle/UI events, and inter-extension bus listeners) collect into one
`ExtensionRegistry` (`src/extensions/types.ts`) and are resolved/applied
through `src/extensions/apply.ts` on both startup and reload. File-language registrations stay as
declarative extension, filename, or glob selectors until `fileLanguageLookup.ts` resolves them;
Hunk then pins that answer into Pierre's metadata so rendering cannot re-derive a conflicting
language. A live reload replaces the compiled selector generation while preparing its changeset
and restores the previous generation if any pre-commit step fails. Staged external-VCS bootstrap
retains the provisional candidate/config snapshot: a final pass that
only appends repo candidates extends the same registry, while a changed prefix
receives bounded `shutdown` before being rebuilt. Live registry replacement uses
the same shutdown/startup lifecycle. A factory that throws is rolled back to its
pre-run registration counts (`runExtension.ts`); failures cost a warning, not the
session.

Generic CLI commands deliberately remain separate from the interactive named-command
table. `parseCli` resolves known built-ins first, preserving static help/version and
headless fast paths. Only an unknown top-level token produces an `extension-cli`
envelope and enters extension-only config/discovery. The winning registration owns
the raw subtree and runs through leased process I/O. An exit result retires the
registry before returning an exit plan; a one-time built-in delegation reparses
through the ordinary planner. Delegated reviews reconcile the already loaded
candidate/config prefix and hand the same registry to `AppBootstrap`, so factories
are not rerun merely for the handoff. Headless delegation retires before executing
the built-in plan. Terminal probing occurs only after the handler releases I/O.

## Host-served runtime modules

Extension files import `react`, `@opentui/*`, and `hunkdiff/extension` as
host-served runtime modules (`src/extensions/hostRuntimeModules.ts`): a
per-extension-directory Bun loader hook transpiles extension source and
rewrites those specifiers to prefixed virtual modules backed by the host's
own instances. That identity is what lets `registerPane` components
render inside the app's React tree with working hooks. The module header
documents why the obvious alternatives don't work (process-wide specifier
claims break the host's lazy imports; the loaders resolve lazily so headless
commands never pay OpenTUI's native-library extraction).

## Four-edge pane system

`src/ui/lib/extensionPanes.ts` owns open state, availability, and one rectangle
plan for panes, dividers, and review bounds. Left/right panes consume columns;
top/bottom panes consume rows from the central review column, outside review
stream coordinates. Pane registrations may opt into a body-axis `fraction`;
the planner resolves it to an integer target before applying bounds and lets a
session-local divider drag override that automatic size.

`src/ui/components/panes/ExtensionPane.tsx` mounts panes with guarded actions and
failure containment. `DiffPane` exposes optional current-line paint — the row
painter plus the public `{ side, line }` address — without publishing Pierre
rows, plans, cursor keys, or caches. Deprecated sidebar APIs
normalize into this same registry and layout path.

## File-view system

File-view registrations are selected per file but remain inside the one
host-owned review stream. `src/ui/fileViews/useFileViews.ts` bounds asynchronous
extension work and retains only immutable layouts accepted by
`src/ui/fileViews/layout.ts`; width and registration identity are part of that
accepted geometry. A stateful view has no such identity to change, so
`ctx.fileViews.refresh` bumps an invalidation epoch owned by
`src/ui/fileViews/useFilePresentationController.ts` and modeled in
`src/ui/fileViews/state.ts`. That epoch participates in the same retention key,
re-preparing the files presenting that view while their current rows stay
visible. One map counts both view-wide and per-file invalidation, and
`fileViewLayoutEpoch` is the single place that composes them into the epoch a
`(file, view)` preparation is retained under. `src/ui/fileViews/renderPlan.ts` is the shared insertion
plan for validated extension rows and host-owned inline notes. It resolves only
unambiguous exact-source bindings and returns an explicit unresolved set, so
`DiffPane` falls the complete file back to Pierre rather than guessing or
silently dropping review data. `src/ui/fileViews/geometry.ts` measures that same
plan, and `src/ui/components/panes/FileView.tsx` windows and paints it. Extension
components can paint only their fixed validated rectangles; note cards,
scrolling, hunk bounds, and navigation remain host-owned.

## Line-highlight system

Line highlighters mark character ranges inside Hunk's own diff rendering, so
the system is deliberately split between a pull-based preparation half and a
paint-only application half. `src/ui/highlights/useLineHighlights.ts` bounds
asynchronous extension work with the same timeout/concurrency discipline as
file views and retains only marks accepted by
`src/ui/highlights/validate.ts`; results cache under `(file, highlighter,
epoch)`, and each file's merged mark array keeps a stable identity while its
inputs are unchanged so row memoization can hold. The epoch is owned by
`src/ui/highlights/useLineHighlightsController.ts` behind
`ctx.highlights.refresh`, using the shared scoped-epoch policy in
`src/ui/lib/scopedEpochs.ts` — the same module `src/ui/fileViews/state.ts`
delegates to — and the shared bounded `readDocument` capability lives in
`src/ui/lib/extensionDocumentReader.ts`.

Application is paint-time by construction. `src/ui/diff/lineHighlightPaint.ts`
owns the one mapping from source coordinates (raw code-unit offsets) to
terminal columns — sanitize-aware, tab-aware, snapped outward to grapheme
clusters, with context and gap lines sharing one range list under both side
keys — and the one span transform that repaints backgrounds without changing
text. `src/ui/diff/rowStyle.ts` resolves tones against the actual line
background with the word-diff minimum-contrast guarantee.
`src/ui/diff/CodeRowView.tsx` applies the transform through the cell painter,
which keeps highlights out of `buildDiffSectionRowPlan`, its caches, and every
geometry measurement: a highlight change is a repaint, never a re-plan.
`src/ui/diff/DiffRowView.tsx` remains only the memoized dispatch facade; raw-row
adaptation there supports the public OpenTUI and extension current-line surfaces, while
`src/ui/diff/cursorHighlight.ts` owns stable-key cursor matching. The static pager never
runs extension code, so highlights are interactive-only.

Agent attention marks (`hunk session highlight add` / `clear`) join this same
pipeline rather than growing a second one: `useTerminalReview.ts` validates
each daemon-pushed mark with the same `validate.ts` contract and caps, holds
them per file, and `src/ui/highlights/merge.ts` appends them after extension
marks in the one map `DiffPane` paints from — so agent marks share paint,
contrast, and geometry guarantees, and win where ranges overlap. Unlike
extension marks, nothing re-derives agent marks after a reload, so
`src/ui/highlights/reconcile.ts` carries them across a document replacement only
for files whose `contentIdentity` is unchanged — those still show the same
characters — and drops the rest. Line-target `session navigate` reuses the same
`revealLine` landing policy `ctx.navigation.revealLine` gets.

`src/ui/fileViews/mode.ts` owns file-view mode activation, validity, and callback
containment. The presentation controller stores the active mode and funnels all
exit paths through one teardown, including re-entrant handoffs.

Keyboard routing checks file-view modes after focused inputs and before session
keyboard modes and app commands. `"handled"` and `"exit"` consume the key;
`"pass"` continues normal routing. Escape remains host-owned.

Session-wide modes registered through `registerKeyboardMode` are resolved with
the same extension ownership and first-registration rules as other surfaces.
`src/ui/keyboardModes/useKeyboardModeController.ts` owns the one active session
mode, with eager ref state for input chunks, registry-generation authority,
contained synchronous lifecycle callbacks, and one teardown used by Escape,
status, menu, reload, and unmount. Mode controls are activation-scoped;
`onEnter` and `onExit` cannot change ownership, while `onKey` may deliberately
replace its activation without letting the outgoing callback defeat recovery or
manipulate the replacement.
`src/ui/lib/extensionKeyEvent.ts` freezes the method-free public key snapshot
used by both session and file-view mode delivery, so OpenTUI events and their
consumption methods never cross the extension boundary. Their shared
`src/ui/lib/synchronousExtensionCallback.ts` path contains lifecycle failures,
rejects thenables without leaving unhandled rejections, and normalizes key
results; each mode module supplies only its context and attributed warnings. A
focused file-view mode may overlap and temporarily outrank a session mode;
leaving it resumes the session mode rather than destroying unrelated state.

## Command system

Every app-level keyboard shortcut is a named command in one dispatch table
(`src/ui/lib/appCommands.ts`), each id under Hunk's reserved vendor namespace
(`hunk.app.quit`, `hunk.review.nextHunk`) — which is what keeps built-in ids
and extension-owned ids in disjoint spaces however either grows; modal surfaces
(dialogs, menus, focused inputs) own their keys first and are deliberately not
commands. Extension
`registerCommand` entries join the same table via
`src/ui/lib/extensionCommands.ts` — built-ins win key conflicts, refused one
chord at a time and detected by probing matchers with a synthesized event
(`src/lib/commandKeys.ts`). Command handlers receive pane controls and a selection snapshot from
`src/ui/lib/extensionSelection.ts`, derived from the same frozen file views the
panes render plus a copied source address for the active current-line cursor.
App reads it through a ref so the dispatch table stays stable while line
navigation moves. `ctx.review.snapshot()` takes the complementary whole-review
path: `src/extensions/reviewSnapshot.ts` copies the active shared ReviewStore's
document identities and complete saved-note collections, preserving core-owned
anchors and reconciliation verdicts. App pairs that state with the producer's
current generation under the same review capability lease, so retained controls
return `null` after reload instead of reading replacement content. The extension
projection is registered in `test/review-conformance/` as a real semantic
consumer rather than rebuilding note placement in the command host.

`src/ui/lib/extensionNavigation.ts` mints the guarded navigation behind both
`ctx.navigation` and a pane's `actions`, so a jump from either surface is
validated, attributed, and reported the same way. It owns argument policy only
— visible-file validation, hunk clamping, `revealLine`'s side and line-number
checks — and delegates the move itself to the terminal review adapter. Where a
jump puts a line on screen stays host policy: `useTerminalReview` tags each
current-line reveal with a placement, and `DiffPane` reads it to choose between
stepping's minimum-distance scroll and the top-padded position hunk, note, and
`revealLine` reveals share. Extensions name a target; they never name a scroll
position.

After any named command dispatches in the terminal host, App emits
`command_executed` with its stable id. This observes the accepted action after
synchronous `AppCommand.run`, not settlement of detached extension promises.
The event decorates the assembled terminal command table, so
keyboard dispatch, menus, and extension command controls share one observation
path. Browser/session review actions lower through `ReviewIntent` instead; they
are semantic effects rather than terminal command invocations. Widget-owned
modal keys also remain outside the table and therefore outside the event.

`ctx.dialogs` is the one place extension code can interrupt the user, so its
ordering and settlement live outside React in
`src/ui/lib/extensionDialogs.ts` — one FIFO queue per App instance, minting a
per-extension `dialogs` object, normalizing (and sanitizing) extension-authored
text into a request the host draws, and answering by request id so a duplicated
Enter cannot spill onto whatever was queued behind. App subscribes with
`useSyncExternalStore`, renders the current request through
`src/ui/components/chrome/ExtensionDialog.tsx` (confirm reuses `ConfirmDialog`;
select and input are `ModalFrame` surfaces), and unmount calls `shutdown()` so
every pending and queued dialog resolves its cancel value instead of leaving a
handler awaiting forever. Key precedence in `useAppKeyboardShortcuts` places
dialogs below Hunk's own app-critical prompts (repo trust, save-on-quit) and
above menus, help, the theme selector, focused inputs, file-view modes, session
keyboard modes, and the command table: an extension may
interrupt review navigation, never a decision about the session itself. The
frame carries an `ext <id>` attribution row — the toast marker — for every
user-installed extension, because its title is extension-authored and a prompt
must not be able to impersonate Hunk. The host derives the extension's trusted
bundled origin from registry metadata and omits the redundant marker only for
Hunk-owned bundled UI. `src/ui/lib/modalGeometry.ts` clamps the frame before
extension text is wrapped or windowed, so measurement and rendering use the
same terminal width; body/options yield rows to a pinned mouse-clickable action
footer on short terminals.

Lifecycle and bus handlers receive that same attributed dialog queue plus the
same guarded live navigation commands use. `App` installs both through the
per-extension event-context provider, while `AppHost` publishes mounted
lifecycle order (`startup`, then `changeset_loaded`; reloads add
`session_reload`) only after the matching child commit. Headless or pre-mount delivery resolves
dialogs to their cancel values and refuses navigation with a warning.
`src/ui/lib/extensionCapabilityLease.ts` binds retained pane, navigation,
dialog, and workspace controls to one App, extension registry, and review
generation. Soft
reload or registry retirement therefore makes old host-mediated capabilities
inert before shutdown begins. Session behavior requests are registry data too:
`resolveExtensionSessionOptions` applies the shared policy that any
`configureSession({ viewPreferences: "transient" })` request makes practice and
presentation view changes ephemeral without teaching `App` about an extension
id.

`src/ui/lib/extensionWorkspace.ts` owns the policy for `ctx.workspace`. Reads
resolve reviewed file ids through the existing source fetcher, which retains
ownership of caching and size limits. Missing or unreadable sources become
`null`.

Writes are limited to reloadable working-tree reviews and reviewed paths inside
the review root. App supplies the current input, unfiltered changeset, and root
through refs so soft reloads update the policy inputs. The host verifies the
filesystem target before and after consent, writes it, then calls
`refreshCurrentInput`. Consent uses the existing extension-dialog queue.

Commands declare chords, not matchers: `src/ui/lib/keymap.ts` folds every
command's `defaultKeys` against the user's `[keybindings]` table (user config
layer only) into one id-to-chords answer, from which matchers, key labels, and
conflict probes are all derived — a user-bound chord is exclusive, so whatever
held it by default gives it up. The chord grammar itself lives in
`src/extension-api/keys.ts` because it is published as `hunkdiff/extension`
(`matchesKey`, `parseKeyChord`, `matchesKeyChord`) for extension components
that need internal keys; `src/lib/commandKeys.ts` re-exports it inward and
keeps the host-only pieces.

The table is also the only description of what each action is called and which
key runs it, so the mouse surfaces read from it rather than restating it: the
dropdown menus (`src/ui/lib/appMenus.ts`) declare items as command ids plus
menu-specific wording and checkbox state, and the controls help dialog
(`src/ui/lib/helpContent.ts`) declares curated rows the same way — both render
their key text from resolved `keyLabels` and run entries through
`executeAppCommand`. A few commands ship with `defaultKeys: []` because they
exist for a menu item; they never match a key but remain bindable by id.

Command handlers receive guarded `ctx.commands` controls built by
`src/ui/lib/extensionCommandControls.ts`. They resolve the live App command table on every call,
then expose only built-ins carrying explicit public metadata. Counted movement reaches the same
command callback once with a normalized delta; it is never implemented as repeated synchronous
dispatch. Current-line alignment is also semantic: App raises an alignment request and `DiffPane`
resolves it against its private row geometry, so no renderer or scrollbox leaks into the API.
Extension commands remain private to prevent recursion and cross-extension execution.

The **Extensions** menu is generated from the registered extension commands, one
item per command grouped by extension, and is absent entirely when there are
none — which is why the visible menu list is derived from the menus record
(`buildMenuSpecs` in `src/ui/components/chrome/menu.ts`) rather than fixed.

## VCS adapters

`src/core/vcs/index.ts` owns provider-neutral catalog ordering, lookup,
detection, and operation dispatch. `src/app/vcsCatalog.ts` composes bundled
registrations, while `src/app/sessionBootstrap.ts` extends that catalog with
accepted user adapters and threads the same value through loading, reload, and
watch. Detection is uniform across tiers: nearest checkout wins, priority breaks
equal-distance ties, and an explicit `vcs` id owned by the catalog wins.

Provider implementations — command construction, spawning, error translation,
and exact-source reading — live entirely under
`src/extensions/default/vcs/<provider>/`. `src/extensions/vcsPatchResult.ts` is
the one conversion boundary where a published `ExtensionVcsPatchResult`
becomes Hunk's internal diff model, including structural `too-large` source
results. `src/core/process/projectRoot.ts` treats `.hunk` as a provider-independent
bootstrap marker and also consults the available catalog; startup performs a
second root/config pass when a global, config-path, or CLI adapter recognizes a
repository unavailable to the bundled catalog.

## Public contract rules

The authoring surface is the `hunkdiff/extension` export — a façade over
internal types, declared in `src/extension-api/types.ts`. That module must
stay import-free: declaration emission ships every module the entry reaches,
so an import there publishes Hunk internals (`scripts/check-pack.ts` fails
the pack when it does, and typechecks every `docs/extensions.md` example as
a consumer). Shapes shared with internal code are declared there and
re-exported inward.
