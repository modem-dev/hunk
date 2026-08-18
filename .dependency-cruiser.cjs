/**
 * Enforces module boundaries on the production import graph (`src/` plus `packages/`).
 *
 * Each rule names one boundary of the target architecture described in
 * docs/module-boundaries.md. Pre-existing violations live in
 * .dependency-cruiser-known-violations.json; that baseline is shrink-only — fix a
 * violation, regenerate the baseline with `bun run deps:baseline`, and never add to it.
 * `bun run deps:check` fails on any violation not in the baseline.
 */

// UI files allowed to couple to src/app and src/session: the composition shell, the two
// named session adapter hooks, and the session-navigation resolution helper those hooks
// share. Everything else in src/ui stays presentation-only.
const UI_SESSION_ADAPTERS = [
  "^src/ui/App\\.tsx$",
  "^src/ui/AppHost\\.tsx$",
  "^src/ui/runInteractiveApp\\.tsx$",
  "^src/ui/hooks/useHunkSessionBridge\\.ts$",
  "^src/ui/hooks/useTerminalReview\\.ts$",
  "^src/ui/lib/reviewState\\.ts$",
];

// Every way the shipped product is entered: the CLI, the highlight worker thread, the two
// published facades, and the skill generator. A module under src/ that no entry reaches,
// directly or transitively, is not in the product.
const PRODUCTION_ENTRY_POINTS = [
  "^src/main\\.tsx$",
  "^src/highlightWorkerEntry\\.ts$",
  "^src/opentui/index\\.ts$",
  "^src/extension-api/index\\.ts$",
  "^src/hunk-review/skillDocument\\.ts$",
  // The browser review page's mount entry. The daemon serves the bundle built from it
  // (Phase 6 of docs/browser-review-rebuild.md wires the route); until then it is the
  // root the browser-tier boundary walk in scripts/source-boundaries.test.ts starts from.
  "^src/web/main\\.tsx$",
];

