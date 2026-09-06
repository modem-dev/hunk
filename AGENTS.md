# hunk agent notes

## purpose

- Terminal-first diff viewer for understanding coding-agent changesets.
- Product target is "modern desktop diff tool in a terminal", not a pager-style TUI.

## architecture

```text
CLI input
  -> parse runtime + config-backed view options
  -> normalize into one Changeset / DiffFile model
  -> App shell coordinates state, layout, and review navigation
  -> pane components render review UI
  -> Pierre-backed terminal renderer draws diff rows
```

### shared review seam

Review core serves multiple surfaces: TUI today; web, API, and agent/runtime consumers later. Do
not recreate semantic review behavior in a surface:

```text
DiffFile[] -> projectReviewDocument -> ReviewDocumentV1 -> ReviewStore
ReviewIntent + caller facts -> planReviewIntent -> ReviewAction[] -> reducer -> surface projection
```

- **Model:** `packages/hunk/src/core/review/{types,document,identity}.ts` owns the ordered, JSON-safe document.
  File order is review/sidebar order; use `key` (referenced as `fileKey` elsewhere),
  `contentIdentity`, and `sourceIdentity` (cached source text additionally requires
  `sourceAttested`) — not runtime IDs or indexes — across reloads/surfaces.
- **Shared derivations:** `geometry.ts`, `expansion.ts`, `anchors.ts`, `stml.ts`, and
  `contentManifest.ts` own ranges, gaps, source splitting, note targets/ownership, tag roles, and
  parity manifests. Consume them; never re-derive those facts in a renderer.
- **State:** `state.ts` is semantic state; `actions.ts` transitions; `reducer.ts` pure/no-I/O;
  `selectors.ts` shared policies; `store.ts` synchronous observable storage. New cross-surface
  operations start as intents. Callers supply mutable-note IDs/timestamps; core derives identities.
- **Surfaces/publishers:** `useTerminalReview.ts` is the TUI adapter and
  `reviewNoteMapping.ts` is terminal-only. Rows, measurement, scrolling, layout, themes, DOM
  mechanics, and source I/O stay local. `useHunkSessionBridge.ts` publishes the current terminal
  session export; `registration.ts` builds its metadata/initial snapshot and `bridge.ts` receives
  agent commands. This broker export is not a full `ReviewState` mirror.
- **Other consumers:** Web/API consumers reuse the model, derivations, state, intents, and the
  producer/protocol tier. Never build a parallel protocol. Keep presentation/client-local state
  local; host/extension commands need explicit remote capabilities. See
  `docs/browser-review-rebuild.md` for the rollout and current boundaries.
- **Conformance:** `test/review-conformance/` has hand-authored semantic fixtures covering every
  registered core, terminal, producer, broker, protocol, and extension projection. Every new
  semantic consumer registers its real projection and runs the whole corpus.
  `scripts/source-boundaries.test.ts` keeps the seam
  renderer/platform-free; its Node-debt list is shrink-only and tombstone lists append-only. A
  repaid seam finding deletes copies, adds a file or banned-symbol tombstone and adversarial
  fixture, registers consumers, and updates `docs/browser-review-seam-audit.md`.

- Bundled VCS implementations live under `packages/hunk/src/extensions/default/vcs/<provider>/` and consume the
  public extension contract; `packages/hunk/src/app` composes their registrations into the provider-neutral
  core VCS catalog. Do not add provider commands, spawning, or source readers under `packages/hunk/src/core`.
- `hunk daemon serve` is the one loopback daemon for all live sessions; sessions auto-start and
  register with it rather than opening per-TUI ports. Reuse `classifyReviewPublication` and
  `ReviewChunkAssembler` for publication ordering and bounded, digest-verified resources. Browser
  review stays same-origin with no CORS; each session mints its capability and gives the daemon only
  its digest. Transport semantics come from the browser-safe review protocol modules and the
  existing intent path. See `docs/browser-review-rebuild.md` and the relevant module headers.
- User and bundled extensions share one API and registry. Shipped VCS backends and the built-in
  sidebar register through the public contract. Keep `packages/hunk/src/extension-api/types.ts` import-free,
  bundled VCS renderer-free, repo-local extensions trust-gated, and bundled extensions active under
  `--no-extensions`. See `docs/extension-architecture.md`, `docs/extensions.md`, and
  `packages/hunk/skills/hunk-extensions/SKILL.md`.
