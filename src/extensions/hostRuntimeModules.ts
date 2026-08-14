import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseJavaScript } from "acorn";
import { parse as parseModuleSpecifiers } from "es-module-lexer/js";
import { moduleResolve } from "import-meta-resolve";

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
 * The same pass resolves extension-owned imports against adjacent
 * `node_modules` and rewrites them to filesystem URLs. Bun's compiled runtime
 * cannot resolve packages installed after the executable was built, so Hunk
 * performs the package-exports lookup itself and enrolls resolved dependency
 * directories in the scoped loader path recursively.
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

/** Specifier schemes Bun already resolves without consulting extension node_modules. */
const RUNTIME_SPECIFIER_SCHEME = /^(?:bun|data|file|hunk-host|node):/;

interface ModuleSpecifierRange {
  start: number;
  end: number;
  specifier: string;
  requireCondition: boolean;
}

interface JavaScriptNode {
  type?: string;
  start?: number;
  end?: number;
  name?: string;
  value?: unknown;
  callee?: JavaScriptNode;
  arguments?: JavaScriptNode[];
  [key: string]: unknown;
}

/** Collect literal CommonJS require calls from a real JavaScript syntax tree. */
function collectRequireSpecifiers(code: string): ModuleSpecifierRange[] {
  let root: JavaScriptNode;
  try {
    root = parseJavaScript(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as JavaScriptNode;
  } catch {
    // ESM imports still resolve through es-module-lexer; preserve unsupported syntax unchanged.
    return [];
  }

  const ranges: ModuleSpecifierRange[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }

    const node = value as JavaScriptNode;
    const argument = node.arguments?.[0];
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require" &&
      node.arguments?.length === 1 &&
      argument?.type === "Literal" &&
      typeof argument.value === "string" &&
      typeof argument.start === "number" &&
      typeof argument.end === "number"
    ) {
      ranges.push({
        start: argument.start + 1,
        end: argument.end - 1,
        specifier: argument.value,
        requireCondition: true,
      });
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== "start" && key !== "end") visit(child);
    }
  };
  visit(root);
  return ranges;
}

/** Collect syntax-aware static imports, dynamic imports, re-exports, and requires. */
function collectModuleSpecifiers(code: string): ModuleSpecifierRange[] {
  const esmRanges = parseModuleSpecifiers(code)[0].flatMap((specifier) =>
    specifier.n === undefined || specifier.d === -2
      ? []
      : [
          {
            start:
              code[specifier.s] === '"' || code[specifier.s] === "'"
                ? specifier.s + 1
                : specifier.s,
            end:
              code[specifier.e - 1] === '"' || code[specifier.e - 1] === "'"
                ? specifier.e - 1
                : specifier.e,
            specifier: specifier.n,
            requireCondition: false,
          },
        ],
  );
  return [...esmRanges, ...collectRequireSpecifiers(code)];
}

/** Escape one replacement for the quote surrounding its original module specifier. */
function escapeModuleSpecifier(code: string, range: ModuleSpecifierRange, value: string) {
  const escaped = JSON.stringify(value).slice(1, -1);
  return code[range.start - 1] === "'" ? escaped.replaceAll("'", "\\'") : escaped;
}

/** Apply non-overlapping module-specifier replacements without shifting earlier ranges. */
function replaceModuleSpecifiers(
  code: string,
  replacements: Array<{ range: ModuleSpecifierRange; value: string }>,
) {
  let rewritten = code;
  for (const { range, value } of replacements.sort((a, b) => b.range.start - a.range.start)) {
    rewritten =
      rewritten.slice(0, range.start) +
      escapeModuleSpecifier(code, range, value) +
      rewritten.slice(range.end);
  }
  return rewritten;
}

/** Redirect host-owned imports in transpiled source to the virtual modules. */
export function rewriteHostSpecifiers(code: string) {
  const replacements = collectModuleSpecifiers(code)
    .filter(({ specifier }) => specifier in HOST_MODULE_LOADERS)
    .map((range) => ({ range, value: `${HOST_MODULE_PREFIX}${range.specifier}` }));
  return replaceModuleSpecifiers(code, replacements);
}

