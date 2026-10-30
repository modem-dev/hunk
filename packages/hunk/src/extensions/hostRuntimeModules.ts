import { readFileSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCanonicalPath } from "../core/run/paths";
import {
  isESModuleDependency,
  resolveInstalledPackageSpecifier,
  resolveRelativeModulePath,
} from "./installedPackageResolution";
import { resolveManagedNpmModuleRoot } from "./manage/workspace";
import { rewriteModuleSpecifiers, type ModuleSpecifierKind } from "./moduleSpecifiers";

/**
 * Serve host-owned modules and installed packages to dynamically imported extension files.
 *
 * User extensions must share Hunk's React dispatcher and public API, even when
 * adjacent node_modules contain competing copies. Each extension directory gets
 * an onLoad hook that transpiles JSX before redirecting host imports to prefixed
 * virtual modules. Runtime onResolve does not fire in Bun, and claiming bare
 * specifiers globally interferes with the host's own lazy imports.
 *
 * Recorded npm entries extend this scope to their isolated dependency workspace:
 * hoisted helpers must also receive the host APIs and React instance. Neighboring
 * installs and unrecorded directories keep their own filesystem resolution.
 *
 * Compiled Bun executables also fail to resolve extension-local bare packages.
 * Resolve those references from the importing file's real filesystem directory,
 * preserving import/require export conditions. Modules linked into the host
 * bundle never pass through these hooks.
 */

/**
 * Load host modules only when an extension imports them.
 * Headless commands must not evaluate OpenTUI or extract its native library.
 * Dynamic imports also preserve import-only exports such as @opentui/core.
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

/** Namespace for virtual modules, chosen to never collide with a real package. */
const HOST_MODULE_PREFIX = "hunk-host:";
const HOST_SPECIFIERS = Object.keys(HOST_MODULE_LOADERS)
  .map((specifier) => specifier.replace(/[/@]/g, "\\$&"))
  .join("|");

/** Resolve host-owned specifiers before considering any installed package. */
function hostSpecifier(specifier: string) {
  return Object.hasOwn(HOST_MODULE_LOADERS, specifier)
    ? `${HOST_MODULE_PREFIX}${specifier}`
    : undefined;
}

/** Redirect literal host imports without altering strings, comments, or member calls. */
export function rewriteHostSpecifiers(code: string) {
  return rewriteModuleSpecifiers(code, hostSpecifier);
}

/** Resolve literal package references using the importing file and each reference's conditions. */
export function rewriteInstalledPackageSpecifiers(code: string, importerPath: string) {
  return rewriteModuleSpecifiers(code, (specifier, kind) =>
    resolveInstalledPackageSpecifier(specifier, importerPath, kind),
  );
}

type TranspilerLoader = "js" | "jsx" | "ts" | "tsx";

/** Pick the transpiler loader for one extension file path. */
function resolveLoader(path: string): TranspilerLoader {
  if (/\.tsx$/i.test(path)) return "tsx";
  if (/\.[mc]?ts$/i.test(path)) return "ts";
  // Bun itself allows JSX in plain .js files.
  return "jsx";
}

const transpilers = new Map<TranspilerLoader, Bun.Transpiler>();

/** Cache transpilers that emit JSX runtime imports before the host rewrite. */
function transpilerFor(loader: TranspilerLoader) {
  let transpiler = transpilers.get(loader);
  if (!transpiler) {
    transpiler = new Bun.Transpiler({
      loader,
      autoImportJSX: true,
      // A file-local @jsxImportSource pragma still overrides this default.
      tsconfig: JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
      }),
    });
    transpilers.set(loader, transpiler);
  }

  return transpiler;
}

let virtualModulesRegistered = false;
const registeredSourceRoots = new Set<string>();
const registeredDependencyFiles = new Set<string>();

/** Report whether the Bun runtime plugin API is available. */
function canRegisterPlugins() {
  return typeof Bun !== "undefined" && typeof Bun.plugin === "function";
}

/** Wrap one live namespace in the shape Bun.plugin's object loader expects. */
function toObjectModule(namespace: object): { exports: never; loader: "object" } {
  const withDefault = namespace as { default?: unknown };
  return {
    exports: { ...namespace, default: withDefault.default ?? namespace } as never,
    loader: "object",
  };
}

