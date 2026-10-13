import * as fileSystem from "node:fs";
import { isBuiltin } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { create } from "enhanced-resolve";
import type { ModuleSpecifierKind } from "./moduleSpecifiers";

/** Resolve on-disk packages with Bun/Node conditions, independently of Bun's compiled filesystem. */
function createPackageResolver(
  kind: "import" | "require",
  readMetadata?: (path: string) => string,
) {
  const resolverFileSystem = readMetadata
    ? {
        ...fileSystem,
        readFileSync: ((path: unknown, options?: unknown) => {
          if (typeof path !== "string")
            throw new Error("Snapshot resolver expects filesystem metadata paths.");
          const contents = readMetadata(path);
          const encoding =
            typeof options === "string"
              ? options
              : (options as { encoding?: string } | undefined)?.encoding;
          return encoding ? contents : Buffer.from(contents, "utf8");
        }) as typeof fileSystem.readFileSync,
      }
    : fileSystem;
  return create.sync({
    fileSystem: resolverFileSystem,
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

/** Resolve a filesystem module with the caller's import/require export conditions. */
export function resolveFilesystemModulePath(
  specifier: string,
  importerPath: string,
  kind: ModuleSpecifierKind,
  readMetadata?: (path: string) => string,
) {
  const mode = kind === "require" ? "require" : "import";
  let captureFailure: unknown;
  const boundedRead = readMetadata
    ? (path: string) => {
        try {
          return readMetadata(path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Missing candidate manifests are ordinary lookups; failed capture of an existing
          // file is fatal even when enhanced-resolve would ignore its metadata read error.
          if (code !== "ENOENT" && code !== "ENOTDIR") captureFailure ??= error;
          throw error;
        }
      }
    : undefined;
  const resolver = boundedRead ? createPackageResolver(mode, boundedRead) : resolvers[mode];
  let result: string | false;
  try {
    result = resolver(dirname(importerPath), specifier);
  } catch (error) {
    throw captureFailure ?? error;
  }
  if (captureFailure) throw captureFailure;
  return result || undefined;
}

/** Locate a relative dependency so its own module references can receive the same rewrite. */
export function resolveRelativeModulePath(
  specifier: string,
  importerPath: string,
  kind: ModuleSpecifierKind,
) {
  if (!specifier.startsWith(".")) return undefined;

  return resolveFilesystemModulePath(specifier, importerPath, kind);
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
  const resolved = resolveFilesystemModulePath(specifier, importerPath, kind);
  if (!resolved) throw new Error(`Cannot resolve package '${specifier}' from '${importerPath}'`);
  return kind === "require" ? resolved : pathToFileURL(resolved).href;
}
