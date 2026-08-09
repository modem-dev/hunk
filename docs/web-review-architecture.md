# Web review architecture

This record defines the renderer boundary for browser review work. It is an incremental
contract: the v1 review document is initially a projection of the normalized terminal model,
then later phases move authority into a headless-capable runtime without changing terminal
behavior.

## Product invariant

A Hunk review is one continuous, intentionally ordered stream of files. Terminal and browser
may choose different layout, wrapping, colors, and scrolling, but they must consume the same
semantic document. Selecting a tree entry jumps within the stream; it never turns the primary
review into a single-file view.

```text
CLI/config/VCS/patch/sidecar
          |
          v
ReviewSessionRuntime (review process, authoritative)
  -> ReviewDocument generation + generation resources
  -> ReviewStore revisions and action reducer
  -> terminal adapter (OpenTUI/Pierre terminal renderer)
  -> session broker mirror and action proxy
       -> authenticated browser adapter (Pierre Diffs/Trees)
```

## Single-owner table

Each concern has exactly one owner. Adapters may request or observe work but must not repeat it.

| Concern                              | Sole owner                                   | Non-owners                                           |
| ------------------------------------ | -------------------------------------------- | ---------------------------------------------------- |
| Loading and extension transforms     | `ReviewSessionRuntime` in the review process | daemon, terminal renderer, browser                   |
| Semantic review state                | `ReviewStore` owned by that runtime          | React state, daemon cache, browser mirror            |
| Semantic action validation/reduction | `ReviewStore.dispatch`                       | terminal callbacks, agent commands, browser handlers |
| Watch/reload lifecycle               | `ReviewSessionRuntime`                       | React hooks, daemon, browser                         |
| Document/state mirroring             | the single loopback session broker           | review loaders and renderer adapters                 |

The review process remains authoritative. The broker mirrors published documents/state and
proxies actions back to the process; it never loads a repository, runs extensions, resolves
notes, or derives review semantics.

## Document and parity boundary

`ReviewDocumentV1` is JSON-safe and renderer-neutral. It preserves file order, semantic file
keys, paths and rename endpoints, change kinds, stats/flags, Pierre-derived hunk and source-line
content, moved-line markers, complete notes, expanded-context addresses, and resource
descriptors. It excludes source-fetcher functions, terminal rows/cells, syntax-highlight spans,
wrapping, note-card geometry, STML line layout, theme colors, viewport positions, hover, menus,
and tree-local expansion/search.

`ReviewContentManifest` resolves exact patch and materialized expanded-source resources into a
small deterministic parity snapshot. Shared fixtures assert the same ordered semantic content
without making renderer geometry part of equality. The projection is transitional: terminal
continues to consume `DiffFile` until the authoritative store/runtime phases land.

## Identity, generations, and revisions

- A document has a deterministic source identity and a publication `generation`.
- A file entry key hashes source identity, current and previous paths, and renderer-neutral diff
  content. This keeps repeated paths distinct without tying distinct entries to stream position;
  only semantically identical copies use an occurrence suffix because no content can distinguish
  them. Separate current/previous source-scoped path keys support rename/reload matching.
- Patch and source descriptors include generation and semantic file key. Resource IDs are
  generation-addressed, so stale source cannot be combined with a newer patch.
- Patch resources include UTF-8 size and digest. Lazy source descriptors carry a source identity;
  once source is materialized they also carry size and digest.
- Future store work adds a monotonic state revision within a generation. A generation publishes
  document, resources, and reconciled state atomically.

Exact raw per-file patches remain resources rather than being reinterpreted independently by the
browser. Source-fetcher functions remain process-local capabilities and never serialize.

## Notes and anchors

Core note policy classifies AI, live-agent, and user notes; preserves summary, rationale, STML,
title, author, timestamps, tags, confidence, editability, and original source; resolves
old/new/dual anchors; and computes both `intersectingHunkIndices` and one `ownerHunkIndex`.
Intersections drive selected-hunk visibility and badges when present; otherwise the owner supplies
the terminal fallback membership. The owner also drives single-target navigation and renderer
placement. A dual-range note can therefore intersect multiple hunks while its owner is the first
hunk intersecting the preferred new-side range, even when that range starts in collapsed context.

The named range-less ownership policy is **first hunk**: a range-less note belongs to hunk zero
when the file has a hunk, renders beside its first code row, contributes to that hunk's navigation
and badges, and exports `ownerHunkIndex: 0` with no ranged intersections. A hunkless file keeps the
note at file scope with no hunk owner. The named unmatched-ranged policy is **first-hunk
fallback**: when neither range intersects a visible hunk, ownership falls back to hunk zero to
match the terminal's first-code-row fallback while the intersection list remains empty. Terminal
note row insertion, card geometry, and deterministic STML line layout stay under `src/ui/`.

## Actions and synchronization

Renderer callbacks, session agent commands, and browser requests eventually dispatch the same
versioned semantic actions. Shared state includes selection/reveal intent, semantic filtering,
note visibility and mutation, and expanded context. Raw scroll, responsive auto layout, tree
search/expansion, hover, and pointer state remain renderer-local. Selection may be
last-writer-wins; note, expansion, and reload actions must carry generation preconditions.

## Broker, resources, and security

The existing single loopback broker serves all browser reviews; no review opens a per-session
port. Registration remains bounded by sending descriptors rather than arbitrary patch/source
bodies. Later protocol work reads resources in bounded chunks, verifies offsets/sizes/digests,
rejects stale generations, and evicts retired/disconnected generations.

