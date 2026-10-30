import * as fileSystem from "node:fs";
import { isBuiltin } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { create } from "enhanced-resolve";
import type { ModuleSpecifierKind } from "./moduleSpecifiers";

/** Resolve on-disk packages with Bun/Node conditions, independently of Bun's compiled filesystem. */
function createPackageResolver(kind: "import" | "require") {
  return create.sync({
    fileSystem,
    conditionNames: ["bun", "node", kind],
    extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json", ".node"],
    mainFields: kind === "import" ? ["module", "main"] : ["main"],
    // Read through Node's filesystem rather than the compiled module registry.
    // Do not cache misses: users may install dependencies between extension reloads.
    useSyncFileSystemCalls: true,
    unsafeCache: false,
  });
}

const resolvers = {
  import: createPackageResolver("import"),
  require: createPackageResolver("require"),
};

/** Recognize explicitly ESM dependency files, including modules with only dynamic imports. */
export function isESModuleDependency(path: string) {
  if (/\.m[jt]s$/i.test(path)) return true;
  if (/\.c[jt]s$/i.test(path)) return false;

  let directory = dirname(path);
  while (basename(directory) !== "node_modules") {
    const manifest = join(directory, "package.json");
    if (fileSystem.existsSync(manifest)) {
      return JSON.parse(fileSystem.readFileSync(manifest, "utf8")).type === "module";
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return false;
}

/** Locate a relative dependency so its own module references can receive the same rewrite. */
export function resolveRelativeModulePath(
  specifier: string,
  importerPath: string,
  kind: ModuleSpecifierKind,
) {
  if (!specifier.startsWith(".")) return undefined;

  return (
    resolvers[kind === "require" ? "require" : "import"](dirname(importerPath), specifier) ||
    undefined
  );
}

/** Resolve a package reference without changing relative paths, builtins, or host virtual modules. */
export function resolveInstalledPackageSpecifier(
  specifier: string,
  importerPath: string,
  kind: ModuleSpecifierKind,
) {
  if (
    specifier.startsWith(".") ||
    isAbsolute(specifier) ||
    isBuiltin(specifier) ||
    /^[a-z][a-z\d+.-]*:/i.test(specifier)
  ) {
    return undefined;
  }

  // Do not fall back to Bun on failure: its compiled loader can bypass null exports.
  const resolved = resolvers[kind === "require" ? "require" : "import"](
    dirname(importerPath),
    specifier,
  );
  if (!resolved) throw new Error(`Cannot resolve package '${specifier}' from '${importerPath}'`);
  return kind === "require" ? resolved : pathToFileURL(resolved).href;
}
