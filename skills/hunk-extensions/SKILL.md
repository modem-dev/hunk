---
name: hunk-extensions
description: Maps the `hunkdiff/extension` authoring surface for Hunk, the terminal diff viewer — hiding or reordering reviewed files, docked panes, alternate file views, commands and key bindings, dialogs, workspace writes, themes, syntax languages, VCS backends, lifecycle events. Use when writing, debugging, or installing a Hunk extension, or when a request asks Hunk itself to behave differently. Not for reviewing a diff in a live session — that is hunk-review.
---

# Building Hunk extensions

A Hunk extension is **one TypeScript (or JSX/JS) file that default-exports a
factory**. Hunk imports it at startup and hands it an API object. No build step,
no manifest required.

```ts
// ~/.config/hunk/extensions/hello.ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.on("startup", (_event, ctx) => ctx.notify("Hello"));
}
```

This skill is a map of the touchpoints, not a recipe. Decide what to build from
the user's request; use the table below to find the call, then read the linked
material before writing code.

## Sources of truth — read before writing

| Source                                  | What it answers                                              |
| --------------------------------------- | ------------------------------------------------------------ |
| `docs/extensions.md`                    | The authoring guide. Every call, every rule. Start here.     |
| `src/extension-api/types.ts`            | The contract — exact field names, optionality, doc comments. |
| `examples/extensions/*`                 | Working extensions. Copy these patterns rather than invent.  |
| `docs/extension-architecture.md`        | Hunk's internals. Needed only when changing the host.        |
| `docs/keybindings.md`, `docs/themes.md` | Chord grammar and theme token rules that extensions inherit. |

Outside a Hunk checkout the guide is split across
<https://hunk.dev/docs/extend/extensions/> (discovery, trust, config) and its
companion pages — extension-api, file-previews, vcs-adapters, custom-panes —
and the contract ships as `node_modules/hunkdiff/dist/npm/extension/index.d.ts`.

The examples, by what they demonstrate:

- `review-triage/` — pane + commands + all three dialog shapes + lifecycle
  events + the extension event bus + a `useSyncExternalStore` bridge.
- `inline-edit/` — an interactive file-view `mode` driving `ctx.workspace` writes;
  its README explains the async lifetime rules better than anything else in tree.
- `rendered-markdown/` — a file view producing host-rendered rows from parsed
  Markdown, and a folder extension with an npm dependency.
- `jsx-file-view/`, `jsx-file-view-gallery/` — the experimental fixed-height JSX
  row component contract.

## Where extensions live

| Source                                     | Trust            |
| ------------------------------------------ | ---------------- |
| `--extension <path>` (repeatable)          | runs immediately |
| `[extensions] paths` in user config        | runs immediately |
| `~/.config/hunk/extensions/` (XDG-aware)   | runs immediately |
| `.hunk/extensions/` or repo-config `paths` | **trust prompt** |

Only the repo-local group is gated. Everything else — including `--extension`,
even when its path points inside the repository under review — is read as
explicit user intent and executes with full user permissions, no prompt. Never
pass or suggest a path you have not read, including one copied from a
repository's own README.

A directory matches `*.ts`/`*.tsx`/`*.js`/`*.jsx`/`*.mjs` at its top level, plus
one level of folder extensions. A folder is an extension if it has a
`package.json` with `{"hunk": {"extensions": ["./index.ts"]}}`, or an
`index.{ts,tsx,js,jsx,mjs}`. Reach for a folder only when you need npm
dependencies, helper modules, or a README; a single file keeps the install to one
`cp`. A `.hunk/extensions/` folder extension's `node_modules` has to exist on
every machine that loads it — keep a repo-shared extension dependency-free.