Loopback binding is necessary but not sufficient. Browser routes require a per-session
capability exchanged for a scoped `HttpOnly`, `SameSite=Strict` cookie, strict Host/Origin checks,
CSP and framing/MIME/referrer protections. A capability for one session cannot read or mutate
another. Browser routes are disabled in unsafe remote-daemon mode. Assets are embedded and need
no external network access.

## Lifecycle

1. The review process performs canonical bootstrap and extension transforms once.
2. The runtime projects and atomically publishes generation document/resources/state.
3. Terminal consumes the authority directly; broker mirrors it for reconnecting browser clients.
4. Terminal, agent, or browser actions return to the authority and publish a new state revision.
5. Manual/watch/agent reloads serialize through the runtime; an older slow reload cannot replace
   a newer request.
6. Retired generations are rejected and evicted. Process disconnect removes its mirror. Browser
   tab closure does not implicitly terminate a watched/headless owning process.

Remote sharing, hosted/persistent reviews, multi-user collaboration, browser rendering of
OpenTUI-only extension components, and independent daemon/browser VCS loading are non-goals.

## Browser renderer boundary

The browser entry lives under `src/web/` and is bundled into the embedded offline asset module. It
is the only entry that imports React DOM. `pierreDocument.ts` is the sole adapter from broker
manifest/resources to `@pierre/diffs/react`; the browser never loads VCS state. The browser client
authenticates, mirrors complete snapshot/document events, reconstructs digest-checked SSE chunks,
rejects stale generations/revisions, and recovers revision gaps with a complete snapshot. Semantic
mutations use the existing actions route with generation and state-revision preconditions; selection
remains last-writer-wins within the active generation. A reconnect keeps mutations disabled until a
complete snapshot has been reconciled.

The main pane maps every semantically visible manifest file, in manifest order, into one continuous
stream. Shared core predicates apply the authoritative filter and note-source policy, including the
rule that user notes remain visible when agent notes are hidden. Canonical per-file projection
resources carry exact normalized lines, hunks, moved-line metadata, expansion addresses, and file
summaries; `pierreDocument.ts` consumes those resources without reparsing VCS semantics.

The `@pierre/trees` beta surface is isolated by `treeSource.ts`. Its normal presorted input is exactly
`preparePresortedFileTreeInput(document.files.map(file => file.path))`. Because Trees keys leaves by
path, duplicate current paths receive leaf-only invisible internal suffixes and a second prepared
input; rendered/searchable labels stay canonical, while bidirectional internal-path/semantic-key
maps keep every duplicate reachable. Rename origins remain display metadata. Tree search and
directory expansion are browser-local. Generation replacement resets paths, statuses, and
decoration data rather than mutating an append-only tree.

Both Pierre surfaces and chrome follow one live light/dark Hunk palette. Every visible file retains
an ordered stream wrapper and measured/estimated spacer geometry, while IntersectionObserver mounts
Pierre only inside a viewport overscan window. Off-window files unload after a short hysteresis,
release canonical/source cache entries, and remount on scrolling or Tree selection. Resource state is
keyed by generation plus resource ID; the app activates a replacement generation before descendants
render, aborting obsolete work before new resource effects run. Mutable selection and note revisions
reuse retained in-window generation cache entries. Only sanitized shared STML nodes become React
elements, valid markup replaces plain fallback text, and raw markup is never inserted as HTML.

## Local browser transport boundary

Browser review transport is a Hunk-only extension of the existing loopback daemon. Its route set is
closed to one review shell, capability exchange, snapshot, generation-addressed resources, observer
SSE, and semantic actions. Production safe-loopback daemons enable these routes; unsafe remote
broker mode always refuses them.

The review process creates 256 bits of random capability material and registers only its SHA-256
verifier. The clear capability stays process-local and appears only in the review URL fragment. The
embedded bootstrap removes that fragment before exchanging it for a short-lived, session-path-scoped
`HttpOnly`, `SameSite=Strict` cookie. Browser assets are generated into one TypeScript module and
compiled into source, npm, and standalone binary builds, so serving never consults adjacent files or
the network.

SSE subscribes to broker mirror observations rather than the producer websocket. Event history,
subscriber counts, queued event counts, explicit queue bytes, controller-buffered bytes, and
aggregate daemon bytes are bounded. The combined browser snapshot limit is the manifest limit plus
the mutable-state limit and explicit JSON framing room, rather than either producer envelope alone.
Document generations use a maximum 128-byte/character ASCII identifier syntax at every producer and
browser wire boundary. Large snapshots use bounded deterministic begin/chunk/end frames with size,
count, and digest metadata. SSE frame IDs contain a compact hash key rather than producer generation
text, and chunk batches are exactly preflighted before payload/frame byte allocation; the eager v1
transport reserves a conservative daemon aggregate budget for four maximum snapshots. Reconnects
replay complete retained batches from a bounded `Last-Event-ID`
and otherwise receive a chunked current snapshot. Open streams retain their cookie expiry and
capability identity, revalidate on timers and every publication/heartbeat, and close on expiry,
capability rotation, or session retirement. Resource reads use the same generation guard, verified
cache, and producer chunk protocol as daemon review exports.
Browser actions proxy the existing generation- and revision-guarded `apply_review_action` command
without adding a second reducer. Terminal source expansion and legacy session navigation/comment
commands enter the same `ReviewSessionRuntime` and `ReviewStore`; renderer adapters retain only local
cursor/scroll affordances.
