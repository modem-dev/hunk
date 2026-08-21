# Rendering, geometry, and windowing

Use this reference when React commits, host renderables, Yoga/layout, scrolling, text measurement, or
large mounted trees appear in the hot path.

## Model the full render cost

A React/OpenTUI update can allocate or mutate several layers:

```text
React element and Fiber
  -> OpenTUI host renderable
  -> Yoga node or text-node hierarchy
  -> inherited style/chunk collection
  -> text buffer
  -> terminal draw buffer
```

Count host objects as well as React renders. An optimization that introduces more `<box>`, `<text>`,
or `<span>` hosts can lose even when fewer components rerender.

Profile both:

- React actual/commit duration;
- complete input-to-render wall time;
- host object creation and property updates;
- Yoga measurement/layout;
- text width and wrapping;
- text-buffer population and native/WASM drawing;
- retained heap and GC.

If React is only a small fraction of wall time, another memo boundary is unlikely to solve the
problem.

## Flat text versus text-node trees

Use a direct `StyledText` payload when all of these are true:

- the application already has ordered text/style runs;
- geometry is fixed or independently known;
- nested semantic text nodes are not needed;
- links, editing, selection, and dynamic range painting have a safe path;
- correctness tests can compare the flattened output.

Conceptually:

```tsx
const chunks = runs.map((run) => ({
  __isChunk: true,
  text: run.text,
  fg: resolveColor(run.fg),
  bg: resolveColor(run.bg),
}));

return <text content={new StyledText(chunks)} />;
```

Coalesce adjacent runs with identical style, sanitize terminal controls, and preserve cell-aware
clipping and padding. Avoid mutating shared run arrays while slicing or coalescing.

Keep a richer path for wrapped text, copy/cursor ranges, editable content, links, or other cases
where flattening would duplicate complex behavior. If a renderable must switch between manual
content and child nodes, test the transition explicitly; some renderer versions require distinct
keys or hosts to avoid transient invalid content.

## Do not add host nodes to save trivial React work

These patterns often regress:

- a separate box/text renderable for a one-character rail or badge;
- extra layout wrappers introduced only for memoization;
- explicit dimensions added in hope of bypassing measurement without profiling;
- one component per syntax token;
- one closure per visible row on every parent render.

A single broader text-buffer update may be cheaper than precise updates spread over more Yoga and
host nodes.

## Plan once

Build an immutable ordered plan that carries stable keys and all geometry-bearing information.
Derive measurement and rendering from that exact plan.

```ts
interface PlannedItem {
  key: string;
  height: number;
  // Domain payload or a stable reference to it.
}

interface ItemGeometry {
  key: string;
  top: number;
  height: number;
  bottom: number;
}
```

The same plan should power:

- total content height;
- viewport intersection;
- rendering order;
- reveal and alignment;
- hit testing;
- anchors and navigation;
- top/bottom spacer sizes.

Never let renderer-local height logic drift from navigation or scrolling logic.

## Deterministic height is the virtualization contract

Virtualization is safest when item height is a pure function of domain data plus explicit layout
inputs such as width, wrapping, and theme metrics. Rich content that affects height must have a
deterministic measurement representation.

If exact height is unavailable before mount:

- separate provisional startup geometry from authoritative geometry;
- do not derive semantic selection from guesses;
- preserve a bounded settling/reveal pass;
- test bottom clamping, distant targets, and resize.

## Hierarchical windowing

Large surfaces often need two layers:

```text
section window
  -> row/item window within mounted sections
```

At each layer:

1. keep absolute geometry sorted;
2. binary-search the first and last visible item;
3. add bounded overscan;
4. union selected/reveal/interaction targets;
5. emit exact top and bottom spacers;
6. preserve total content height.

Sparse section windows are valid: a selected target far from the viewport can mount as an island
between spacers without mounting every section in between.

Do not rely only on OpenTUI viewport culling. Host culling may skip drawing while React still owns,
reconciles, and retains the complete subtree.

## Structural nonvisual rows

Zero-height or hidden items may still preserve ordering, anchors, ownership, or stable identity.
Include them at window boundaries when downstream logic relies on them. Removing nonvisual
structure can make navigation or note/anchor placement drift even when the frame looks correct.

## Adaptive overscan

Use different policies for different motion:

- slow line movement: small steady overscan;
- wheel/page bursts: temporary larger halo;
- selected/reveal target: explicit inclusion;
- wrapped/variable-height content: more conservative bounds.

Bound burst overscan and clear it after an idle interval. Permanent large overscan wastes memory and
commit time; zero overscan risks blank bands while native scrolling outruns React.

## Identity rules

Memoization works only when upstream identities are deliberate:

- stable semantic keys, never host runtime ids or array indexes for durable items;
- immutable plans and row objects;
- stable themes/config objects;
- latest-value refs behind stable capability callbacks;
- reuse `{top, height}` or bounds objects when values did not change;
- shallow memo comparators that document their identity contract.

Avoid deep comparators over mutable data. They add hot-path work and still cannot make mutation safe.

## Separate geometry from paint

Selection, hover, cursor, search matches, and transient color should remain below geometry planning
unless they truly change size or order. Isolate high-frequency paint from expensive invariant text
or row structure, but verify that isolation does not add more host renderables than it saves.

## Scroll synchronization

OpenTUI controls live imperative scroll state. React usually needs a coalesced snapshot for
windowing and semantic viewport-follow behavior.

Recommended pattern:

- keep the scrollbox instance in a ref;
- subscribe to native change/layout events;
- coalesce reads on a bounded timer/frame;
- avoid synchronous `setState` from inside host layout or commit callbacks;
- update React state only when `{top, height}` actually changed;
- keep explicit-navigation suppression separate from passive viewport-follow selection.

When geometry-defining inputs change, prefer remounting an inner content root while retaining the
outer scrollbox and scroll position.

## Diagnostic questions

- How many React elements and OpenTUI host objects mount for one viewport?
- Which props change on one keypress or wheel tick?
- Does selection repaint invariant syntax/token content?
- Does prefetching force components to mount?
- Are row heights calculated independently in more than one place?
- Is wrapping mixed into the fixed-height fast path?
- Does an optimization reduce React time but increase Yoga or native time?
- Does retained heap fall in a way that corroborates object-count reduction?