Shared extensions install from git with `hunk extension install <source>`
(`owner/repo[@ref]`, `git:host/path[@ref]`, a git URL, or a local path) into
`~/.config/hunk/extensions/installed/<repo-name>/`, where they load with global
origin; `list`, `update`, and `remove` manage them. Declared `dependencies` are
`bun install`ed at install time. The manifest may state
`{"hunk": {"apiVersion": N}}` — the minimum extension API version — and an older
Hunk refuses the extension with a startup notice instead of failing mid-factory.
To publish, push the folder-extension layout to a git repository's root with
real `name`/`version`/`description`, tag releases for `@ref` pins, and add the
`hunk-extension` GitHub topic so it appears at
<https://github.com/topics/hunk-extension>.

The **id** is the file stem, or the folder name for a folder extension — unless
its manifest declares several entries, in which case each entry is its own
extension named by its own stem (numeric suffix on collision). The id is the
namespace it owns: commands are `<id>.<commandId>`, panes and keyboard modes
are `<id>:<localId>`, config `[extension.<id>]`. Ids match
`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`; `hunk`, `git`, `jj`, and `sl` are reserved. A
bad or duplicate id is skipped with a startup notice.

## Pick the touchpoint

| To do this                                               | Call                                         |
| -------------------------------------------------------- | -------------------------------------------- |
| Keep demo/training view settings temporary               | `hunk.configureSession(options)`             |
| Add a selectable color theme                             | `hunk.registerTheme(theme)`                  |
| Highlight an extension, exact filename, or filename glob | `hunk.registerFileLanguage(matcher, lang)`   |
| Support another VCS (`git`/`jj`/`sl` are reserved)       | `hunk.registerVcsAdapter(adapter)`           |
| Add a navigation/list/status pane beside the review      | `hunk.registerPane(pane)`                    |
| Present a file as something other than a raw diff        | `hunk.registerFileView(view)` (experimental) |
| Mark character ranges inside diff lines                  | `hunk.registerLineHighlighter(highlighter)`  |
| Interpret review keys as a temporary global mode         | `hunk.registerKeyboardMode(mode)`            |
| Add a generic top-level CLI command tree                 | `hunk.registerCliCommand(command, handler)`  |
| Bind a key / add an Extensions-menu entry                | `hunk.registerCommand(command, handler)`     |
| Hide, reorder, retitle files before review               | `hunk.transformChangeset(fn)`                |
| React to loads, selection, view movement, notes, reloads | `hunk.on(event, handler)`                    |
| Coordinate with another loaded extension                 | `hunk.events.emit` / `hunk.events.on`        |
| Reload after an external agent changes reviewed inputs   | `ctx.review.requestReload()` in an event     |
| Read user-supplied settings                              | `hunk.config` (`[extension.<id>]` table)     |
| Snapshot stable files and every saved review note        | `ctx.review.snapshot()` in a command         |
| Branch on the API generation (currently `18`)            | `hunk.apiVersion`                            |

Registration is only valid while the factory runs — Hunk seals the API object
afterwards.

### Generic CLI handlers

Register one lowercase-kebab top-level token; the handler owns every raw token
below it. Built-ins and aliases cannot be shadowed, and discovery order makes
the first extension claim win. During development, place the explicit path
before the extension command:

```bash
hunk --extension ./my-ext.ts my-command sync --help
```

The handler receives frozen args plus `ctx.cwd`, `ctx.signal`, streaming
`ctx.stdin`, and leased `ctx.stdout`/`ctx.stderr` writers. `summary` and
`usage` are listed when a token reaches discovery unclaimed, so write them as
one short line each. Return `{ kind:
"exit", code? }` or `{ kind: "delegate", argv: ["diff", ...] }`. Delegation is
built-in-only and one-time: do not write stdout or read stdin before delegating;
use stderr for progress. Reading stdin is an exit-only workflow. Respect cancellation promptly.
Repo-local providers remain trust-gated; `--no-extensions` performs no discovery
or import, while a leading explicit `--extension` path is immediate consent.