/** Register prefixed virtual modules without claiming bare specifiers globally. */
function registerVirtualModules() {
  if (virtualModulesRegistered) return;

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

/** Lower CommonJS host requires to static imports so lazy virtual factories finish before evaluation. */
function rewriteCompiledHostRequires(code: string) {
  const bindings = new Map<string, string>();
  let bindingIndex = 0;
  const pattern = new RegExp(
    `\\b(?:__require\\d*|require)\\s*\\(\\s*(["'])(${HOST_SPECIFIERS})\\1\\s*\\)`,
    "g",
  );
  const rewritten = code.replace(pattern, (_call, _quote: string, specifier: string) => {
    let binding = bindings.get(specifier);
    if (!binding) {
      do {
        binding = `__hunkHostRequire${bindingIndex++}`;
      } while (new RegExp(`\\b${binding}\\b`).test(code));
      bindings.set(specifier, binding);
    }

    return binding;
  });
  const imports = [...bindings].map(
    ([specifier, binding]) =>
      `import * as ${binding} from ${JSON.stringify(`${HOST_MODULE_PREFIX}${specifier}`)};`,
  );
  return `${imports.join("\n")}\n${rewritten}`;
}

/** Convert rewritten CommonJS helpers to ESM without bundling their dependency graph.
 * Runtime onLoad source results do not preserve CommonJS exports. Let Bun perform
 * the interop conversion before redirecting host specifiers, including require calls
 * that become static imports. External imports retain the original module's location.
 */
async function compileCommonJsHostImports(path: string, contents: string) {
  const packageRewritten = rewriteModuleSpecifiers(contents, (specifier, kind) =>
    hostSpecifier(specifier) ? undefined : extensionSpecifier(specifier, path, kind),
  );
  const result = await Bun.build({
    entrypoints: [path],
    target: "bun",
    format: "esm",
    external: ["*"],
    plugins: [
      {
        name: "hunk-commonjs-host-source",
        setup(build) {
          build.onLoad({ filter: /.*/ }, () => ({ contents: packageRewritten, loader: "js" }));
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, `Could not load ${path}`);

  const code = await result.outputs[0]!.text();
  return {
    contents: rewriteModuleSpecifiers(rewriteCompiledHostRequires(code), (specifier, kind) =>
      extensionSpecifier(specifier, path, kind),
    ),
    loader: "js" as const,
  };
}

const deferredFailures = new Map<string, string>();

/** Raise a resolution failure only when the rewritten import or require actually executes. */
function deferredFailureSpecifier(error: unknown) {
  const key = String(error);
  const existing = deferredFailures.get(key);
  if (existing) return existing;

  const specifier = `hunk-host-failure:${deferredFailures.size}`;
  deferredFailures.set(key, specifier);
  Bun.plugin({
    name: specifier,
    setup(build) {
      build.module(specifier, () => {
        throw error;
      });
    },
  });
  return specifier;
}

/** Register resolved dependency files and keep optional resolution errors catchable. */
function extensionSpecifier(specifier: string, importerPath: string, kind: ModuleSpecifierKind) {
  const host = hostSpecifier(specifier);
  if (host) return host;

  try {
    const resolved = resolveInstalledPackageSpecifier(specifier, importerPath, kind);
    const relativePath = resolveRelativeModulePath(specifier, importerPath, kind);
    if (resolved) {
      registerDependencyFile(kind === "require" ? resolved : fileURLToPath(resolved));
    } else if (relativePath) {
      registerDependencyFile(relativePath);
    }
    return resolved;
  } catch (error) {
    if (kind === "import") throw error;
    // A virtual failure preserves strict exports without handing the original bare name to Bun.
    return deferredFailureSpecifier(error);
  }
}

/** Transpile one intercepted file and redirect its module references. */
function rewriteSource(path: string, source: string) {
  const transpiler = transpilerFor(resolveLoader(path));
  const transpiled = transpiler.transformSync(source);
  const scan = transpiler.scan(transpiled);
  if (
    scan.exports.length === 0 &&
    !scan.imports.some((entry) => entry.kind === "import-statement") &&
    /\b(?:module\s*\.\s*exports|exports\s*(?:\.|\[))/.test(transpiled)
  ) {
    return compileCommonJsHostImports(path, transpiled);
  }

  return {
    contents: rewriteModuleSpecifiers(transpiled, (specifier, kind) =>
      extensionSpecifier(specifier, path, kind),
    ),
    loader: "js" as const,
  };
}

/** Track reachable ESM files outside extension roots without claiming unrelated or CommonJS files. */
function registerDependencyFile(path: string) {
  if (!/\.(?:[mc]?[jt]s|[jt]sx)$/i.test(path)) return;
  const canonicalPath = resolveCanonicalPath(path);
  if (registeredDependencyFiles.has(canonicalPath)) return;
  for (const root of registeredSourceRoots) {
    if (canonicalPath.startsWith(`${root}${sep}`)) return;
  }

  const transpiler = transpilerFor(resolveLoader(path));
  const scanned = transpiler.scan(transpiler.transformSync(readFileSync(path, "utf8")));
  // Runtime JS hooks erase Bun's native CommonJS format detection. Leave those files native.
  if (
    !scanned.exports.length &&
    !scanned.imports.some((item) => item.kind === "import-statement") &&
    !isESModuleDependency(path)
  )
    return;

  registeredDependencyFiles.add(canonicalPath);
  const escapedPaths = [...new Set([path, canonicalPath])]
    .map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  Bun.plugin({
    name: `hunk-host-extension-dependency:${canonicalPath}`,
    setup(build) {
      build.onLoad({ filter: new RegExp(`^(?:${escapedPaths})$`) }, async (args) =>
        rewriteSource(args.path, await Bun.file(args.path).text()),
      );
    },
  });
}

/** Register transpilation and syntax-aware rewriting for an extension and its local dependencies. */
function registerSourceRoot(directory: string) {
  // Bun canonicalizes symlinks on Unix but can preserve Windows short names.
  const sourceRoots = new Set([directory, resolveCanonicalPath(directory)]);
  for (const sourceRoot of sourceRoots) {
    if (registeredSourceRoots.has(sourceRoot)) continue;

    registeredSourceRoots.add(sourceRoot);
    const escapedDirectory = sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const filter = new RegExp(`^${escapedDirectory}[/\\\\].*\\.(?:[mc]?[jt]s|[jt]sx)$`);

    Bun.plugin({
      name: `hunk-host-extension-source:${sourceRoot}`,
      setup(build) {
        build.onLoad({ filter }, (args) => {
          return rewriteSource(args.path, readFileSync(args.path, "utf8"));
        });
      },
    });
  }
}

/**
 * Register host runtime modules before importing one pass of extension entries.
 * Registration is idempotent per directory and a no-op outside Bun.
 */
export function registerHostRuntimeModules(entryPaths: readonly string[]) {
  if (entryPaths.length === 0 || !canRegisterPlugins()) return;

  registerVirtualModules();
  for (const path of entryPaths) {
    registerSourceRoot(resolveManagedNpmModuleRoot(path) ?? dirname(path));
  }
}