// Modules kept alive by tests alone. The cruise excludes tests, so these look unreachable
// from the entry points while real coverage still depends on them. Shrink-only: an entry
// leaves when production reaches the module or the module goes; nothing is ever added
// without the coverage to justify it.
const TEST_ONLY_MODULES = [
  // Note-height measurement exercised by the review-conformance corpus.
  "^src/core/review/noteSize\\.ts$",
  // The floating agent-note popover and its measurement helper. Nothing renders them since
  // notes moved into the diff flow as STML cards; their unit tests are the only consumers
  // left, so they are quarantined here until that call is made rather than deleted blind.
  "^src/ui/components/panes/AgentCard\\.tsx$",
  "^src/ui/lib/agentPopover\\.ts$",
];

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment:
        "Import cycles make every member file one module in disguise: none can be understood, tested, or extracted alone.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "extension-api-is-import-free",
      comment:
        "src/extension-api is the published contract; declaration emission publishes whatever it reaches (scripts/check-pack.ts gates the pack, this gates the graph).",
      severity: "error",
      from: { path: "^src/extension-api/" },
      to: { path: "^(src|packages)/", pathNot: "^src/extension-api/" },
    },
    {
      name: "lib-is-a-leaf",
      comment:
        "src/lib holds dependency-free helpers usable from any tier; it may reach the import-free extension API contract and nothing else.",
      severity: "error",
      from: { path: "^src/lib/" },
      to: { path: "^(src|packages)/", pathNot: "^src/(lib|extension-api)/" },
    },
    {
      name: "core-stays-domain",
      comment:
        "src/core is the domain model. It may use src/lib and the extension-api contract, but never the UI, app composition, session brokering, extension host, or opentui facade above it.",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: "^src/(ui|app|session|extensions|opentui)/" },
    },
    {
      name: "extensions-host-stays-below-surfaces",
      comment:
        "The extension host and bundled extensions sit below the surfaces that load them. The bundled UI tier (src/extensions/default/ui/) is exempt from the src/ui half by documented design: its dogfooding boundary is the published props contract — data, actions, theme — while rendering helpers are host code (see the sidebar module header).",
      severity: "error",
      from: { path: "^src/extensions/", pathNot: "^src/extensions/default/ui/" },
      to: { path: "^src/(ui|app|session|opentui)/" },
    },
    {
      name: "bundled-ui-extensions-render-only",
      comment:
        "The bundled UI tier may consume src/ui rendering helpers as host code, but composition and session brokering stay out of reach — a pane gets its data and actions through the published props.",
      severity: "error",
      from: { path: "^src/extensions/default/ui/" },
      to: { path: "^src/(app|session|opentui)/" },
    },
    {
      name: "session-stays-below-app-and-ui",
      comment:
        "src/session brokers transport and protocol. It consumes core and packages; the app tier registers into it, not the other way round.",
      severity: "error",
      from: { path: "^src/session/" },
      to: { path: "^src/(ui|app|extensions|opentui)/" },
    },
    {
      name: "app-composes-without-ui",
      comment:
        "src/app wires core, extensions, and session together for startup; rendering stays in src/ui, which imports app — never the reverse.",
      severity: "error",
      from: { path: "^src/app/" },
      to: { path: "^src/(ui|opentui)/" },
    },
    {
      name: "ui-couples-to-session-via-adapters",
      comment:
        "Only the composition shell and the named session adapter hooks may import src/app or src/session; ordinary UI components and helpers stay presentation-only so the review surface can move to other hosts.",
      severity: "error",
      from: { path: "^src/ui/", pathNot: UI_SESSION_ADAPTERS },
      to: { path: "^src/(app|session)/" },
    },
    {
      name: "no-dead-modules",
      comment:
        "Every module under src/ earns its place by being reachable from an entry point. Dead files are worse than clutter: they still import, so they hold boundaries hostage and answer questions nobody asks. `orphan` only catches fully disconnected files, which misses dead code that still has dependencies — reachability catches both. A flagged module is either deleted or, if tests are its only real consumer, listed in TEST_ONLY_MODULES with a reason.",
      severity: "error",
      from: { path: PRODUCTION_ENTRY_POINTS },
      to: {
        path: "^src/",
        pathNot: [...PRODUCTION_ENTRY_POINTS, ...TEST_ONLY_MODULES],
        reachable: false,
      },
    },
    {
      name: "core-leaves-stay-below-bootstrap",
      comment:
        "core/bootstrap.ts composes the leaves: it names the changeset, the parsed input, the resolved preferences, and the detected theme mode to describe one launch. A module directory importing it back would invert that layering and rebuild the grab-bag cycle the 2026-08 phases dismantled. core/changeset/loaders.ts is the single exception — loadAppBootstrap assembles the value, so it names the shape it returns; its natural home is the app tier, and moving it there retires this exception.",
      severity: "error",
      from: {
        path: "^src/core/(changeset|run|process|install|review|vcs|watch|patch|theme)/",
        pathNot: "^src/core/changeset/loaders\\.ts$",
      },
      to: { path: "^src/core/bootstrap\\.ts$" },
    },
    {
      name: "review-reducer-is-module-internal",
      comment:
        "The review reducer applies actions; callers state intent instead, so surfaces cannot reach past planReviewIntent into the transition table. First of the per-module interior rules — this establishes the mechanism later phases extend to the rest of src/core (identity.ts and the other named model modules stay public by design).",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/core/review/" },
      to: { path: "^src/core/review/reducer\\.ts$" },
    },
    {
      name: "changeset-internals-stay-in-module",
      comment:
        "core/changeset owns the changeset model and the pipeline that acquires one. Outsiders name the model, the loaders, and the per-file helpers they build on (model, loaders, diffFile, fileSource, fileLanguage, binary, diffPaths, hunkHeader, hunkSummary); the patch-to-model parse, the Pierre extension-table lookup, and the sidecar reader are steps inside that pipeline, reached through the loaders instead.",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/core/changeset/" },
      to: {
        path: "^src/core/changeset/(fromPatch|fileLanguageLookup|sidecar)\\.ts$",
      },
    },
    {
      name: "packages-stay-standalone",
      comment:
        "Workspace packages are standalone publishable units; they never import the app source tree.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^src/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // Production graph only: tests are colocated and free to reach across boundaries.
    exclude: { path: ["\\.test\\.(ts|tsx)$", "(^|/)node_modules/"] },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
      mainFields: ["module", "main", "types"],
    },
  },
};