- Sidecar file order is intentional sidebar and review-stream order.
- Derive shared rendering, navigation, scrolling, and note behavior from one planning layer. Make
  shared geometry explicit, and remove obsolete paths instead of retaining parallel implementations.

## architectural rules

- Import boundaries between `packages/hunk/src/` top-level trees are enforced by `bun run deps:check`
  (dependency-cruiser; rules in `.dependency-cruiser.cjs`, target tiers in
  `docs/module-boundaries.md`). The known-violations baseline is shrink-only: fix an edge, rerun
  `bun run deps:baseline`, never add to it.
- Keep the app review-first: the main pane is a single top-to-bottom stream of all visible file diffs.
- The sidebar is for navigation. Selecting a file jumps to that file in the main review stream; it should not collapse the main pane to one file.
- Keep Pierre as the diff engine and renderer foundation. Do not switch the main renderer back to OpenTUI's built-in `<diff>` widget.
- Keep split and stack views terminal-native and driven from the same normalized diff model.
- Preserve mouse + keyboard parity for primary actions.
- Keep the chrome restrained: top menu bar, minimal borders, no redundant metadata headers.

## component guidance

- Keep `App` as the orchestration shell for state, navigation, layout, theme, filtering, and pane
  coordination; pane rendering belongs in dedicated components.
- Confirmation prompts with a small set of choices should reuse `ConfirmDialog` (body rows plus a clickable key-legend action row) instead of composing `ModalFrame` with a hand-rolled footer; keyboard handling for its actions stays in `useAppKeyboardShortcuts`.
- Extend existing components or add focused components rather than growing `App` into a monolith.
- Shared formatting, ids, and small derivations belong in helpers, not repeated inline.
- When refactoring logic that spans helpers and UI components, add tests at the level where the user-visible behavior actually lives, not only at the lowest helper layer.

## theme guidance

- Built-in theme ids and source metadata live in `packages/hunk/src/core/theme/catalog.ts`; `packages/hunk/src/ui/themes.ts`
  derives Hunk's semantic `AppTheme` values.
- When adding or renaming a built-in theme, update validation, public exports, docs/examples, the
  appropriate Changeset, and tests. Keep source palette tokens separate from semantic mappings and
  cover non-trivial derived colors.
- `BUNDLED_SHIKI_THEME_DIFF_COLORS` in `packages/hunk/src/core/theme/catalog.ts` is generated. Edit the sourcing policy in `scripts/generate-theme-diff-colors.ts`, then run `bun run generate:theme-colors`.

## testing

- Colocate unit tests with the code they cover (`packages/hunk/src/core/foo.ts` + `packages/hunk/src/core/foo.test.ts`, `packages/hunk/src/ui/AppHost.*.test.tsx`, `packages/hunk/src/ui/lib/*.test.ts`).
- Put shared unit-test helpers in `test/helpers/`.
- Name test helpers so they explicitly include `Test` and are clearly test-only (`createTestDiffFile`).
- Use repo-level `test/` directories by intent:
  - `test/cli/` for black-box CLI contract coverage.
  - `test/session/` for daemon/session integration and end-to-end flows.
  - `test/pty/` for PTY-backed live UI integration tests.
  - `test/review-conformance/` for the shared review model's golden fixtures and per-consumer conformance suites.
  - `test/smoke/` for opt-in terminal transcript smoke coverage.

## code comments

