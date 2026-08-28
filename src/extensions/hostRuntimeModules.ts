import { dirname } from "node:path";
import { resolveCanonicalPath } from "../core/run/paths";

/**
 * Host-owned modules served to dynamically imported extension files.
 *
 * User extensions live outside the app bundle — a file in
 * `~/.config/hunk/extensions/` has no `node_modules` that reaches the React
 * compiled into the Hunk binary, and an adjacent `node_modules/react` (a
 * repo-local extension inside a JavaScript project) would resolve to a *second*
 * React whose hooks dispatcher is not the one Hunk renders with. That identity
 * is what makes extension-authored components (hooks included) mountable
 * inside Hunk's own tree — see `registerPane`.
 *
 * The mechanism is deliberately scoped to extension source, because the obvious
 * one is not safe: claiming the bare `react` specifier process-wide with a
 * `build.module` virtual module breaks the host's *own* lazily imported
 * modules when Hunk runs from source ("Requested module is already fetched"
 * from react-reconciler), and runtime `onResolve` — which could scope by
 * importer — does not fire in Bun. So instead, each extension directory gets a
 * `build.onLoad` hook that transpiles the extension file itself and rewrites
 * host-owned import specifiers to prefixed virtual modules (`hunk-host:react`)
 * that cannot collide with real resolution. Transpiling here is load-bearing:
 * JSX lowering emits automatic-runtime imports (`react/jsx-runtime`, or
 * `@opentui/react/jsx-runtime` under a pragma), and they only pass through the
 * rewrite if they exist before Bun's own loader would have added them.
 *
 * Modules linked into the compiled binary never re-resolve their imports, so
 * none of this affects the host bundle in any run mode.
 */

/**
 * Everything an extension may import that must be the host's own instance,
 * resolved lazily the first time an extension actually imports it.
 *
 * Laziness is a headless-portability requirement, not a nicety: this module is
 * reachable from the extension loader, which short-lived headless commands
 * (`hunk session list`, the daemon) also touch, and evaluating `@opentui/core`
 * in a compiled binary extracts its native library to disk. Static imports
 * here made every headless invocation pay that extraction; a dynamic import
 * inside the module factory runs only when an extension file imports the
 * specifier, which only happens in sessions that render. Dynamic `import()`
 * rather than `require()` because `@opentui/core` publishes only an `import`
 * exports condition, which a compile-time `require` cannot resolve.
 */
const HOST_MODULE_LOADERS: Record<string, () => Promise<object>> = {
  react: () => import("react"),
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  "react/jsx-dev-runtime": () => import("react/jsx-dev-runtime"),
  "@opentui/react": () => import("@opentui/react"),
  "@opentui/react/jsx-runtime": () => import("@opentui/react/jsx-runtime"),
  "@opentui/react/jsx-dev-runtime": () => import("@opentui/react/jsx-dev-runtime"),
  "@opentui/core": () => import("@opentui/core"),
  "hunkdiff/extension": () => import("../extension-api"),
};

/** Namespace for the virtual modules, chosen to never collide with a real package. */
const HOST_MODULE_PREFIX = "hunk-host:";

/**
 * Match one host-owned specifier in import position in transpiled output.
 *
 * `from "x"` covers static imports and re-exports; `import("x")` and
 * `require("x")` cover the dynamic forms. Matching quoted specifiers only in
 * these positions keeps a *data* string like `"react"` (say, a language id)
 * untouched.
 */
const HOST_SPECIFIER_PATTERN = new RegExp(
  `((?:\\bfrom|\\bimport|\\brequire)\\s*\\(?\\s*)(["'])(${Object.keys(HOST_MODULE_LOADERS)
    .map((specifier) => specifier.replace(/[/@]/g, "\\$&"))
    .join("|")})\\2`,
  "g",
);

/** Redirect host-owned imports in transpiled source to the virtual modules. */
export function rewriteHostSpecifiers(code: string) {
  return code.replace(
    HOST_SPECIFIER_PATTERN,
    (_all, lead: string, quote: string, specifier: string) =>
      `${lead}${quote}${HOST_MODULE_PREFIX}${specifier}${quote}`,
  );
}

type TranspilerLoader = "js" | "jsx" | "ts" | "tsx";