Use `examples/extensions/github-pr/` as the reference for a complete CLI
preprocessor: direct authenticated HTTP with cancellation, temporary artifacts
with platform-accurate permission claims retained through delegated startup,
cleanup on `shutdown`, and a
one-time handoff to built-in `patch` without touching stdin or stdout.

## What handlers receive

Every event, bus, command, and file-view mode handler — plus every changeset
transform — gets `ctx.cwd` and `ctx.notify(message, type?)`. A file view's
`matches` and `layout` get no context at all. Beyond that:

- **Event and bus handlers** also get `ctx.panes` (open/close/toggle/isOpen on
  any pane), live `ctx.navigation`, attributed `ctx.dialogs`, review reloads through
  `ctx.review.requestReload()`, and
  `ctx.events.emit`. `ctx.sidebars` is a deprecated alias for `ctx.panes`.
- **Command handlers** get `ctx.panes`, `ctx.fileViews` (select/toggle/isActive/
  refresh/enterMode/exitMode), `ctx.highlights` (refresh prepared line marks,
  whole or `{ fileId }`-scoped), `ctx.selection` (a snapshot of file, hunk index,
  and nullable current `{ side, line }` source address), `ctx.navigation` (live,
  guarded `selectFile`/`selectHunk`/`revealLine`, the
  last landing one exact `(side, line)` near the viewport top), `ctx.commands`
  (`isEnabled`/`execute` for public semantic `hunk.*` commands),
  `ctx.keyboardModes` (enter/exit/probe this extension's session modes), `ctx.review`
  (deeply immutable snapshots of stable files and complete saved store notes),
  `ctx.dialogs` (`confirm`/`select`/`input`, queued and attributed), and
  `ctx.workspace` (`readDocument`, `canWriteDocument`, `writeDocument` with consent).
- **Pane components** get frozen `files`, selection, placement, exact dimensions,
  nullable immutable delegated-source `review` metadata, optional `currentLine` paint
  (with `{ side, line }` when opted in), semantic `theme`, resolved `keybindings`, and
  guarded navigation/notification `actions`. Availability callbacks receive the same
  `review` value, so a pane can consume no geometry for ordinary reviews.
- **File-view `layout`** gets `file`, `width`, `signal`, `changes`, and a lazy
  `readDocument(side)`.
- **File-view `mode` handlers** get `ctx.file` and `ctx.fileViews`. `onKey`,
  `onEnter`, and `onExit` must answer **synchronously** — `onKey`'s return value
  (`"handled"`/`"pass"`/`"exit"`) is the routing decision, so kick off async work
  and report it later through `notify` or `refresh`. A passed key reaches any
  active session keyboard mode before ordinary Hunk routing. Escape is host-owned
  and never reaches `onKey`.
- **Session keyboard-mode handlers** get only `ctx.commands` and activation-scoped
  `ctx.keyboardModes` beyond the standard context. Those controls become inert on
  exit, and lifecycle callbacks cannot change keyboard ownership. Keys are frozen
  snapshots; dialogs, focused inputs, and file-view modes outrank them. When the
  session mode owns input, Escape exits it; the status badge and Extensions menu
  are unconditional host-owned exits.

Event payloads, pane props, and a command's selection all hand you frozen
`ExtensionDiffFile` / `ExtensionDiffHunk` views. A changeset transform is the
exception: it receives the live changeset and is expected to return a new one.
`metadata` is unfrozen either way — it is the renderer's parsed diff, so pass it
through untouched.

## Rules that bite

Most extension bugs are one of these:

- **Registering a surface does not show it.** Panes need `defaultOpen`,
  `replaces: "hunk:files"`, or a command that opens them. File views remain raw
  until selected from the **View** menu.
- **A rejected file-view layout silently becomes raw diff.** `hunkRows` needs one
  in-bounds, inclusive entry per parsed hunk at the same array index, and
  `sourceRanges` may not overlap on a side; invalid, oversized, cancelled, and
  throwing layouts warn once and fall back.
- **Never bundle or vendor React.** Hunk serves its own `react` and `@opentui/*`
  to extension files; a second copy means a second hooks dispatcher and the
  component fails to render. Import them normally. OpenTUI intrinsics (`box`,
  `text`, `scrollbox`) need no import.
- **`layout` is a pure derivation of `(file, width)`.** A stateful view keeps
  painting its first answer until `ctx.fileViews.refresh(viewId)` — scope it with
  `{ fileId }` when the state belongs to one file.
- **Handler state must live outside the component.** Panes unmount when closed;
  bridge module-level state into React with `useSyncExternalStore` and immutable
  snapshots (`review-triage/index.tsx` is the working version).
- **Use `ctx.review.snapshot()` for complete saved-note state.** `note_created` and
  `note_edited` are incremental UI events, not an authoritative collection. Snapshots
  include stale and orphaned saved notes, exclude drafts and static sidecar annotations,
  and should be re-read before irreversible async work; compare both generation and revision.
  `review-note-navigator` shows how to join stable note ids and file keys back to guarded
  navigation after awaiting a selector; file filters can still refuse hidden targets.
- **Retained review controls expire on reload.** An old handler cannot control
  replacement content: pane/navigation calls become inert, dialogs cancel, and
  workspace reads or not-yet-started writes return `null`/`unavailable`. A
  consented write already in progress reports its real outcome, holds graceful
  exit until it settles, and reconciles the active review on success. `shutdown`
  runs after revocation, so use it only
  to release extension-owned resources.
- **A reload keeps your factory and renames the files.** Factories re-run only
  after a trust grant or a cwd change, so module state survives — but a file's
  `id` encodes its position in the changeset, so a reload that adds or drops a
  file renumbers the rest. Key durable per-file state by `path`, or reconcile it
  on `changeset_loaded`. Pick one deliberately.
- **Transforms must preserve `metadata`** (spreading a file does), keep ids
  unique, and return a real changeset — otherwise the transform is skipped with a
  warning and the previous changeset carries forward.
- **Chords are defaults.** Users remap by command id in `[keybindings]`; built-ins
  win conflicts, refused one chord at a time. Bind the character shift produces
  (`"!"`, not `"shift+1"`).
- **Keyboard modes are grammar, not behavior.** Keep pending sequences and
  numeric prefixes in the extension, then call one public `ctx.commands.execute`
  after resolving an action. `vim-navigation` demonstrates counts, Ctrl chords,
  and a `:` key passed to a registered command whose host input dialog temporarily
  outranks the still-active mode.
- **`ctx.commands` invokes Hunk, not other extensions.** Probe with
  `isEnabled("hunk.review.nextHunk")`, then call `execute(id, { count })` for an
  explicitly public built-in. Counts are positive whole numbers up to 10,000,
  applied atomically to movement; one-shot actions run once. Unknown, disabled,
  private, extension-owned, or stale commands return `false`.
- **Repo config can set `[extension.<id>]` for a globally installed extension.**
  Treat `hunk.config` as untrusted for anything exec-adjacent (binary paths,
  shell commands, module loading).
- **`ctx.workspace` writes only apply to reloadable, unstaged working-tree
  reviews**, by reviewed file id, inside the review root, with consent. Everything
  else returns `{ ok: false, reason }` — check `canWriteDocument` first.
- **File-view note placement is all-or-raw per file**: an unbound or range-less
  visible note makes Hunk render the complete raw diff instead of guessing.
- **Failures are contained, not sandboxed.** A throwing factory is rolled back to
  zero registrations and a throwing handler is a warning naming the extension —
  containment against bugs, not against code that should not have been loaded.
- **The API touches nothing outside the review.** No clipboard, no filesystem, no
  process surface beyond `ctx.workspace` — an extension is ordinary code, so shell
  out for the rest. Never write to stdout: the renderer owns it. For the same
  reason `hunk.log` is collected as diagnostics and printed nowhere; `ctx.notify`
  is how a user hears from you.
- **`HunkExtensionUserError`** (detected structurally by `name`) buys the full
  treatment — message plus `suggestions`, no stack trace — only from a VCS adapter
  operation, which is where Hunk formats it for the CLI. From a command or event
  handler only the message survives, as a warning toast.

## Verifying

Hunk's TUI needs a real terminal, and the review UI is the user's — **do not
launch `hunk diff`/`hunk show` to test, and do not reach for a pipe.** No
invocation applies extensions headlessly: `hunk diff … | cat` still starts the
app and still takes the keyboard, so it hangs holding the user's terminal.
Practical checks, in order of cost:

1. **Typecheck.** In a checkout, `bun run typecheck` covers
   `examples/extensions/**` via the `hunkdiff/extension` path mapping. Standalone,
   add `hunkdiff` as a dev dependency and run `tsc --noEmit`; for a `.tsx`
   extension also add `react`, `@types/react` (React ships no declarations of its
   own), `@opentui/core`, and `@opentui/react` as **dev** dependencies and set
   `"jsx": "react-jsx"` with
   `"jsxImportSource": "@opentui/react"`, or every `<box>` and `<text>` is an
   untyped intrinsic. Types only — shipping those packages is the second-React bug.
2. **Unit-test the logic.** When parsing, matching, or formatting is worth
   testing, put it in helper modules with plain `bun test` coverage.
3. **PTY integration.** In a checkout, `test/pty/extensions-integration.test.ts`
   launches Hunk over a PTY with `--extension <path>` and asserts on rendered
   snapshots; extend it via `test/pty/harness.ts` and run `bun run test:integration`.
4. **Hand it to the user** to run: `hunk diff --extension ./my-ext`. `--extension`
   loads immediately with no trust prompt, so it is the iteration path. Ask them
   what the footer notices and toasts said.
5. **Triage with `--no-extensions`** to confirm a symptom belongs to an extension
   (bundled VCS backends and the built-in files pane stay loaded either way).

## If it does not load

- No startup notice at all → a successful load is silent, so either it loaded and
  nothing opened it, or discovery never saw the file. Check the directory, the
  entry suffix, or the folder's `package.json` `hunk.extensions` paths.
- Notice naming the extension → id rejected (reserved, malformed, or already
  claimed), import failure, missing default export, or a throwing factory.
- Repo-local extension silently absent → the trust prompt was dismissed or denied;
  decisions are stored per repo root in `~/.config/hunk/state.json`.
- Pane closes with a toast → the component threw; a second React copy is
  the usual cause.
- Pane or file view never appears → nothing opened it (no `defaultOpen`, no
  command), `matches` returned false, or the layout was rejected.
- Command never fires → its chord lost to a built-in or an earlier extension (a
  warning says so); it is still reachable from the **Extensions** menu and
  bindable by `<id>.<commandId>`.

## Changing Hunk itself

Only when the work is in the `hunk` repo rather than in a user extension:

- Shipped VCS backends and the built-in files pane are **bundled extensions** in
  `src/extensions/default/`, registering through the same public API. That
  dogfooding is deliberate — if the public contract cannot express something,
  that is a real gap, not a reason for a private path. `default/vcs/` loads from
  VCS adapter resolution and must stay renderer-free.
- `src/extension-api/types.ts` must stay **import-free**; declaration emission
  publishes whatever it reaches, and `scripts/check-pack.ts` fails the pack
  otherwise. Shapes shared with internal code are declared there and re-exported
  inward.
- New API surface means updating `docs/extensions.md` (its examples are
  typechecked as consumer code), the matching hand-written page under
  `website/src/content/docs/docs/extend/` (only `cli.md` and `config.md` are
  generated), `docs/extension-architecture.md` if ownership moves, and a changeset.
- `AGENTS.md` and `docs/extension-architecture.md` own the rest of these rules.
