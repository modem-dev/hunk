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
  and loaded synchronously _from VCS adapter resolution_
  (`default/vcs/index.ts`), so backends exist during config resolution — that
  load path must stay renderer-free. `default/ui/sidebar/` is deliberately not
  part of that list: it is UI code, loaded through `getBundledSidebarView`
  where the app resolves its sidebar views.

There are zero core-registered VCS adapters and no private sidebar: Git and
the built-in file navigation register through the public `registerVcsAdapter`
and `registerSidebarView` like any extension. That dogfooding is the honesty
mechanism — Git exercises every VCS integration point, the bundled sidebar
consumes exactly the public sidebar props, so a gap in the published contract
breaks Hunk's own code first.

Bundled extensions are implicitly trusted and stay loaded under
`--no-extensions`, which governs user extensions only.

An extension id is a file stem the user chose, and it is the namespace that id
owns for commands (`<extensionId>.<commandId>`), sidebar views
(`<extensionId>:<viewId>`), and config (`[extension.<id>]`). `host.ts` is the
one place those ids are vetted — discovery stays a pure filesystem walk, and
every way an id can be derived arrives there as `candidate.id`. It refuses
reserved ids (`hunk`, plus the bundled backends via `isVcsId`), ids outside
`/^[A-Za-z0-9][A-Za-z0-9_-]*$/` (a dot or colon would make the composed ids
unsplittable), and the later of two sources claiming one id; each refusal is a
load issue and costs only that extension. The rules themselves are stated in
`src/extensions/extensionIds.ts`.

## One registry, one apply path

Registrations (themes, file languages, VCS adapters, changeset transforms,
sidebar views, commands, lifecycle/UI events, and inter-extension bus listeners) collect into one
`ExtensionRegistry` (`src/extensions/types.ts`) and are resolved/applied
through `src/extensions/apply.ts` on both startup and reload. A factory that
throws is rolled back to its pre-run registration counts
(`runExtension.ts`); failures cost a warning, not the session.

## Host-served runtime modules

Extension files import `react`, `@opentui/*`, and `hunkdiff/extension` as
host-served runtime modules (`src/extensions/hostRuntimeModules.ts`): a
per-extension-directory Bun loader hook transpiles extension source and
rewrites those specifiers to prefixed virtual modules backed by the host's
own instances. That identity is what lets `registerSidebarView` components
render inside the app's React tree with working hooks. The module header
documents why the obvious alternatives don't work (process-wide specifier
claims break the host's lazy imports; the loaders resolve lazily so headless
commands never pay OpenTUI's native-library extraction).

## Sidebar system

Sidebar registration is additive: any number of views, placed left or right
of the review stream, open/closed per view, `replacesDefault` to stand in
for the bundled file navigation. `src/ui/lib/sidebarPanes.ts` is the pane
model — session view list, open-state reconciliation across reloads, and the
layout plan deciding which open panes fit at what width.
`src/ui/components/panes/ExtensionSidebarPane.tsx` mounts one view: frozen
file views in, guarded actions out, error boundary scoped to the
registration identity. The frozen views fill `changeType` and the public
`hunks` summaries from the opaque metadata at the view boundary
(`src/extensions/events.ts`, deriving through `src/core/hunkSummary.ts` — the
same helper the agent session surface reports hunks with).

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
contained synchronous lifecycle callbacks, re-entrant handoff protection, and
one teardown used by Escape, status, menu, reload, and unmount. Mode controls
are activation-scoped and invalidated before unconditional host teardown, so
`onExit` cannot defeat recovery or later manipulate a replacement.
`src/ui/lib/extensionKeyEvent.ts` freezes the method-free public key snapshot
used by both session and file-view mode delivery, so OpenTUI events and their
consumption methods never cross the extension boundary. Both mode systems use
`src/ui/lib/synchronousExtensionCallback.ts` to reject thenables without leaving
unhandled rejections. A focused file-view
mode may overlap and temporarily outrank a session mode; leaving it resumes the
session mode rather than destroying unrelated state.

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
(`src/lib/commandKeys.ts`). Command handlers receive sidebar open/close
controls, which is how a registered key opens an extension's sidebar, plus a
`selection` snapshot resolved by `src/ui/lib/extensionSelection.ts` from the
same frozen file views the sidebar panes render — one conversion feeding both
surfaces, so a command and a sidebar can never disagree about what is selected.
App reads the snapshot through a ref when a command fires, keeping the dispatch
table stable as the review moves.

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
frame always carries an `ext <id>` attribution row — the toast marker — because
the title is extension-authored and a prompt must not be able to impersonate
Hunk.

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

`src/core/vcs/index.ts` is the single assembly point ordering bundled + user
adapters by `detectionPriority` (Git is the baseline at 0; jj 200 / sl 100
sit above it for colocated checkouts — the constants in
`src/extension-api/types.ts` document the reasoning). Detection is uniform
across tiers: nearest checkout wins, priority breaks equal-distance ties, an
explicit `vcs` id a loaded backend owns beats detection
(`src/extensions/apply.ts`). `src/extensions/vcsPatchResult.ts` is the one
conversion boundary where a published `ExtensionVcsPatchResult` becomes
Hunk's internal diff model — anything a backend needs that cannot be
expressed publicly is a real gap in the contract.

## Public contract rules

The authoring surface is the `hunkdiff/extension` export — a façade over
internal types, declared in `src/extension-api/types.ts`. That module must
stay import-free: declaration emission ships every module the entry reaches,
so an import there publishes Hunk internals (`scripts/check-pack.ts` fails
the pack when it does, and typechecks every `docs/extensions.md` example as
a consumer). Shapes shared with internal code are declared there and
re-exported inward.
