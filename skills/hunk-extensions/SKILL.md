---
name: hunk-extensions
description: Guides building extensions for Hunk (the terminal diff viewer) against the `hunkdiff/extension` API — themes, file languages, VCS backends, sidebar views, file views, commands, dialogs, workspace writes, changeset transforms, and lifecycle events. Use when asked to write, extend, debug, or review a Hunk extension, or when a request needs Hunk to show or do something it does not do out of the box.
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

| Source                                  | What it answers                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `docs/extensions.md`                    | The authoring guide. Every call, every rule, worked examples. Start here.     |
| `src/extension-api/types.ts`            | The contract itself — exact field names, optionality, doc comments.           |
| `examples/extensions/*`                 | Installable, working extensions. Copy patterns from these rather than invent. |
| `docs/extension-architecture.md`        | Hunk's internals: which module owns what. Needed only when changing the host. |
| `docs/keybindings.md`, `docs/themes.md` | Chord grammar and theme token rules that extensions inherit.                  |

Outside a Hunk checkout the same guide lives at <https://hunk.dev/docs/extend/extensions/>
and the contract ships as `node_modules/hunkdiff/dist/npm/extension/index.d.ts`.

The examples, by what they demonstrate:

- `review-triage/` — sidebar + commands + all three dialog shapes + lifecycle
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

A directory matches `*.ts`/`*.tsx`/`*.js`/`*.jsx`/`*.mjs` at its top level, plus
one level of folder extensions. A folder is an extension if it has a
`package.json` with `{"hunk": {"extensions": ["./index.ts"]}}`, or an `index.*`.
Folder extensions may depend on npm packages — install into the folder's own
`node_modules`.

The **id** is the file stem (or folder name), and it is the namespace the
extension owns: commands are `<id>.<commandId>`, sidebar views `<id>:<viewId>`,
config `[extension.<id>]`. Ids match `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`; `hunk`,
`git`, `jj`, and `sl` are reserved. A bad or duplicate id is skipped with a
startup notice.

## Pick the touchpoint

| To do this                                             | Call                                         |
| ------------------------------------------------------ | -------------------------------------------- |
| Add a selectable color theme                           | `hunk.registerTheme(theme)`                  |
| Highlight an unrecognized file extension               | `hunk.registerFileLanguage(ext, lang)`       |
| Support another VCS, or change how one is diffed       | `hunk.registerVcsAdapter(adapter)`           |
| Add a navigation/list/status pane beside the review    | `hunk.registerSidebarView(view)`             |
| Present a file as something other than a raw diff      | `hunk.registerFileView(view)` (experimental) |
| Bind a key / add an Extensions-menu entry              | `hunk.registerCommand(command, handler)`     |
| Hide, reorder, retitle files before review             | `hunk.transformChangeset(fn)`                |
| React to loads, selection, notes, theme, reloads, exit | `hunk.on(event, handler)`                    |
| Coordinate with another loaded extension               | `hunk.events.emit` / `hunk.events.on`        |
| Read user-supplied settings                            | `hunk.config` (`[extension.<id>]` table)     |
| Branch on the API generation (currently `2`)           | `hunk.apiVersion`                            |

Registration is only valid while the factory runs — Hunk seals the API object
afterwards.

## What handlers receive

Every handler and transform gets `ctx.cwd` and `ctx.notify(message, type?)`.
Beyond that:

- **Event and bus handlers** also get `ctx.sidebars` (open/close/toggle any view)
  and `ctx.events.emit`.
- **Command handlers** get `ctx.sidebars`, `ctx.fileViews` (select/toggle/refresh/
  enterMode), `ctx.selection` (a snapshot of file + hunk index at invocation),
  `ctx.navigation` (live, guarded `selectFile`/`selectHunk`), `ctx.dialogs`
  (`confirm`/`select`/`input`, queued and attributed), and `ctx.workspace`
  (`readDocument`, `canWriteDocument`, `writeDocument` with consent).
- **Sidebar components** get props: `files` (frozen, filtered, review order, each
  with `hunks` summaries), `selectedFileId`, `selectedHunkIndex`, `width`,
  `theme` (hex tokens — see `ExtensionPaintTheme`), `keybindings` (ask by command
  id, never hard-code a chord), and `actions` (`selectFile`, `selectHunk`,
  `notify`).
- **File-view `layout`** gets `file`, `width`, `signal`, `changes`, and a lazy
  `readDocument(side)`.

Public file/hunk data is always the frozen `ExtensionDiffFile` /
`ExtensionDiffHunk` shape; the opaque `metadata` is the renderer's parsed diff and
should only ever be passed through untouched.

## Rules that bite

Most extension bugs are one of these:

- **Never bundle or vendor React.** Hunk serves its own `react` and `@opentui/*`
  to extension files; a second copy means a second hooks dispatcher and the
  component fails to render. Import them normally. OpenTUI intrinsics (`box`,
  `text`, `scrollbox`) need no import.
- **`layout` is a pure derivation of `(file, width)`.** A stateful view keeps
  painting its first answer until `ctx.fileViews.refresh(viewId)` — scope it with
  `{ fileId }` when the state belongs to one file.
- **Handler state must live outside the component.** Panes unmount when closed;
  bridge module-level state into React with `useSyncExternalStore` and immutable
  snapshots.
- **Transforms must preserve `metadata`** (spreading a file does), keep ids
  unique, and return a real changeset — otherwise the transform is skipped with a
  warning and the previous changeset carries forward.
- **Chords are defaults.** Users remap by command id in `[keybindings]`; built-ins
  win conflicts, refused one chord at a time. Bind the character shift produces
  (`"!"`, not `"shift+1"`).
- **Repo config can set `[extension.<id>]` for a globally installed extension.**
  Treat `hunk.config` as untrusted for anything exec-adjacent (binary paths,
  shell commands, module loading).
- **`ctx.workspace` writes only apply to reloadable, unstaged working-tree
  reviews**, by reviewed file id, inside the review root, with consent. Everything
  else returns `{ ok: false, reason }` — check `canWriteDocument` first.
- **File-view note placement is all-or-raw per file**: an unbound or range-less
  visible note makes Hunk render the complete raw diff instead of guessing.
- **Failures are contained, not sandboxed.** A throwing factory is rolled back to
  zero registrations; a throwing handler is a warning naming the extension. But
  extensions run with full user permissions — that containment protects against
  bugs, not against code that should not have been loaded.
- **`hunk.log` is collected as diagnostics, not printed** (the TUI owns the
  screen). Use `ctx.notify` for anything a user should see, or write your own file.
- **Throw `HunkExtensionUserError`** (detected structurally by `name`) for
  problems the user can fix — it prints the message plus `suggestions` with no
  stack trace.

## Verifying

Hunk's TUI needs a real terminal, and the review UI is the user's — **do not
launch `hunk diff`/`hunk show` interactively to test.** Practical checks, in
order of cost:

1. **Typecheck.** In a checkout, `bun run typecheck` covers
   `examples/extensions/**` via the `hunkdiff/extension` path mapping. Standalone,
   add `hunkdiff` as a dev dependency and run `tsc --noEmit`.
2. **Unit-test the logic.** Keep parsing, matching, and formatting in helper
   modules with plain `bun test` coverage; keep the factory thin.
3. **PTY integration.** In a checkout, `test/pty/extensions-integration.test.ts`
   launches Hunk over a PTY with `--extension <path>` and asserts on rendered
   snapshots; extend it via `test/pty/harness.ts` and run `bun run test:integration`.
4. **Hand it to the user** to run: `hunk diff --extension ./my-ext`. `--extension`
   loads immediately with no trust prompt, so it is the iteration path. Ask them
   what the footer notices and toasts said.
5. **Triage with `--no-extensions`** to confirm a symptom belongs to an extension
   (bundled VCS backends stay loaded either way).

## If it does not load

- No startup notice at all → discovery never saw the file. Check the directory,
  the entry suffix, or the folder's `package.json` `hunk.extensions` paths.
- Notice naming the file → id rejected (reserved, malformed, or already claimed),
  import failure, missing default export, or a throwing factory.
- Repo-local extension silently absent → the trust prompt was dismissed or denied;
  decisions are stored per repo root in `~/.config/hunk/state.json`.
- Sidebar pane closes with a toast → the component threw; a second React copy is
  the usual cause.
- Command never fires → its chord lost to a built-in or an earlier extension (a
  warning says so); it is still reachable from the **Extensions** menu and
  bindable by `<id>.<commandId>`.

## Changing Hunk itself

Only when the work is in the `hunk` repo rather than in a user extension:

- Shipped VCS backends and the built-in sidebar are **bundled extensions** in
  `src/extensions/default/`, registering through the same public API. That
  dogfooding is deliberate — if the public contract cannot express something,
  that is a real gap, not a reason for a private path.
- `src/extension-api/types.ts` must stay **import-free**; declaration emission
  publishes whatever it reaches, and `scripts/check-pack.ts` fails the pack
  otherwise. Shapes shared with internal code are declared there and re-exported
  inward.
- `src/extensions/default/vcs/` loads from VCS adapter resolution and must stay
  renderer-free.
- New API surface means updating `docs/extensions.md` (its examples are
  typechecked as consumer code), `docs/extension-architecture.md` if ownership
  moves, and adding a changeset with `bun run changeset`.
