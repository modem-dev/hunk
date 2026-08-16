/**
 * Enforces module boundaries on the production import graph (`src/` plus `packages/`).
 *
 * Each rule names one boundary of the target architecture described in
 * docs/module-boundaries.md. Pre-existing violations live in
 * .dependency-cruiser-known-violations.json; that baseline is shrink-only — fix a
 * violation, regenerate the baseline with `bun run deps:baseline`, and never add to it.
 * `bun run deps:check` fails on any violation not in the baseline.
 */

// UI files allowed to couple to src/app and src/session: the composition shell and the
// two named session adapters. Everything else in src/ui stays presentation-only.
const UI_SESSION_ADAPTERS = [
  "^src/ui/App\\.tsx$",
  "^src/ui/AppHost\\.tsx$",
  "^src/ui/runInteractiveApp\\.tsx$",
  "^src/ui/hooks/useHunkSessionBridge\\.ts$",
  "^src/ui/hooks/useTerminalReview\\.ts$",
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
        "The extension host and bundled extensions sit below the surfaces that load them. Bundled UI extensions must consume the runtime-module surface the API serves, not reach into src/ui internals — that reach-in is exactly what third-party extensions cannot do.",
      severity: "error",
      from: { path: "^src/extensions/" },
      to: { path: "^src/(ui|app|session|opentui)/" },
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
