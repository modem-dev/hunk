# Semantic diff feasibility for Hunk

## Recommendation

**Do not replace Hunk's default Pierre-based diff pipeline.** If we pursue semantic diffs, the safest path is an **optional backend** behind a flag such as `--semantic`, with normal Pierre line diffs remaining the default.

Recommended order:

1. **Prototype an adapter around difftastic** for supported files only.
2. Keep clear fallback to Hunk's existing Pierre/text diff path.
3. Only consider an in-process semantic engine if the prototype proves the UX win is worth the added startup, packaging, and maintenance cost.

## Why this should be optional, not default

Hunk is optimized for:

- fast startup
- multi-file review streams
- responsive keyboard/mouse navigation
- agent-note anchoring by file/hunk/line
- predictable split/stack rendering from one normalized diff model

Semantic diffing helps most when a reviewer is dealing with:

- heavy reformatting
- moved expressions within a line or nested structure
- syntax where line diffs are especially noisy

But it also adds real costs:

- slower startup on supported languages
- more parser/runtime dependencies
- more fallback cases
- more work to preserve Hunk's current review-stream semantics

That makes semantic diff a better **mode** than a new universal default.

## How difftastic works today

From the difftastic README and source:

- It detects language from file path/source hints.
- It parses supported files with **tree-sitter**.
- It converts each parse tree into its own simplified syntax model made of **lists** and **atoms**.
- It computes a structural diff as a **graph problem** and uses **Dijkstra's algorithm** to find a low-cost path through the two syntax trees.
- It applies language-aware cleanup passes such as its **slider** logic so the final diff matches human intuition better.
- It falls back to **line-oriented diffing** when:
  - the language is unsupported
  - a file exceeds `--byte-limit`
  - parse errors exceed `--parse-error-limit`
  - the structural diff graph exceeds `--graph-limit`

Relevant implementation details from difftastic's source:

- `src/parse/tree_sitter_parser.rs`
  - defines per-language parser config
  - maintains delimiter tokens and forced atom nodes
  - supports limited embedded sub-languages (for example HTML subtrees)
- `src/diff/graph.rs`
  - builds the tree-diff graph
- `src/diff/dijkstra.rs`
  - runs shortest-path search with a graph-size cap
- `src/diff/sliders.rs`
  - adjusts valid-but-ugly structural matches into more readable ones
- `src/line_parser.rs`
  - supplies the text fallback path
- `src/main.rs`
  - wires together language detection, parse/fallback decisions, and rendering

## What seems reusable vs not reusable

### Reusable ideas

These are the parts Hunk can learn from directly:

- **Tree-sitter as the parser boundary**
- **Per-language delimiter/atom tuning**
- **Hard fallback limits** for byte size, parse errors, and graph size
- **Optional semantic mode** instead of forcing structural diff everywhere
- **Language-specific post-processing** to make structural diffs match reviewer intuition
- **Sub-language parsing** for embedded code blocks where practical

### Potentially reusable implementation surface

There are two practical ways to reuse difftastic itself:

#### 1. Shell out to the `difft` binary

Pros:

- fastest prototype
- immediately benefits from difftastic's mature parser and matcher
- no need to port graph/AST logic into Bun/TypeScript first

Cons:

- adds an external runtime dependency
- requires process spawning per file or per diff
- machine-readable output is **explicitly unstable** today (`DFT_UNSTABLE=yes` for JSON output)
- hard to make this feel like a first-class built-in Hunk capability if the binary is missing

#### 2. Build or vendor a dedicated in-process semantic backend

Pros:

- full control over data model and caching
- easier to integrate tightly with Hunk's renderer and note model
- no external binary requirement

Cons:

- effectively a new diff engine project
- large parser/dependency footprint
- higher startup and maintenance burden
- we'd be rebuilding a lot of difftastic's hard-won language heuristics

### What is **not** directly reusable

Difftastic's current terminal output is not the right abstraction for Hunk. Hunk needs structured data, not rendered text.

Even difftastic's JSON mode is currently best treated as a **prototype input**, not a stable long-term contract.

So the reusable asset is mainly:

- the semantic engine behavior
- the parser heuristics
- the fallback strategy
- the idea of a structured semantic row/chunk format

not its current CLI presentation layer.

## What this means for Hunk's architecture

Hunk currently normalizes everything into a `DiffFile` with:

- `patch`
- `stats`
- `language`
- Pierre `FileDiffMetadata`
- optional agent file context

That works well because both split and stack rendering derive from one line/hunk-oriented model.

Semantic diff support would need **one more abstraction layer** before rendering.

### Likely new model shape

Instead of making the UI talk directly to Pierre metadata forever, Hunk would likely need something like:

- `backend: "pierre" | "semantic"`
- per-file normalized sections/chunks
- row-level display tokens for split/stack
- stable line mappings back to old/new line numbers
- hunk/chunk ids that agent notes and navigation can target