- Add short JSDoc-style comments to functions and helpers.
- Write header comments in active voice: the first sentence says what the module or function
  does ("Applies one action to the review state and returns the next state."), followed by its
  invariants. Avoid passive or self-important framing ("The one place where…", "the single
  source of truth for…") — name the behavior, not the architecture's opinion of itself.
- For orchestration and controller modules, explain the product workflow before the mechanics:
  name the user-visible triggers that converge there, state what the module owns, identify the
  neighboring authority it deliberately leaves elsewhere, and call out preservation or
  non-reloadable invariants. Prefer concrete flows ("watch changes and manual refresh both rebuild
  the mounted review") over abstract labels ("handles refresh").
- Add inline comments for intent, invariants, or tricky behavior that would not be obvious to a fresh reader.
- Skip comments that only narrate what the code already says.

## naming

- Prefer names that match the role the code plays in the product and architecture.
- Use `layout` for structural placement or arrangement data.
- Use `geometry` for aggregate spatial data used by rendering, scrolling, or interaction.
- Use `bounds` for one concrete visible extent within a larger structure.

## review behavior

- Default behavior is a multi-file review stream in sidebar order.
- Layout modes are `auto`, `split`, and `stack`. `auto` chooses split on wide terminals and stack
  on narrow ones; explicit modes override it.
- `[` and `]` navigate hunks across the full review stream. Do not reintroduce `j`/`k` hunk navigation unless the user asks.
- Agent context belongs beside the code, not hidden in a separate mode or workflow.
- Agent notes are hunk-specific: show notes for the selected hunk, render them in the diff flow near the annotated row, and keep a clear spatial relationship to the code they explain.
- Keep note behavior explicit. If the UI intentionally prioritizes one note, one selection, or one active target, encode that as a named policy rather than scattering array-index assumptions through the codebase.
- STML markup notes (experimental) live in `packages/hunk/src/ui/lib/stml/`. The layout engine is deliberately a deterministic line layout, not OpenTUI flexbox: the row-windowed review stream needs exact note heights before mount, so `(markup, width)` must always produce the same lines. Colors stay symbolic until render time so measurement never needs a theme. Do not "simplify" this into flexbox renderables, and keep note-card geometry in `agentNoteGeometry` as the single source for rendering, measurement, and agent-facing width reporting.
- Keep temporary sidecars concise and review-oriented. Their file order is intentional, while the
  visible note UI remains hunk-note driven rather than showing generic explainer cards.
- Agents review via `packages/hunk/skills/hunk-review/SKILL.md` using `hunk session *` commands; do not run interactive TUI commands directly.
- `packages/hunk/skills/hunk-review/SKILL.md` is generated. Edit `packages/hunk/src/hunk-review/skillDocument.ts`, `packages/hunk/src/session/agent/surface.ts`, or `packages/hunk/src/session/agent/errors.ts`, then run `bun run generate:skill`; never hand-edit the skill file.

## binary notes

- Installed `hunk` is a compiled snapshot, not linked to source.
- After source changes, rebuild/reinstall with `bun run install:bin`.
- For rendering verification, prefer a real TTY smoke run over redirected stdout capture.

## verification

- For rendering changes: run `bun run typecheck`, `bun run test`, `bun run test:integration`,
  `bun run test:tty-smoke`, and do one real TTY smoke run on an actual diff.
- For interaction, layout, scrolling, navigation, windowing, or other terminal-native behavior: add or update PTY integration coverage in `test/pty/*-integration.test.ts` and run it with `bun run test:integration`.
- For CLI, config, or pager work: make sure the relevant source invocation still works (`diff`, `show`, `patch`, or `pager`).
- Preserve current interaction model unless the user asks to change it explicitly.

## cross-platform support

- Hunk should work on macOS, Linux, and Windows. Keep tests and CI portable unless a case is explicitly Unix-only (PTY/TTY smoke coverage is Unix-only).
- In tests, avoid hard-coded POSIX paths, separators, shell syntax, and filenames invalid on Windows; use Node path helpers for real filesystem paths while preserving user-provided/protocol paths when pass-through is intentional.
- If Windows-only Bun behavior appears around timers, sockets, or line endings, prefer a small compatibility fix or a narrowly scoped skip with a comment over broadening Unix assumptions.

## releases

- User-visible changes require a Changeset; maintenance-only changes require an empty Changeset.
  Follow `.changeset/README.md` and do not edit `CHANGELOG.md` directly.
- For release preparation, publishing, backports, and post-release verification, read `skills/hunk-release/SKILL.md`.
- Never push a release tag or trigger publishing without explicit user confirmation.
- `hunk.dev/changelog` is generated from `CHANGELOG.md` by `bun run generate:changelog`; hand-author only `website/releases/notes.json`, and never edit its output. `docs/changelog-on-hunk-dev.md` explains how release dates and the pre-tag window work.

## repo notes

- Local review artifacts are ignored on purpose. Leave them alone unless the user explicitly wants them updated, and do not commit them.
- Before committing or preparing a PR, follow `CONTRIBUTING.md`.
