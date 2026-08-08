# Changelog

## 0.18.0

### Minor Changes

- [#570](https://github.com/modem-dev/hunk/pull/570) [`94d61e1`](https://github.com/modem-dev/hunk/commit/94d61e173c1934513b53b178f3b3c2e55ae98aa5) - Add exact Shiki/TextMate syntax color overrides under `custom_theme.syntax_scopes`, while temporarily translating the deprecated `custom_theme.syntax` role table for compatibility.

- [#629](https://github.com/modem-dev/hunk/pull/629) [`e65e84a`](https://github.com/modem-dev/hunk/commit/e65e84a1d0f3d381c95a0626899ffb12c9d43192) - Extension command handlers can now navigate the review stream: `ctx.navigation.selectFile(fileId)` and `ctx.navigation.selectHunk(fileId, hunkIndex)` carry the same guarded navigation a custom sidebar's `actions` do — validated against the currently visible files, hunk indexes clamped, failures reported as warnings — routed through the same review controller, so a "jump to the next flagged hunk" command no longer needs a mounted sidebar to move the selection. Unlike `ctx.selection`, which stays a snapshot from when the key fired, `navigation` is live: a handler that awaits a dialog and then navigates acts on the review as it is now.

- [#616](https://github.com/modem-dev/hunk/pull/616) [`fe21ef9`](https://github.com/modem-dev/hunk/commit/fe21ef9ee3fbac7e9ee8366e6f88b65bf6e48605) - Extension command handlers receive the current review selection as `ctx.selection` — the selected file as a frozen read-only view plus its selected hunk index, captured when the command fires. A command that acts on what the user is looking at (copy this path, open this hunk elsewhere) no longer has to shadow-track the `selection_changed` event to know where the review is.

- [#588](https://github.com/modem-dev/hunk/pull/588) [`928f607`](https://github.com/modem-dev/hunk/commit/928f607d897227b10ad3453f397c684dec54a18d) - Render source tabs at four-column stops by default and add `tab_width`, `-x`, and `--tab-width` overrides for projects with different conventions.

- [#632](https://github.com/modem-dev/hunk/pull/632) [`86bf722`](https://github.com/modem-dev/hunk/commit/86bf722550fa0e4552b62e6a90e06cc32d5199f9) - Experiment with fixed-height React and OpenTUI row components in extension file views, with a shared live semantic paint theme, while Hunk retains review-stream geometry, windowing, hunk navigation, inline-note placement, and symbolic fallback. Advance the extension API to version 2 for the streamlined file-view contract, with checked-in TypeScript, CSS palette, and dependency-delta demos.

- [#662](https://github.com/modem-dev/hunk/pull/662) [`5150d21`](https://github.com/modem-dev/hunk/commit/5150d211babd504a05219891d40b5f9ac78fd80f) - Highlight the current line and move it with `j`/`k`, so `c` adds a note exactly where the cursor sits. Set `cursor_line` to `number` for a quieter line-number marker, or `off` to restore plain row scrolling.

- [#617](https://github.com/modem-dev/hunk/pull/617) [`548f56d`](https://github.com/modem-dev/hunk/commit/548f56d9985e187bbcb069573e3263852742a74a) - Extension command handlers can ask the user a question through `ctx.dialogs`: `confirm` for a yes/no prompt, `select` for a list of choices, and `input` for a line of text, each returning a promise that resolves the answer (or a cancel value on Escape). Hunk draws the modal itself and labels it with the extension that raised it, one dialog shows at a time with concurrent requests queued in call order, and a dialog still pending when the review goes away resolves as cancelled instead of leaving a handler waiting.

- [#619](https://github.com/modem-dev/hunk/pull/619) [`926324d`](https://github.com/modem-dev/hunk/commit/926324d978b430e08284626ea9827528f4dd17f6) - Add extension UI lifecycle events, sidebar controls for event handlers, and an inter-extension event bus.

- [#599](https://github.com/modem-dev/hunk/pull/599) [`883fad7`](https://github.com/modem-dev/hunk/commit/883fad7920a3039dbc1038a0d40ea5b2ec4feab0) - Add an experimental TypeScript extension system (phase 1). The `hunkdiff/extension` API may change in breaking ways between minor releases while it stabilizes; breaking changes will be called out in release notes. Hunk now loads user extensions from `~/.config/hunk/extensions/`, repo-local `.hunk/extensions/` (behind a trust prompt), `[extensions] paths` in config, and a repeatable `--extension` flag (`--no-extensions` disables loading). Extensions export a default factory receiving the `hunkdiff/extension` API and can register themes, file-language mappings, and VCS adapters, transform the loaded changeset, subscribe to lifecycle events (`startup`, `changeset_loaded`, `selection_changed`, `session_reload`, `shutdown`), read their own `[extension.<id>]` config table, and show toast notifications. Every VCS backend Hunk ships — Git, Jujutsu, and Sapling — is now a bundled extension registered through that same API, with no core-registered adapter left, so extension VCS adapters are first-class: they can set a detection priority, report untracked paths, supply exact old/new file contents for context expansion and syntax highlighting, list files reviewed outside the patch (including too-large placeholders), honor `--color-moved`, support `--watch` through optional watch signatures and watch plans, and raise user-facing failures with suggestions through `HunkExtensionUserError`. `--no-extensions` and `[extensions] enabled = false` scope to user extensions, so VCS support is never disabled by them. Custom themes are also generalized from the single `[custom_theme]` slot to any number of named `[themes.<id>]` tables. See `docs/extensions.md` for the authoring guide.

- [#675](https://github.com/modem-dev/hunk/pull/675) [`efa2203`](https://github.com/modem-dev/hunk/commit/efa2203f86845e1da5849ae64fe7cd50ceeba06e) - Extension file views can register an opt-in keyboard mode that routes keys to the view ahead of the command table, with Escape always exiting.

- [#673](https://github.com/modem-dev/hunk/pull/673) [`378ec4b`](https://github.com/modem-dev/hunk/commit/378ec4b3f7043dcd8ceecec2d22041a71e7bf8b1) - Extension file views can now refresh their prepared layouts with `fileViews.refresh`, letting stateful views redraw without a file or width change.

- [#615](https://github.com/modem-dev/hunk/pull/615) [`1501eb6`](https://github.com/modem-dev/hunk/commit/1501eb669e807061bd9ff70dd9e9e8351ac3e64c) - Expose resolved command keybindings to custom extension sidebar components so local handlers honor user remapping and unbinding.

- [#512](https://github.com/modem-dev/hunk/pull/512) [`8a8dbc7`](https://github.com/modem-dev/hunk/commit/8a8dbc7b014cdd0eb9554b9f7677948d5deb6108) - Agent notes can now carry STML markup (**experimental**) — a small HTML-like markup rendered as real terminal UI inside the inline note card (bordered boxes, rows of shapes, gauges, lists, badges, code blocks, styled text). Provide it via the `markup` field on agent-context sidecar annotations, `hunk session comment add --markup`, or a `markup` field on `comment apply` batch items; the plain `summary` stays as the fallback and list view text. While the feature is experimental, the tag and color vocabulary may change between releases without a major bump.

  Two new commands make markup easy to author well: `hunk markup guide` prints a pattern-driven authoring guide (gauges, pipelines, scorecards, checklists), and `hunk markup render (<file> | -)` previews markup as terminal text at any width without launching the TUI, with render notes on stderr or in `--json` output. Markup feedback follows the live session geometry: `hunk session context` reports `noteMarkupWidth` (the width notes render at in the current layout and terminal size), and `comment add`/`apply` responses echo the `markupWidth` they validated at plus `markupNotes` when the markup degraded — so agents design for the width the user is actually looking at, whether that is a narrow split dock or a full-width unified pane on a large screen.

- [#614](https://github.com/modem-dev/hunk/pull/614) [`fa0500d`](https://github.com/modem-dev/hunk/commit/fa0500d5dbca558fabfc7be705b1e4d08c26bf89) - Menus and the controls help dialog now show the keys your commands are actually on. Both are built from the same command table the keyboard dispatches through, so a shortcut remapped in `[keybindings]` is advertised under its new key everywhere instead of only in the config file, and a command you unbind stops claiming a key it no longer answers to.

  Extensions get a menu of their own: registered commands are listed in a new **Extensions** menu with their titles and current keys, grouped per extension. A command whose chord was already taken — or that never declared one — is still reachable there with the mouse. The menu appears only when an extension registered a command.

  Four actions that were previously menu-only are now named commands, so they can be bound to keys: `hunk.view.toggleCopyDecorations`, `hunk.app.openAgentSkill`, `hunk.review.nextAnnotatedFile`, and `hunk.review.previousAnnotatedFile`.

- [#611](https://github.com/modem-dev/hunk/pull/611) [`449b328`](https://github.com/modem-dev/hunk/commit/449b328b0c32415ba2fbd7586fbd73989b0ac054) - Extensions can now register keyboard commands and any number of sidebar views. `hunk.registerCommand({ id, title, key }, handler)` joins the same dispatch table Hunk's own shortcuts run on — built-ins win key conflicts, and every app-level shortcut is now a named command in that one table. Command handlers receive `ctx.sidebars` controls, so a registered key can open, close, or toggle sidebar views. `hunk.registerSidebarView` is additive: views declare a `title`, `placement` (`"left"` or `"right"` of the review stream), `defaultOpen`, or `replacesDefault` to stand in for the built-in file navigation, and multiple panes can be open at once with per-pane resize. A view that fails rendering closes with a warning and the built-in file navigation reopens if nothing else is showing.

  Keys are now yours to arrange: the new `[keybindings]` table in your user config remaps any command by id — `"hunk.app.quit" = "ctrl+x"`, `"hunk.review.nextHunk" = ["]", "ctrl+n"]`, `false` to unbind — including commands extensions register. A key you bind is exclusively yours: whatever held it by default gives it up. Commands can also ship with several default chords (`key: ["ctrl+g", "f9"]` in `registerCommand`), and a chord that collides is refused on its own without costing the command its other keys. Extensions that need their own internal keys can now import the same grammar Hunk matches with: `matchesKey`, `parseKeyChord`, and `matchesKeyChord` from `hunkdiff/extension`.

  Ids are namespaced by their owner, structurally. Every built-in command is named under `hunk.` and the built-in sidebar's view key is `hunk:files`, while an extension owns its own id — its commands are `<extensionId>.<commandId>` and its views `<extensionId>:<viewId>`. So extension ids are now validated when they load: `hunk`, `git`, `jj`, and `sl` are reserved, an id must start with a letter or digit and use only letters, digits, `-`, and `_`, and when two sources offer the same id the first one loads. An extension that breaks a rule is skipped with a startup notice naming the file; the rest of the session is unaffected.

- [#647](https://github.com/modem-dev/hunk/pull/647) [`aa1c24a`](https://github.com/modem-dev/hunk/commit/aa1c24a152ac11dc8f2343b24d932774cde70632) - Give pager mode the full review controls, so `git diff | hunk pager` supports everything `hunk diff` does: file and hunk navigation, file filter, layout switching, etc. Pager mode now only decides where the chrome starts — the menu bar and sidebar begin hidden, and `M` and `s` bring them back.

- [#626](https://github.com/modem-dev/hunk/pull/626) [`b6737d8`](https://github.com/modem-dev/hunk/commit/b6737d8d1df08349168329bf24bc597cfa3c2d83) - The extension API now exposes public hunk summaries: every read-only file view Hunk hands outward (event payloads, sidebar props, a command's selection) carries a `hunks` list of `ExtensionDiffHunk` records — `index`, the `@@` header, and inclusive old/new line spans, in render order. The index is the same one `selectedHunkIndex` reports and `actions.selectHunk` accepts, so hunk checklists, per-hunk progress views, and agent-annotation navigators no longer need to cast into the opaque `metadata`. The summaries derive through the same helper the agent session surface reports hunks with, so the two external views of a review cannot drift apart.

- [#632](https://github.com/modem-dev/hunk/pull/632) [`86bf722`](https://github.com/modem-dev/hunk/commit/86bf722550fa0e4552b62e6a90e06cc32d5199f9) - Add a streamlined experimental extension file-view contract plus an optional, user-installable Markdown preview example. File views read exact source lazily, return generic host-rendered rows, and may bind rows to exact source ranges so Hunk can place inline notes. Raw diff remains the default and the all-or-raw fallback for unresolved note bindings. The View menu can apply the active presentation to every matching file in the changeset without widening extension command controls.

- [#468](https://github.com/modem-dev/hunk/pull/468) [`e098b3a`](https://github.com/modem-dev/hunk/commit/e098b3a3dc12143aafad3582ac9096b5c8db646b) - Offer to save changed view preferences to the user config on quit, including theme, layout, line numbers, wrapping, hunk headers, agent notes, and copy decorations. The prompt also includes a “never ask” option that persists `prompt_save_view_preferences = false`.

- [#609](https://github.com/modem-dev/hunk/pull/609) [`46ef38a`](https://github.com/modem-dev/hunk/commit/46ef38acfcd733cdb706a7bd41458b2c96c3d136) - Extensions can replace the file-navigation sidebar with their own React component via `hunk.registerSidebarView`. Extension files now receive Hunk's own React (and `hunkdiff/extension` runtime values) when imported, so hooks and JSX work without bundling anything; the component gets live props (visible files with change types, selection, theme tokens) plus actions that drive review navigation exactly like the built-in sidebar, and a component that fails to render falls back to the built-in sidebar with a warning instead of taking down the session. The built-in sidebar is itself a bundled extension registered through this same API — the reference implementation a user-registered view overrides.

- [#674](https://github.com/modem-dev/hunk/pull/674) [`4a656c7`](https://github.com/modem-dev/hunk/commit/4a656c7dc11117ce75f40147f73a06958f011a0f) - Extension commands gain `ctx.workspace`, a host-mediated way to read reviewed documents and — with the user's confirmation — write reviewed files back to the working tree.

### Patch Changes

- [#531](https://github.com/modem-dev/hunk/pull/531) [`2458366`](https://github.com/modem-dev/hunk/commit/2458366fbf028759ac7ca7da729f4f6089e22b02) - Reduce Git polling and CPU use in watch mode while preserving continuous refreshes with a polling fallback.

- [#599](https://github.com/modem-dev/hunk/pull/599) [`883fad7`](https://github.com/modem-dev/hunk/commit/883fad7920a3039dbc1038a0d40ea5b2ec4feab0) - Record repo-extension trust decisions under a canonical repo root, so granting trust actually loads that repository's extensions when Hunk was launched through a symlinked path (or a Windows 8.3 short path). Previously the reload that follows the grant canonicalized its working directory and looked the decision up under a different spelling of the same directory, leaving the extensions skipped and the prompt ready to ask again. Decisions recorded by earlier versions are still honored.

- [#684](https://github.com/modem-dev/hunk/pull/684) [`0886985`](https://github.com/modem-dev/hunk/commit/0886985702235347a3bd31baf4842c13b241bc9e) - Show the changed-file count alongside addition and deletion totals in the menu bar.

- [#669](https://github.com/modem-dev/hunk/pull/669) [`ab570a0`](https://github.com/modem-dev/hunk/commit/ab570a006e54b34140210523d8edd1d9519dc491) - Preserve syntax highlighting state in source-backed reviews when visible hunks begin inside folded multiline constructs.

- [#675](https://github.com/modem-dev/hunk/pull/675) [`efa2203`](https://github.com/modem-dev/hunk/commit/efa2203f86845e1da5849ae64fe7cd50ceeba06e) - Match `ctrl+<letter>` key chords against the bare control character the combination is sent as, so those bindings also fire for key events that reach the matcher undecoded.

- [#625](https://github.com/modem-dev/hunk/pull/625) [`8396284`](https://github.com/modem-dev/hunk/commit/8396284c48a8157ab751f71cf26b02f0e4334864) - Extension discovery now recognizes `.tsx` and `.jsx` entry files everywhere `.ts` entries are found — standalone files in an extensions directory and `index.tsx`/`index.jsx` folder fallbacks — matching what the runtime loader already supported. A TSX sidebar extension no longer needs a `package.json` manifest just to name its entry file. The authoring guide also gains a recipe for feeding lifecycle-event state into sidebar components, documents the pane width/height contract, qualifies exactly which notes the `note_created`/`note_edited` events report, and fixes the "not contributable yet" list to say standalone keybindings rather than contradicting the remappable-command docs.

- [#606](https://github.com/modem-dev/hunk/pull/606) [`a9910f1`](https://github.com/modem-dev/hunk/commit/a9910f1d1ea5b43cbe1a3cb29f473a90f151467e) - Folder extensions can now declare their entry points through a `package.json` `"hunk": { "extensions": [...] }` manifest, which takes precedence over the `index.*` fallback and lets an extension ship several entries and its own npm dependencies.

- [#685](https://github.com/modem-dev/hunk/pull/685) [`61a561a`](https://github.com/modem-dev/hunk/commit/61a561a744f1dee11472d5a0f79a52515ff88ef4) - Keep current-line highlighting responsive and memory-efficient across large reviews and long wrapped rows.

- [#599](https://github.com/modem-dev/hunk/pull/599) [`883fad7`](https://github.com/modem-dev/hunk/commit/883fad7920a3039dbc1038a0d40ea5b2ec4feab0) - Fix extension-system issues found reviewing the published surface:
  - `hunkdiff/extension` types now resolve for consumers using `moduleResolution: "nodenext"`, not just `bundler`.
  - A VCS adapter whose `detect()` returns an id different from the one it registered under no longer aborts the session with `Unsupported VCS`.
  - Extension-registered themes are validated against the same color rules config themes get, so a malformed theme is skipped with a notice instead of crashing the renderer when selected.
  - Lifecycle handlers receive a read-only view of the changeset, so an extension that mutates it is reported instead of corrupting the review.
  - `startup` now fires for extensions loaded after granting repository trust.
  - `--no-extensions` and `--extension` paths survive daemon-driven session reloads, and reloads re-run extension VCS detection the way first launch does.
  - An unknown `vcs` id in config is resolved against loaded extension backends, and reported instead of silently discarded when nothing owns it.
  - Extension VCS adapters take part in checkout detection on the same terms as bundled ones: the nearest checkout wins, so a Mercurial checkout nested inside a Git repository is reviewed as Mercurial, while `detectionPriority` still decides colocated ties and an explicit `vcs` in config still wins outright.
  - `[extensions] paths` now expands a leading `~`, matching the documented examples.

- [#606](https://github.com/modem-dev/hunk/pull/606) [`a9910f1`](https://github.com/modem-dev/hunk/commit/a9910f1d1ea5b43cbe1a3cb29f473a90f151467e) - Pointing `--extension` or `[extensions] paths` at a directory that contains an `index.ts`/`index.js`/`index.mjs` now loads it as a single folder extension instead of scanning every file inside it as separate extensions.

- [#668](https://github.com/modem-dev/hunk/pull/668) [`5230cc5`](https://github.com/modem-dev/hunk/commit/5230cc56a81655d3a86e9f54a4536a38ad269705) - Keep file stats visible and use three-dot path truncation on narrow terminals.

- [#649](https://github.com/modem-dev/hunk/pull/649) [`815f343`](https://github.com/modem-dev/hunk/commit/815f34378e6cb334eddb1e8b7e67ab589477348d) - One keypress no longer triggers two actions when a modal surface and the focused widget both want it. In pager mode, opening a menu or the theme selector and pressing an arrow no longer scrolls the diff behind the dialog. Escape closing the Controls help or Agent skill overlay no longer wipes typed filter text, Enter on a menu item no longer also submits the focused filter, and F10 no longer pops the menu bar over an in-progress note draft. Global key handlers now answer one three-state ownership question (`notMine` / `mine` / `focused`) and consumption is enforced centrally, so a handler can no longer act on a key while leaving it live for the focused widget.

- [#589](https://github.com/modem-dev/hunk/pull/589) [`6ccc3a6`](https://github.com/modem-dev/hunk/commit/6ccc3a6812eb3500297f5bcd0694fed7bd699755) - Require reviews to opt into experimental STML agent-note rendering with `--experimental`. Normal reviews now use plain-text note fallbacks and reject live STML comments, while opted-in live sessions advertise the `stml` capability to agents.

- [#519](https://github.com/modem-dev/hunk/pull/519) [`dcf66e8`](https://github.com/modem-dev/hunk/commit/dcf66e8074e177cfdd7b700e06bdb213ac139eb7) - Label repo-root file runs with an in-place `./` sidebar header so root files remain visually distinct without changing review order.

- [#531](https://github.com/modem-dev/hunk/pull/531) [`2458366`](https://github.com/modem-dev/hunk/commit/2458366fbf028759ac7ca7da729f4f6089e22b02) - Reduce watch-mode startup cost on macOS and Windows by using bounded native recursive filesystem observation.

- [#670](https://github.com/modem-dev/hunk/pull/670) [`45af37c`](https://github.com/modem-dev/hunk/commit/45af37c5e048dbaa84e06b04acdc304ea6d3739b) - Display tracked CJK and emoji filenames as readable Unicode across review UI, source loading, patch input, and session APIs.

- [#574](https://github.com/modem-dev/hunk/pull/574) [`53fcb2c`](https://github.com/modem-dev/hunk/commit/53fcb2cdace2cc2788790f712165f842ec6b9cf3) - Show a transient startup footer notice when deprecated `custom_theme.syntax` colors are translated into approximate Shiki scopes.

- [#572](https://github.com/modem-dev/hunk/pull/572) [`d3d90d8`](https://github.com/modem-dev/hunk/commit/d3d90d8eea899489b7e2a9f46d328fa8e2d21b78) - Restart stale session daemons during upgrades so rich STML comments reach live Hunk reviews.

- [#627](https://github.com/modem-dev/hunk/pull/627) [`afc2b89`](https://github.com/modem-dev/hunk/commit/afc2b89ed05df18aae66d9cf211436b27b9efea9) - Upgrade shell-quote to resolve the denial-of-service vulnerability and keep direct file watch refreshes responsive when filesystem events are missed.

- [#630](https://github.com/modem-dev/hunk/pull/630) [`076ac6f`](https://github.com/modem-dev/hunk/commit/076ac6f6186a03345bd091748d34b57fb8efccd7) - The extension authoring guide now documents the supported scrollbox ref contract for custom sidebars: hold a React ref to your `<scrollbox>`, give rows stable `id` props, and use `scrollChildIntoView` to follow the selection, with `scrollTop`/`viewport.height` and the scrollbar/viewport change events for pane geometry — the exact surface the built-in sidebar runs on, now committed as the supported way to scroll, follow, and window a third-party sidebar instead of being described as an unsupported gap.

- [#596](https://github.com/modem-dev/hunk/pull/596) [`31fc677`](https://github.com/modem-dev/hunk/commit/31fc677bd44678f3e7a473ba8596a18d2c336c11) - Generate the hunk-review skill from the typed session command surface so agent docs cannot drift from the CLI. Fixes stale error quotes in the skill and documents previously missing flags (`--include-notes`, `--markup`, `--rationale`, `--author`) in session help and skill synopsis lines.

- [#652](https://github.com/modem-dev/hunk/pull/652) [`89052f5`](https://github.com/modem-dev/hunk/commit/89052f51f6a1f5005d7870023845f38700798add) - Skip inactive custom file-view preparation so ordinary raw-diff reviews avoid unnecessary rerenders and retain less memory during navigation.

- [#655](https://github.com/modem-dev/hunk/pull/655) [`c2ad4dc`](https://github.com/modem-dev/hunk/commit/c2ad4dc35666ccb1fc71c57336161fc7f612111c) - Keep file navigation from losing the file it just jumped to. On a loaded machine the scroll that aligns the new file to the top could land after the viewport-follow window closed, so the review stream adopted the file under the cursor again and the next "previous file" press did nothing.

- [#645](https://github.com/modem-dev/hunk/pull/645) [`8e1f5fd`](https://github.com/modem-dev/hunk/commit/8e1f5fd265da3d0b45978db67350436cfaa05c05) - Keep scrolling one line at a time after a click in the review stream, instead of jumping several lines once the click handed keyboard focus to the scroll box.

- [#599](https://github.com/modem-dev/hunk/pull/599) [`883fad7`](https://github.com/modem-dev/hunk/commit/883fad7920a3039dbc1038a0d40ea5b2ec4feab0) - Make Hunk's saved state (`state.json`) durable: writes now land atomically through a temp file and rename, and an unreadable state file is preserved as `state.json.corrupt` instead of being silently overwritten, so update notices and extension trust decisions are no longer lost to a torn or damaged write.

- [#573](https://github.com/modem-dev/hunk/pull/573) [`1887d46`](https://github.com/modem-dev/hunk/commit/1887d46b578c927c1bde433c32eb0065eaf8a0d2) - Teach STML authors to compose within Hunk's native note frame while preserving focused inset boxes.

- [#598](https://github.com/modem-dev/hunk/pull/598) [`cbf652e`](https://github.com/modem-dev/hunk/commit/cbf652edab44bbec7912de308ecc1ee27b20320c) - Show Nix-aware update guidance instead of suggesting an npm install command for Hunk's Nix package.

## 0.18.0-beta.0

### Minor Changes

- [#570](https://github.com/modem-dev/hunk/pull/570) - Add exact Shiki/TextMate overrides via `custom_theme.syntax_scopes`, with compatibility for deprecated `custom_theme.syntax`.

- [#629](https://github.com/modem-dev/hunk/pull/629) - Add live `ctx.navigation.selectFile` and `selectHunk` APIs for guarded review-stream navigation.

- [#616](https://github.com/modem-dev/hunk/pull/616) - Give extension commands a frozen snapshot of the current review selection through `ctx.selection`.

- [#588](https://github.com/modem-dev/hunk/pull/588) - Render tabs at four-column stops by default, configurable through `tab_width`, `-x`, or `--tab-width`.

- [#632](https://github.com/modem-dev/hunk/pull/632) - Advance the extension API to v2 with experimental fixed-height React/OpenTUI file-view rows and semantic theme painting.

- [#617](https://github.com/modem-dev/hunk/pull/617) - Add queued `ctx.dialogs.confirm`, `select`, and `input` prompts to extension commands.

- [#619](https://github.com/modem-dev/hunk/pull/619) - Add extension UI lifecycle events, sidebar controls for event handlers, and an inter-extension event bus.

- [#599](https://github.com/modem-dev/hunk/pull/599) - Add experimental TypeScript extensions, bundled VCS adapters, multiple custom themes, trust controls, and configurable loading paths.

- [#615](https://github.com/modem-dev/hunk/pull/615) - Expose resolved command keybindings to custom extension sidebars so they honor remapping and unbinding.

- [#512](https://github.com/modem-dev/hunk/pull/512) - Add experimental STML agent-note markup, `hunk markup guide`/`render`, and live note-width validation APIs.

- [#614](https://github.com/modem-dev/hunk/pull/614) - Make menus and help reflect remapped keys, add an Extensions menu, and expose formerly menu-only actions as commands.

- [#611](https://github.com/modem-dev/hunk/pull/611) - Add extension commands, multiple sidebar views, configurable `[keybindings]`, shared key APIs, and namespaced command/view IDs.

- [#647](https://github.com/modem-dev/hunk/pull/647) - Give `hunk pager` the full review controls while keeping its menu bar and sidebar initially hidden.

- [#626](https://github.com/modem-dev/hunk/pull/626) - Expose ordered `ExtensionDiffHunk` summaries with headers, indexes, and inclusive line spans in public file views.

- [#632](https://github.com/modem-dev/hunk/pull/632) - Add an experimental host-rendered extension file-view contract and an optional Markdown preview example.

- [#468](https://github.com/modem-dev/hunk/pull/468) - Offer to save changed view preferences on quit, with a persistent “never ask” option.

- [#609](https://github.com/modem-dev/hunk/pull/609) - Let extensions replace file navigation with React sidebars that receive live review props and safe navigation actions.

### Patch Changes

- [#531](https://github.com/modem-dev/hunk/pull/531) - Reduce Git polling and CPU use in watch mode while preserving continuous refreshes with a polling fallback.

- [#599](https://github.com/modem-dev/hunk/pull/599) - Store repo-extension trust by canonical root so trusted extensions load through symlinked and Windows short paths.

- [#625](https://github.com/modem-dev/hunk/pull/625) - Discover `.tsx` and `.jsx` extension entries alongside TypeScript and JavaScript entries.

- [#606](https://github.com/modem-dev/hunk/pull/606) - Support folder-extension entry points and multiple entries through `package.json` `hunk.extensions` manifests.

- [#599](https://github.com/modem-dev/hunk/pull/599) - Harden extension types, themes, lifecycle data, reloads, VCS detection, configured paths, and user-facing failures.

- [#606](https://github.com/modem-dev/hunk/pull/606) - Load directories with `index.ts`, `index.js`, or `index.mjs` as single folder extensions.

- [#649](https://github.com/modem-dev/hunk/pull/649) - Prevent one keypress from triggering both a modal action and the focused widget beneath it.

- [#589](https://github.com/modem-dev/hunk/pull/589) - Require `--experimental` for STML note rendering and advertise the `stml` capability only in opted-in sessions.

- [#519](https://github.com/modem-dev/hunk/pull/519) - Label repo-root file runs with a `./` sidebar header without changing review order.

- [#531](https://github.com/modem-dev/hunk/pull/531) - Reduce watch-mode startup cost on macOS and Windows with bounded native recursive filesystem observation.

- [#574](https://github.com/modem-dev/hunk/pull/574) - Show a startup notice when deprecated `custom_theme.syntax` colors are translated to approximate Shiki scopes.

- [#572](https://github.com/modem-dev/hunk/pull/572) - Restart stale session daemons during upgrades so rich STML comments reach live reviews.

- [#627](https://github.com/modem-dev/hunk/pull/627) - Upgrade `shell-quote` against a denial-of-service flaw and keep file-watch refreshes responsive after missed events.

- [#630](https://github.com/modem-dev/hunk/pull/630) - Document the supported scrollbox ref, stable row IDs, selection following, and pane geometry APIs for custom sidebars.

- [#596](https://github.com/modem-dev/hunk/pull/596) - Generate the hunk-review skill from typed session commands and document missing note, markup, rationale, and author flags.

- [#652](https://github.com/modem-dev/hunk/pull/652) - Skip inactive custom file-view preparation to reduce rerenders and retained memory in raw-diff reviews.

- [#655](https://github.com/modem-dev/hunk/pull/655) - Keep delayed scroll alignment from changing the file selected by navigation.

- [#645](https://github.com/modem-dev/hunk/pull/645) - Preserve one-line keyboard scrolling after clicking in the review stream.

- [#599](https://github.com/modem-dev/hunk/pull/599) - Write `state.json` atomically and preserve unreadable state as `state.json.corrupt`.

- [#573](https://github.com/modem-dev/hunk/pull/573) - Teach STML authors to compose within Hunk’s native note frame while preserving focused inset boxes.

- [#598](https://github.com/modem-dev/hunk/pull/598) - Show Nix-aware update guidance instead of suggesting npm installation for the Nix package.

## 0.17.7

### Patch Changes

- f7eff9d: Fix session commands when the local daemon uses the IPv6 loopback address.
- dc61750: Fix Nix flake evaluation on Nixpkgs 26.11, which dropped `x86_64-darwin`. Hunk's flake no longer declares that system, and it now pins bun2nix's `systems` input to the same list so building the `aarch64-darwin` package never forces an Intel macOS Nixpkgs. The system list is exposed as a `systems` flake input for consumers that need to override it.

## 0.17.6

### Patch Changes

- 736b1d7: Republish the 0.17.5 application changes as 0.17.6 so the GitHub release includes downloadable binaries for every supported platform. Application behavior is unchanged from 0.17.5.

## 0.17.5

### Patch Changes

- 034ec93: Avoid loading OpenTUI's embedded native library for headless commands. Help, version, session polling, daemon serving, markup rendering, and non-interactive pager paths now stay behind a lightweight CLI entrypoint, preventing Bun from leaking a native temp file for commands that never open the review UI.
- aa123df: Optimize terminal cell width measurement so diffs with CJK, emoji, and chrome-glyph runs render faster: single-scalar clusters now measure through a fast zero-width check plus the East Asian Width table instead of string-width's expensive emoji regexes, while multi-scalar clusters still defer to string-width for identical results.

## 0.17.4

### Patch Changes

- a9b8694: Restore OpenTUI's platform-default renderer threading to improve interactive startup on macOS.
- 67674fa: Rapidly pressing Ctrl+S (or double-clicking Save) while saving a draft note no longer saves the same note twice, and saved note ids stay unique even within one millisecond.

## 0.17.3

### Patch Changes

- 9d1c346: Extend static pager diff-row backgrounds to the edge of host panels such as Lazygit.
- 05d6c17: Wrap plain-text agent notes by terminal cells instead of UTF-16 code
  units, so CJK and emoji text wraps correctly instead of being truncated
  with silent content loss. Long unbroken words split on grapheme
  boundaries, so wide characters and surrogate pairs are never cut apart.

## 0.17.2

### Patch Changes

- 7e934a0: Reject malformed and unsafe line and hunk numbers instead of accepting their numeric prefix.
- d1d36fc: Fix mouse-selection copy misalignment on lines with wide (CJK, emoji) characters: drag, double-click, and triple-click selections now convert terminal cell columns into string indices before slicing, so the copied text matches the selected cells exactly. File-header rows with wide-character filenames now copy with the same cell alignment, and invisible zero-width characters at a selection boundary round-trip through the clipboard.

## 0.17.1

### Patch Changes

- cb8d626: Prevent Windows crashes when scrolling to the end of a diff and suppress Yoga NaN warning spam in Apple Silicon npm installs by upgrading OpenTUI to 0.4.3.
- 45f6402: Reduced retained memory for large reviews by lazily materializing cached geometry row plans only when copy selection needs them.
- 7ae443d: Fix global config discovery on Windows when `HOME` is unavailable.

## 0.17.0

### Minor Changes

- 6cd39c9: Add a configurable menu bar toggle so keyboard-driven reviews can reclaim one row of terminal space.
- 8945272: Add an `enableClaudeIntegration` home-manager option that links the packaged `hunk-review` skill into `~/.claude/skills`, so Nix users get the Claude Code review skill without manual setup.
- d2be4e7: Add an `enableJujutsuIntegration` home-manager option that sets hunk as the jujutsu pager and switches `ui.diff-formatter` to `:git` so jj emits diffs hunk can render.

### Patch Changes

- 0a3cc06: Add an Agent menu dialog that shows and copies the Hunk review skill setup prompt.
- d7f1558: Upgrade OpenTUI to 0.4.2 and Bun to 1.3.14 for renderer, input, and platform fixes.
- 675104f: Fix a transient bottom-edge scroll clamp: mounted diff sections now always render their agent-note rows, so the review stream's painted height matches its measured layout height and over-scrolling at the bottom can no longer snap short by the height of an offscreen note.
- 65a2740: Highlight `.mts` and `.cts` files as TypeScript instead of plain text.
- ed8268a: Stop treating Escape as a global quit shortcut; use `q` to quit while preserving Escape for dialogs and focused controls.
- 290ebcd: Keep live review sessions from being pruned after the machine wakes from sleep.
- ae57101: Avoid transient mixed-color frames when previewing or accepting themes from the theme selector.
- 916cd8a: Preserve added and removed diff row tints when transparent background mode is enabled in the interactive TUI.
- d4b829f: Fix session daemon auto-launch on Windows: the compiled binary's virtual `B:\~BUN\...` entrypoint was mistaken for a script path and passed to the relaunched daemon as a bogus argument, so `hunk session` commands never found a live session.

## 0.16.0

### Minor Changes

- 8ffe0ba: Refresh Hunk's built-in theme system, default to `github-dark-default`, and simplify theme selection around one `theme` setting with `View -> Themes…` / `t` opening the selector. Custom themes can inherit from any built-in theme with `custom_theme.base` while keeping explicit syntax color overrides, and removed theme ids such as `graphite` and `paper` remain accepted as compatibility aliases.

### Patch Changes

- 4bef148: Allow session comment cleanup commands to remove human `c` notes: `comment rm` accepts `user:*` note ids, and `comment clear --include-user`/`--all` clears user notes alongside live agent comments.
- 48b97ac: Adopt Changesets for release-note fragments so pull requests can avoid conflicting `CHANGELOG.md` edits.
- c0cf637: Prevent standalone Hunk binaries from loading `bunfig.toml` files from the caller's working directory.
- c28c266: Improve React review-stream responsiveness by reducing offscreen file mounting work while preserving adjacent highlight prefetching.
- 3906f39: Honor explicit split layout mode in static pager output for captured hosts like LazyGit.
- 8ffe0ba: Improve generated theme contrast checks for built-in themes, including diff rows, metadata, chrome, and fallback token colors.
- 59fcdbb: Require an explicit click or keyboard action before previewing a theme from the theme selector, while keeping mouse-wheel navigation available inside the selector.

## [0.15.3] - 2026-06-13

### Added

- Added release benchmark snapshots and a release workflow gate that blocks publishing when committed benchmark results show material performance regressions, with auditable accepted-regression records for intentional release tradeoffs.

### Changed

### Fixed

- Fixed Windows launches from Cygwin, Git Bash, and WSL-style VCS paths by normalizing Unix-style repo roots before reusing them as subprocess working directories or filesystem roots.
- Fixed release staging so benchmark comparison artifacts are not mistaken for platform binary artifacts.
- Reduced hunk-navigation latency and memory growth on large reviews by keeping diff geometry memoized when the selected hunk changes.
- Reduced scroll and hunk-navigation latency on large reviews by avoiding repeated separator measurement and preserving memoized offscreen/visible diff rows across viewport updates.
- Reduced main diff pane rendering work on large reviews by virtualizing offscreen file sections behind exact-height spacers.
- Reduced sidebar rendering work on many-file reviews by virtualizing offscreen file rows behind exact-height spacers.

## [0.15.2] - 2026-06-13

### Added

### Changed

- Coalesced scroll-position React updates into a single per-frame read and shifted background syntax highlighting from microtasks to timers, so rapid wheel or held-arrow scrolling no longer produces visible jank from per-delta state updates or per-file highlight work starving input and render callbacks.

### Fixed

- Honored `--transparent-bg` and `transparent_background` in static pager output, so captured pager hosts like LazyGit let translucent terminal backgrounds through on context lines, gutters, and hunk headers while added/removed rows keep their tinted backgrounds.
- Kept menu dropdowns and the help dialog on the base theme in transparent-background mode so popups remain readable over translucent terminals.
- Resolved `hunk session ... --repo <path>` selectors to the containing repo root before matching, so `--repo .` (and any path inside the tree) targets the live session from a subdirectory instead of reporting no match.

## [0.15.1] - 2026-06-09

### Fixed

- Restored the `e` keyboard shortcut and menu hint for opening the selected file in `$EDITOR`.
- Added timeouts to `hunk session *` daemon capability and API calls so unresponsive daemons fail instead of hanging indefinitely.
- Updated OpenTUI so light and dark theme backgrounds render without the native renderer's color shift.
- Prevented Git watch polling from taking optional index locks while discovering untracked files.

## [0.15.0] - 2026-06-08

### Added

- Show the newly selected theme in the footer status bar when switching themes.
- Added Catppuccin Frappé and Macchiato as built-in themes, completing the four official Catppuccin flavors.
- Added a Zenburn built-in theme (`theme = "zenburn"`), a warm low-contrast dark palette inspired by Jani Nurminen's original Zenburn. It also works as a custom-theme `base`.
- Added a `--transparent-bg` flag and `transparent_background` config option for translucent terminal setups.
- Added Sapling VCS backend support for `hunk diff` and `hunk show`.

### Changed

### Fixed

- Preserved split diff alignment when horizontal scrolling starts inside a wide CJK or emoji character.
- Made diff syntax highlighting follow the active theme: keyword, function, number, and variable token colors now resolve to the configured theme's palette (including custom themes) in both light and dark, instead of passing through Pierre's built-in syntax colors.
- Expanded the diff window during rapid scrolling bursts so large reviews keep real rows mounted instead of falling back to blank placeholder regions.

## [0.14.1] - 2026-06-01

### Added

- Added local performance benchmarks for Hunk startup, loading, rendering, highlighting, navigation, memory, and optional competitor comparisons.

### Changed

### Fixed

- Fixed npm installs by pinning `@pierre/diffs` to the version Hunk is tested with instead of allowing the broken `1.2.6` release.

## [0.14.0] - 2026-05-26

### Added

- Added Catppuccin Latte and Mocha as built-in themes.
- Added mouse-drag text selection in diff views that copies selected rows to the system clipboard via OSC 52. A `View > Copy decorations` toggle (or `copy_decorations` config) controls whether the clipboard includes diff rails, gutters, and file headers or only the changed code.
- Added inline expansion for collapsed unchanged file content. Click an unchanged-context row (`▾ N unchanged lines` when expandable, otherwise the static `··· N unchanged lines ···` form) or press `e` while a hunk is selected to reveal surrounding and trailing file lines without leaving the review. The affordance is shown only for input modes that have reachable source content (`hunk diff`, `show`, `stash show`, file-pair `diff` and `difftool`, untracked files); raw `hunk patch` input still renders as before. Failed and in-flight loads surface a one-line status ("Loading…", "Could not load N unchanged lines") on the gap row. Expanded context rows use the same syntax highlighting as the surrounding diff.
- Surfaced the agent author name in inline notes and the matching agent popover so multi-agent reviews are readable at a glance, with a fallback title when an annotation has no author.

### Changed

### Fixed

- Preserved Git log ANSI colors when `hunk pager` falls back to a plain-text terminal pager for non-diff output.
- Capped inline context expansion source reads so huge files cannot freeze or exhaust memory when expanding unchanged lines.
- Hardened plain-text pager startup so `PAGER` and `HUNK_TEXT_PAGER` shell metacharacters are passed as arguments instead of being evaluated implicitly.
- Hardened terminal rendering against control-sequence injection from diffs, file paths, notes, expanded context, copied selections, and pager fallback output.
- Fixed custom theme configuration so Catppuccin Latte and Mocha can be used as base themes.
- Fixed inline note draft shortcuts so copy chords such as Ctrl-C and Ctrl-Shift-C no longer trigger note actions.
- Fixed split diff alignment for wide CJK and emoji characters by measuring rendered text in terminal cells.
- Fixed Ctrl-S saving for inline notes when tmux sends CSI-u keyboard input.
- Stabilized hover backgrounds on wrapped diff rows so add-note affordances do not shift row layout.
- Restricted session reloads so daemon commands cannot read files outside the initial Hunk session root.
- Fixed static pager output so captured pager hosts honor configured custom themes.
- Made `hunk pager` pass non-diff text through in captured pager and dumb-terminal contexts instead of spawning `less`.
- Fixed the `e` editor shortcut when Hunk is launched from a repo subdirectory.
- Fixed VCS auto-detection so a Git repository nested under a parent Jujutsu workspace still uses Git mode by default.

## [0.13.1] - 2026-05-19

### Fixed

- Hid the inline add-note affordance while scrolling and only show it after deliberate pointer movement, so it no longer flickers during review navigation.
- Hardened the local session daemon against browser-originated requests by validating Host and Origin headers and requiring JSON content types for API posts.
- Disabled the generic broker HTTP API by default so Hunk's supported session API is the only app-daemon command surface.
- Bounded session daemon memory by capping HTTP request body and websocket message sizes and rejecting session registrations with oversized file, hunk, patch, comment, or note payloads.

## [0.13.0] - 2026-05-18

### Added

- Added an `e` shortcut to open the selected diff file in `$EDITOR`.
- Added `g` and `G` keyboard aliases for jump-to-top and jump-to-bottom review navigation.
- Added session-persistent user-authored inline notes with `c` to draft/save notes.
- Added `hunk session comment list --type <live|all|ai|agent|user>` so agents can read human-authored notes through the comment workflow.

### Changed

- Clarified inline note draft actions by labeling buttons as `Save (^S)` and `Cancel (Esc)`.

### Fixed

- Fixed draft note focus handling so app shortcuts resume after the note textarea blurs without discarding the draft.
- Preserved the resolved auto theme across `--watch` refreshes instead of falling back to the default dark theme.
- Fixed standalone release archive generation so staged npm package directories are not accidentally packaged as GitHub release assets.

## [0.12.1] - 2026-05-14

### Fixed

- Included the bundled Hunk review skill in standalone prebuilt release archives so `hunk skill path` works after extracting a tarball or installing via Homebrew.

## [0.12.0] - 2026-05-12

### Added

- Added Homebrew tap release automation and Homebrew-aware startup update notices.
- Added lower-level `hunkdiff/opentui` primitives for embedding Hunk diff bodies, file headers, file navigation, and multi-file review streams in custom OpenTUI apps.
- Added row windowing for large single-file reviews to keep huge diffs responsive.
- Added Windows x64 prebuilt artifact publishing to the release workflow.
- Added native Windows support in the README, contributor guide, and local build/install scripts.
- Added Nix flake app outputs for `nix run`, a named `hunk` package output, and package validation.
- Added automatic light/dark theme detection from the terminal background when `theme = "auto"` is enabled.

### Changed

- Ported `build:npm`, `build:bin`, and `install:bin` from bash scripts to cross-platform Bun-runnable TypeScript so native Windows contributors no longer need Git Bash to build or install Hunk locally.

### Fixed

- Fixed the prebuilt npm package so the `hunkdiff/opentui` export and bundled type declarations are included.
- Fixed the npm package so `npx hunkdiff` and other package-name executable lookups resolve to the Hunk CLI.
- Made `hunk pager` emit static highlighted diff output for captured pager contexts like LazyGit, and pass diff input through unchanged when stdout is non-interactive.
- Fixed Ctrl-Z job-control suspend support so Hunk can suspend and resume cleanly from a terminal.
- Fixed Windows compatibility issues across paths, packaging, and tests.
- Fixed Ctrl-C in the live TUI so it exits through Hunk's full shutdown path instead of only destroying the renderer.

## [0.11.1] - 2026-05-10

### Added

### Changed

- Auto-detect Jujutsu checkouts for `hunk diff` and `hunk show`, while keeping explicit `vcs` config overrides.

### Fixed

- Fixed large tracked and untracked file handling so very large diffs render as skipped placeholders instead of slowing startup or overflowing the JavaScript call stack.
- Fixed Git patch parsing for `diff.noprefix=true` input so Hunk restores parser-safe `a/` and `b/` prefixes without mangling real paths.
- Fixed `hunk pager` parsing for Git diffs emitted with `diff.mnemonicPrefix=true` so file paths do not keep `i/`, `w/`, `c/`, `1/`, or `2/` side prefixes.
- Fixed review scrolling so viewport updates are coalesced and no longer risk a render loop.
- Fixed agent comment hunk ranges so context lines from hunk headers remain part of the target range.
- Fixed untracked-file reviews in repositories with external diff tools configured by passing `--no-ext-diff`.
- Fixed diff geometry for hunks with multiple agent notes so offscreen notes no longer skew scrolling measurements.

## [0.11.0] - 2026-05-09

### Added

- Added `vcs = "jj"` support, enabling `hunk diff [revset]` and `hunk show [revset]`.
- Added a pager-mode sidebar file tree that can be revealed with the existing `s` shortcut while keeping pager chrome hidden by default.

### Changed

### Fixed

- Fixed `git log -p` and multi-commit `git show -p` inputs so patch parsing ignores commit metadata instead of emitting Pierre parser warnings.
- Fixed cross-file hunk navigation so near-boundary jumps keep the selected file pinned and backward jumps reveal the target hunk instead of the file top.
- Fixed the View menu sidebar checkmark so it follows whether the responsive layout is actually rendering the sidebar.

## [0.10.0] - 2026-04-21

### Added

- Added agent comment counts in the sidebar so review-heavy files stand out at a glance.
- Added `hunk daemon serve` as the standard daemon entrypoint and published reusable session-broker packages plus an OpenTUI diff component for integrators.

### Changed

- Included untracked files when `hunk diff <ref>` still compares against the live working tree, while keeping explicit revset diffs commit-to-commit only.

### Fixed

- Enabled mouse scrolling in pager mode.
- Balanced Pierre word-level highlights so split-view inline changes stay visible without overpowering the surrounding diff row.
- Smoothed mouse-wheel review scrolling so small diffs stay precise while sustained wheel gestures still speed up.
- Fixed Shift+mouse-wheel horizontal scrolling so it no longer leaks a one-line vertical scroll in some terminals.

## [0.9.5] - 2026-04-21

### Added

- Added a Modem sponsor block to the README.

### Changed

### Fixed

## [0.9.4] - 2026-04-14

### Added

- Added `hunk skill path` to print the bundled Hunk review skill path for direct loading or symlinking in coding agents.

### Changed

- Show a one-time startup notice after version changes that points users with copied agent skills to `hunk skill path`.

### Fixed

- Restored execute permissions for packaged prebuilt binaries so `npm install -g hunkdiff` works on root-owned installs without `spawnSync … EACCES` failures.

## [0.9.3] - 2026-04-13

### Fixed

- Normalized rename-only diff paths so pure renames keep one clean `old/path -> new/path` header in the review UI ([#194](https://github.com/modem-dev/hunk/pull/194)).
- Stripped Pierre's empty-line newline placeholder spans so blank additions and deletions keep stable line numbers and diff row backgrounds ([#201](https://github.com/modem-dev/hunk/pull/201)).

## [0.9.2] - 2026-04-11

### Fixed

- Fixed a bottom-edge scrolling regression where short last files could snap back and make upward navigation feel stuck near the end of the review stream ([#196](https://github.com/modem-dev/hunk/pull/196)).

## [0.9.1] - 2026-04-10

### Fixed

- Preserved viewport position when switching layouts ([#185](https://github.com/modem-dev/hunk/pull/185)).
- Skipped binary file contents in reviews while keeping binary files visible in the review stream with a `Binary file skipped` placeholder ([#187](https://github.com/modem-dev/hunk/pull/187)).

## [0.9.0] - 2026-04-08

### Added

- Added `hunk session review --json` for full live-session exports ([#160](https://github.com/modem-dev/hunk/pull/160)).
- Added horizontal code-column scrolling in review mode ([#171](https://github.com/modem-dev/hunk/pull/171)).
- Added batch apply support for live session comments in agent review flows ([#179](https://github.com/modem-dev/hunk/pull/179)).

### Changed

- Pinned the current file header while scrolling the review pane ([#141](https://github.com/modem-dev/hunk/pull/141)).
- Made session comment focus opt-in instead of forcing comment focus by default ([#163](https://github.com/modem-dev/hunk/pull/163)).
- Synced active hunks to mouse scrolling and prefetched diff highlighting for smoother navigation ([#172](https://github.com/modem-dev/hunk/pull/172)).
- Hid zero-value sidebar file stats to reduce visual noise ([#174](https://github.com/modem-dev/hunk/pull/174)).
- Updated in-app controls help ([#175](https://github.com/modem-dev/hunk/pull/175)).
- Sped up syntax-highlight row building in large diffs ([#177](https://github.com/modem-dev/hunk/pull/177)).

### Fixed

- Reported the packaged version correctly in installed builds ([#153](https://github.com/modem-dev/hunk/pull/153)).
- Fixed stale syntax highlights after reloads ([#146](https://github.com/modem-dev/hunk/pull/146)).
- Fixed diff pane header popping while scrolling ([#159](https://github.com/modem-dev/hunk/pull/159)).
- Avoided failures on untracked directory symlinks ([#169](https://github.com/modem-dev/hunk/pull/169)).
- Aligned top-menu dropdowns correctly ([#176](https://github.com/modem-dev/hunk/pull/176)).
- Restored live escape handling in PTY flows ([#173](https://github.com/modem-dev/hunk/pull/173)).
- Kept viewport-follow selection from jumping unexpectedly ([#181](https://github.com/modem-dev/hunk/pull/181)).
- Refreshed stale daemons after upgrades ([#178](https://github.com/modem-dev/hunk/pull/178)).
- Rejected incompatible live session registrations more clearly ([#180](https://github.com/modem-dev/hunk/pull/180)).
- Versioned daemon compatibility separately from other MCP behavior ([#183](https://github.com/modem-dev/hunk/pull/183)).

## [0.8.1] - 2026-03-30

### Fixed

- Enabled `j` and `k` step scrolling in normal mode ([#131](https://github.com/modem-dev/hunk/pull/131)).
- Aligned inline note rendering more cleanly beside diffs ([#137](https://github.com/modem-dev/hunk/pull/137)).

## [0.8.0] - 2026-03-29

### Added

- Added file state indicators to the sidebar ([#128](https://github.com/modem-dev/hunk/pull/128)).
- Added comment-to-comment navigation in review mode ([#126](https://github.com/modem-dev/hunk/pull/126)).
- Included TTY and tmux pane metadata in session lists ([#90](https://github.com/modem-dev/hunk/pull/90)).
- Added worktree-based session path targeting for session workflows ([#118](https://github.com/modem-dev/hunk/pull/118)).

### Changed

- Included untracked files in working-tree diff reviews by default ([#123](https://github.com/modem-dev/hunk/pull/123)).
- Surfaced a transient startup update notice ([#127](https://github.com/modem-dev/hunk/pull/127)).
- Refined top-level CLI help text and files/filter focus copy ([#129](https://github.com/modem-dev/hunk/pull/129), [#121](https://github.com/modem-dev/hunk/pull/121)).

### Fixed

- Fixed keyboard help dialog row overlap ([#122](https://github.com/modem-dev/hunk/pull/122)).
- Fixed scrollbar click-drag behavior on large diffs ([#120](https://github.com/modem-dev/hunk/pull/120)).

## [0.7.0] - 2026-03-25

### Added

- Grouped sidebar files by folder for easier navigation in large reviews ([#99](https://github.com/modem-dev/hunk/pull/99)).
- Added `Ctrl+D`, `Ctrl+U`, and `Shift+Space` navigation shortcuts ([#102](https://github.com/modem-dev/hunk/pull/102)).
- Added an auto-hiding vertical scrollbar to the diff pane ([#93](https://github.com/modem-dev/hunk/pull/93)).
- Added Linux arm64 prebuilt package release support ([#107](https://github.com/modem-dev/hunk/pull/107)).

### Fixed

- Prevented scroll snapback when using `Space`, `PageUp`, and `PageDown` ([#105](https://github.com/modem-dev/hunk/pull/105)).
- Normalized Git patch prefixes for parser compatibility ([#106](https://github.com/modem-dev/hunk/pull/106)).
- Kept selected hunks fully visible when they fit in the viewport ([#108](https://github.com/modem-dev/hunk/pull/108)).
- Fixed wrap-toggle redraws while preserving the viewport anchor ([#110](https://github.com/modem-dev/hunk/pull/110)).

## [0.6.1] - 2026-03-24

### Added

- Added watch mode for reloadable reviews ([#91](https://github.com/modem-dev/hunk/pull/91)).

### Changed

- Fit menu dropdowns to their contents ([#92](https://github.com/modem-dev/hunk/pull/92)).

### Fixed

- Shut down idle session daemons more reliably ([#96](https://github.com/modem-dev/hunk/pull/96)).
- Coordinated singleton daemon launches to avoid duplicate background processes ([#97](https://github.com/modem-dev/hunk/pull/97)).
- Exited the daemon process cleanly after shutdown ([#98](https://github.com/modem-dev/hunk/pull/98)).

## [0.6.0] - 2026-03-23

### Added

- Added a reload shortcut for the current diff ([#83](https://github.com/modem-dev/hunk/pull/83)).

### Changed

- Optimized large split review streams for faster rendering on big changesets ([#76](https://github.com/modem-dev/hunk/pull/76)).
- Replaced footer hints with a keyboard help modal ([#88](https://github.com/modem-dev/hunk/pull/88)).

### Fixed

- Restored daemon autostart for prebuilt npm binaries ([#84](https://github.com/modem-dev/hunk/pull/84)).
- Detected `$bunfs` virtual paths correctly when autostarting daemons from Bun binaries ([#86](https://github.com/modem-dev/hunk/pull/86)).
- Published prerelease tags to npm under the `beta` dist-tag ([#87](https://github.com/modem-dev/hunk/pull/87)).

## [0.5.1] - 2026-03-23

### Fixed

- Improved friendly Git command errors during CLI failures ([#75](https://github.com/modem-dev/hunk/pull/75)).

## [0.5.0] - 2026-03-22

### Added

- Added inline agent notes across the review stream, including side-aware range guides ([#69](https://github.com/modem-dev/hunk/pull/69), [#62](https://github.com/modem-dev/hunk/pull/62)).
- Added a session control CLI and a session reload command for live review workflows ([#50](https://github.com/modem-dev/hunk/pull/50), [#63](https://github.com/modem-dev/hunk/pull/63)).
- Added live session comment lifecycle support and expanded the MCP tool surface ([#53](https://github.com/modem-dev/hunk/pull/53), [#39](https://github.com/modem-dev/hunk/pull/39)).
- Added curated Hunk demo examples ([#34](https://github.com/modem-dev/hunk/pull/34)).

### Changed

- Made Graphite the default theme ([#57](https://github.com/modem-dev/hunk/pull/57)).
- Switched review rendering and scroll math to an explicit review row plan for more consistent navigation ([#64](https://github.com/modem-dev/hunk/pull/64), [#67](https://github.com/modem-dev/hunk/pull/67)).

### Fixed

- Hardened MCP daemon lifecycle handling and kept the daemon loopback-only by default ([#36](https://github.com/modem-dev/hunk/pull/36), [#46](https://github.com/modem-dev/hunk/pull/46)).
- Refreshed stale MCP daemons when using the session CLI ([#55](https://github.com/modem-dev/hunk/pull/55)).
- Let the sidebar shortcut force the files pane open ([#56](https://github.com/modem-dev/hunk/pull/56)).

## [0.4.0] - 2026-03-22

### Added

- Auto-started the MCP daemon when needed for live sessions ([#29](https://github.com/modem-dev/hunk/pull/29)).
- Added arrow-key line-by-line scrolling ([#30](https://github.com/modem-dev/hunk/pull/30)).

## [0.3.0] - 2026-03-22

### Added

- Added prebuilt npm binary packaging and automated npm releases, including beta tag support ([#12](https://github.com/modem-dev/hunk/pull/12), [#14](https://github.com/modem-dev/hunk/pull/14), [#15](https://github.com/modem-dev/hunk/pull/15)).
- Added a top-level `hunk --version` command ([#19](https://github.com/modem-dev/hunk/pull/19)).
- Added the experimental MCP daemon for live Hunk sessions ([#22](https://github.com/modem-dev/hunk/pull/22)).

### Changed

- Always showed the diff rail while dimming inactive hunks ([#16](https://github.com/modem-dev/hunk/pull/16)).
- Decoupled sidebar visibility from layout toggles ([#18](https://github.com/modem-dev/hunk/pull/18)).
- Stopped auto-saving view preferences to config files ([#13](https://github.com/modem-dev/hunk/pull/13)).

### Fixed

- Used a supported Intel macOS runner for prebuilt release builds ([#17](https://github.com/modem-dev/hunk/pull/17)).
- Preserved executable permissions for prebuilt binaries after installation.

## [0.2.0] - 2026-03-20

### Fixed

- Fixed npm installs by bundling Bun in published packages ([#11](https://github.com/modem-dev/hunk/pull/11)).

## [0.1.0] - 2026-03-20

### Added

- Initial Hunk release with split and stack terminal diff views built around a single multi-file review stream.
- Added git-style `diff` and `show` commands plus a general Git pager wrapper for drop-in review workflows.
- Added persistent Hunk view preferences across sessions ([#7](https://github.com/modem-dev/hunk/pull/7)).
- Added agent-note anchored review flows, responsive layouts, and display toggles for line numbers, wrapping, and hunk metadata.

### Changed

- Simplified the review chrome around a menu bar, lighter borders, and diff-focused headers.
- Improved startup and large-review performance with windowed diff sections and deferred syntax highlighting.

### Fixed

- Stabilized diff repainting, active-hunk scrolling, syntax highlighting, pager stdin patch handling, and terminal cleanup on exit.

[Unreleased]: https://github.com/modem-dev/hunk/compare/v0.15.3...HEAD
[0.15.3]: https://github.com/modem-dev/hunk/compare/v0.15.2...v0.15.3
[0.15.2]: https://github.com/modem-dev/hunk/compare/v0.15.1...v0.15.2
[0.15.1]: https://github.com/modem-dev/hunk/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/modem-dev/hunk/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/modem-dev/hunk/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/modem-dev/hunk/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/modem-dev/hunk/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/modem-dev/hunk/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/modem-dev/hunk/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/modem-dev/hunk/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/modem-dev/hunk/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/modem-dev/hunk/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/modem-dev/hunk/compare/v0.9.5...v0.10.0
[0.9.5]: https://github.com/modem-dev/hunk/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/modem-dev/hunk/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/modem-dev/hunk/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/modem-dev/hunk/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/modem-dev/hunk/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/modem-dev/hunk/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/modem-dev/hunk/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/modem-dev/hunk/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/modem-dev/hunk/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/modem-dev/hunk/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/modem-dev/hunk/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/modem-dev/hunk/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/modem-dev/hunk/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/modem-dev/hunk/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/modem-dev/hunk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/modem-dev/hunk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/modem-dev/hunk/tree/v0.1.0