/** Pick the transpiler loader for one extension file path. */
function resolveLoader(path: string): TranspilerLoader {
  if (/\.tsx$/i.test(path)) {
    return "tsx";
  }
  if (/\.[mc]?ts$/i.test(path)) {
    return "ts";
  }
  // Bun itself allows JSX in plain `.js`, so stay equally permissive.
  return "jsx";
}

const transpilers = new Map<TranspilerLoader, Bun.Transpiler>();

/** One transpiler per loader, configured for the plain React automatic runtime. */
function transpilerFor(loader: TranspilerLoader) {
  let transpiler = transpilers.get(loader);
  if (!transpiler) {
    transpiler = new Bun.Transpiler({
      loader,
      // Without this the transpiler lowers JSX to helper calls but leaves the
      // runtime import for Bun's own loader to inject — which happens after
      // the rewrite and would resolve bare from the extension's directory.
      autoImportJSX: true,
      // Pin the JSX transform so an extension transpiles the same wherever it
      // lives; a per-file `@jsxImportSource` pragma still wins, and both
      // outcomes are in the rewrite map.
      tsconfig: JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
      }),
    });
    transpilers.set(loader, transpiler);
  }

  return transpiler;
}

/** Registered once per process; Bun keeps plugin registrations global. */
let virtualModulesRegistered = false;

/** Directories whose files already load through the rewrite hook. */
const registeredSourceRoots = new Set<string>();

/** Report whether the Bun runtime plugin API is available. */
function canRegisterPlugins() {
  return typeof Bun !== "undefined" && typeof Bun.plugin === "function";
}

/** Wrap one live module namespace in the shape `Bun.plugin`'s object loader expects. */
function toObjectModule(namespace: object): { exports: never; loader: "object" } {
  const withDefault = namespace as { default?: unknown };
  return {
    // Spread copies the named exports; `default` is normalized so both
    // `import React from "react"` and namespace access see the same value.
    exports: { ...namespace, default: withDefault.default ?? namespace } as never,
    loader: "object",
  };
}

/** Register the prefixed virtual modules the rewritten specifiers resolve to. */
function registerVirtualModules() {
  if (virtualModulesRegistered) {
    return;
  }

  virtualModulesRegistered = true;
  Bun.plugin({
    name: "hunk-host-runtime-modules",
    setup(build) {
      for (const [specifier, load] of Object.entries(HOST_MODULE_LOADERS)) {
        build.module(`${HOST_MODULE_PREFIX}${specifier}`, async () => toObjectModule(await load()));
      }
    },
  });
}

/** Register the transpile-and-rewrite hook for one extension directory. */
function registerSourceRoot(directory: string) {
  // Bun canonicalizes onLoad paths through symlinks on macOS and Linux, but can
  // preserve Windows short names. Cover both spellings so every platform reaches
  // the same host-module rewrite without treating aliases as separate extensions.
  const sourceRoots = new Set([directory, resolveCanonicalPath(directory)]);
  for (const sourceRoot of sourceRoots) {
    if (registeredSourceRoots.has(sourceRoot)) {
      continue;
    }

    registeredSourceRoots.add(sourceRoot);
    // Everything under the directory, so a folder extension's helper modules get
    // the same rewrite as its entry file. `[/\\]` keeps the boundary correct on
    // Windows, where `args.path` carries native separators.
    const escapedDirectory = sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const filter = new RegExp(`^${escapedDirectory}[/\\\\].*\\.(?:[mc]?[jt]s|[jt]sx)$`);

    Bun.plugin({
      name: `hunk-host-extension-source:${sourceRoot}`,
      setup(build) {
        build.onLoad({ filter }, async (args) => {
          const source = await Bun.file(args.path).text();
          const transpiled = transpilerFor(resolveLoader(args.path)).transformSync(source);
          return { contents: rewriteHostSpecifiers(transpiled), loader: "js" };
        });
      },
    });
  }
}

/**
 * Serve Hunk's own React (and public API) to the extension files about to load.
 *
 * Called with the entry paths of one load pass before any of them is imported;
 * idempotent per directory, and a no-op outside Bun so non-Bun tooling that
 * reaches extension loading keeps today's behavior, where bare specifiers
 * resolve from the filesystem.
 */
export function registerHostRuntimeModules(entryPaths: readonly string[]) {
  if (entryPaths.length === 0 || !canRegisterPlugins()) {
    return;
  }

  registerVirtualModules();
  for (const path of entryPaths) {
    registerSourceRoot(dirname(path));
  }
}