/** Report whether one resolved dependency should pass through Hunk's ESM source hook. */
function shouldRegisterDependencySource(path: string) {
  if (/\.(?:mjs|mts|ts|tsx|jsx)$/i.test(path)) {
    return true;
  }
  if (!/\.js$/i.test(path)) {
    return false;
  }

  let directory = dirname(path);
  while (true) {
    const packageJsonPath = join(directory, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        return JSON.parse(readFileSync(packageJsonPath, "utf8")).type === "module";
      } catch {
        return false;
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return false;
    }
    directory = parent;
  }
}

type RuntimeModuleResolver = (specifier: string, directory: string) => string;

/** Resolve one extension import in both source and compiled Hunk runtimes. */
function resolveExtensionDependency(
  specifier: string,
  importerPath: string,
  requireCondition: boolean,
  runtimeResolve: RuntimeModuleResolver,
) {
  try {
    return runtimeResolve(specifier, dirname(importerPath));
  } catch {
    try {
      const conditions = new Set(["bun", "node", requireCondition ? "require" : "import"]);
      const resolved = moduleResolve(specifier, pathToFileURL(importerPath), conditions, false);
      return resolved.protocol === "file:" ? fileURLToPath(resolved) : resolved.href;
    } catch {
      return undefined;
    }
  }
}

/**
 * Resolve extension-owned imports to filesystem URLs before a compiled Hunk evaluates them.
 *
 * Bun's source runtime resolves a bare package from the importing extension, but a compiled
 * executable resolves only modules embedded at build time. Absolute URLs preserve ordinary
 * folder-extension dependency resolution in both modes. Registering each resolved module's
 * directory also gives its own imports the same treatment when Bun loads it later.
 */
export function rewriteExtensionDependencySpecifiers(
  code: string,
  importerPath: string,
  runtimeResolve: RuntimeModuleResolver = Bun.resolveSync,
) {
  const replacements: Array<{ range: ModuleSpecifierRange; value: string }> = [];

  for (const range of collectModuleSpecifiers(code)) {
    if (RUNTIME_SPECIFIER_SCHEME.test(range.specifier)) {
      continue;
    }

    const resolved = resolveExtensionDependency(
      range.specifier,
      importerPath,
      range.requireCondition,
      runtimeResolve,
    );
    if (!resolved) {
      // Preserve Bun's normal diagnostic for an unavailable package or local module.
      continue;
    }

    if (shouldRegisterDependencySource(resolved)) {
      registerSourceRoot(dirname(resolved));
    }

    replacements.push({
      range,
      value:
        range.requireCondition || RUNTIME_SPECIFIER_SCHEME.test(resolved)
          ? resolved
          : pathToFileURL(resolved).href,
    });
  }

  return replaceModuleSpecifiers(code, replacements);
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
  if (registeredSourceRoots.has(directory)) {
    return;
  }

  registeredSourceRoots.add(directory);
  // Everything under the directory, so a folder extension's helper modules get
  // the same rewrite as its entry file. `[/\\]` keeps the boundary correct on
  // Windows, where `args.path` carries native separators.
  const escapedDirectory = directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter = new RegExp(`^${escapedDirectory}[/\\\\].*\\.(?:[mc]?[jt]s|[jt]sx)$`);

  Bun.plugin({
    name: `hunk-host-extension-source:${directory}`,
    setup(build) {
      build.onLoad({ filter }, async (args) => {
        const source = await Bun.file(args.path).text();
        const transpiled = transpilerFor(resolveLoader(args.path)).transformSync(source);
        const hostRewritten = rewriteHostSpecifiers(transpiled);
        return {
          contents: rewriteExtensionDependencySpecifiers(hostRewritten, args.path),
          loader: "js",
        };
      });
    },
  });
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