In other words, semantic diff support is not just a loader change. It pushes Hunk toward a more explicit **render-model layer** above the raw diff engine.

## UX fit with Hunk

### What fits well

Semantic diff could fit Hunk well when used as:

- an optional review mode
- a per-file backend for supported languages
- a way to reduce noise in refactors/reformatting-heavy reviews

Hunk's current strengths still map cleanly:

- sidebar stays file-oriented
- main pane stays a top-to-bottom multi-file review stream
- split and stack layouts can remain terminal-native
- agent notes can still live beside the code if we preserve line/chunk anchors

### What gets harder

These parts become materially harder:

- line-number accuracy when structure and display rows diverge
- stable hunk ids for `[` and `]` navigation
- agent-note anchoring when semantic chunks do not correspond 1:1 to patch hunks
- caching and lazy loading without hurting startup
- preserving pager-mode simplicity

## Performance and startup implications

This is the biggest product risk.

Difftastic itself documents performance as a known weakness on files with many changes. Its source also shows why:

- tree-sitter parse work on both sides
- conversion into a custom syntax tree
- graph construction
- shortest-path search with explicit graph limits
- post-processing passes for readability

For Hunk, that means:

- worse cold start than today's Pierre path on supported files
- more variance based on language/parser quality
- possible worst-case cliffs on large, churn-heavy diffs
- more work to keep the review stream interactive while semantic results load

A semantic mode therefore probably needs:

- hard per-file size/change limits
- async/lazy loading per file
- visible fallback behavior
- benchmarking against real Hunk review workloads, not just one file in isolation

## Dependency, packaging, and maintenance tradeoffs

### External difftastic backend

- Hunk stays relatively small
- install story gets worse unless `difft` is optional
- compiled Hunk binary would no longer be self-contained for semantic mode

### In-process tree-sitter backend

- much larger dependency surface
- likely more bundled grammars or parser assets
- more binary size and startup cost
- more parser breakage to own over time

### Licensing

- Hunk is MIT
- difftastic is MIT
- difftastic's vendored parsers include a mix of MIT and Apache licenses

That does not look like a blocker, but it does mean vendoring/parser packaging would need care.

## Best product shape for Hunk

The best product shape appears to be:

### Phase 1: optional experimental mode

- `hunk git --semantic`
- enabled only for supported text languages
- falls back per file to today's Pierre path when unsupported/too large/too slow
- probably start with **split view only** if needed, then add stack once the model settles

### Phase 2: per-file backend selection in the review stream

- preserve one review stream
- some files can be semantic, others Pierre/text fallback
- keep sidebar ordering and navigation unchanged

### Phase 3: smarter defaults

Only if performance and correctness are good enough:

- auto-enable semantic mode for specific languages or small files
- keep an easy global off switch

## Practical implementation options

### Option A: prototype via `difft --display json` (recommended first)

Use difftastic as an external engine and translate its JSON output into a Hunk-specific semantic render model.

Pros:

- smallest implementation investment
- best way to validate UX value quickly
- lets us answer whether semantic diffs are worth deeper investment

Cons:

- unstable upstream JSON contract today
- external binary dependency
- likely awkward error/fallback handling

This is still the best first step.

### Option B: upstream/stabilize a machine-readable difftastic API

Instead of treating difftastic JSON as a private interface, push toward a stable output contract or library boundary.

Pros:

- better long-term reuse story
- less risk of Hunk chasing CLI-output changes

Cons:

- depends on upstream collaboration
- slower path to a prototype

### Option C: build Hunk's own semantic backend

Likely only worth considering after Phase 1 proves semantic diff is important to the product.

Pros:

- best long-term integration
- full control over model and performance tradeoffs

Cons:

- highest cost by far
- likely months of work if language coverage matters

## Suggested incremental path

1. **Add a design-only abstraction** in Hunk for multiple diff backends at the file level.
2. **Prototype a hidden adapter** that shells out to `difft --display json` for `hunk diff <left> <right>` on one supported file.
3. Normalize that into a Hunk-owned semantic row/chunk model.
4. Render it in **split view first**.
5. Measure:
   - startup latency
   - per-file load latency
   - huge-file fallback behavior
   - navigation correctness
   - note anchoring quality
6. If the UX win is real, extend to stack view and multi-file review streams.
7. Only then decide whether to keep the external dependency, push on upstream integration, or invest in an in-process engine.

## Bottom line

Semantic diff support looks **worth exploring**, but not as a default replacement for Hunk's current diff engine.

The best next step is a **small experimental PR or branch** that treats difftastic as an optional backend and proves three things:

1. the review UX is materially better on real refactor-heavy diffs
2. line/chunk anchoring still works for Hunk's navigation and notes
3. startup and per-file latency stay acceptable with strict fallbacks

If those three do not hold, Hunk should keep semantic diff as a research path rather than a shipped core feature.
