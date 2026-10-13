import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveFilesystemModulePath } from "./installedPackageResolution";

export interface SnapshotAliasConfig {
  baseUrl?: string;
  paths?: Record<string, string[]>;
  pathsRoot: string;
}

export type SnapshotConfigReader = (path: string) => string;

/** Capture extended configs before resolution, interpreting only inert JSON5 data. */
export function readSnapshotAliasConfig(
  path: string,
  read: SnapshotConfigReader,
  stack: string[] = [],
): SnapshotAliasConfig {
  const absolute = resolve(path);
  if (stack.includes(absolute) || stack.length >= 64)
    throw new Error("Circular or excessively deep snapshot tsconfig extends chain.");
  const data = Bun.JSON5.parse(read(absolute)) as {
    extends?: unknown;
    compilerOptions?: { baseUrl?: unknown; paths?: unknown };
  };
  let result: SnapshotAliasConfig = { pathsRoot: dirname(absolute) };
  const parents =
    typeof data.extends === "string"
      ? [data.extends]
      : Array.isArray(data.extends)
        ? data.extends
        : [];
  for (const parent of parents) {
    if (typeof parent !== "string")
      throw new Error("Snapshot tsconfig extends must contain literal paths.");
    const inherited = readSnapshotAliasConfig(resolveExtendedConfig(parent, absolute, read), read, [
      ...stack,
      absolute,
    ]);
    if (inherited.baseUrl !== undefined) result.baseUrl = inherited.baseUrl;
    if (inherited.paths !== undefined) {
      result.paths = inherited.paths;
      result.pathsRoot = inherited.pathsRoot;
    }
  }
  const options = data.compilerOptions;
  if (typeof options?.baseUrl === "string")
    result.baseUrl = resolve(dirname(absolute), options.baseUrl);
  if (options?.paths !== undefined) {
    if (!options.paths || typeof options.paths !== "object" || Array.isArray(options.paths))
      throw new Error("Invalid snapshot tsconfig paths.");
    result.paths = {};
    for (const [key, targets] of Object.entries(options.paths)) {
      if (!Array.isArray(targets) || targets.some((target) => typeof target !== "string"))
        throw new Error("Snapshot tsconfig paths must contain literal targets.");
      Object.defineProperty(result.paths, key, { value: targets, enumerable: true });
    }
    result.pathsRoot = dirname(absolute);
  }
  return result;
}

/** Resolve extended package configs using fresh filesystem metadata, never Bun's resolver cache. */
function resolveExtendedConfig(specifier: string, importer: string, read: SnapshotConfigReader) {
  if (isAbsolute(specifier) || specifier.startsWith(".")) {
    const path = resolve(dirname(importer), specifier);
    return existsSync(path) ? path : `${path}.json`;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(specifier))
    throw new Error("Unsupported snapshot tsconfig extends protocol.");
  const segments = specifier.split("/");
  const length = specifier.startsWith("@") ? 2 : 1;
  const name = segments.slice(0, length).join("/");
  let directory = dirname(importer);
  for (;;) {
    const root = join(directory, "node_modules", name);
    const manifest = join(root, "package.json");
    if (existsSync(manifest)) {
      const metadata = JSON.parse(read(manifest)) as { tsconfig?: string; exports?: unknown };
      if (segments.length === length && metadata.exports === undefined) {
        return join(root, metadata.tsconfig ?? "tsconfig.json");
      }
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const path = resolveFilesystemModulePath(specifier, importer, "import", read);
  if (!path) throw new Error(`Cannot resolve snapshot tsconfig extends: ${specifier}`);
  return path;
}

/** Resolve aliases from currently captured configs, without process-wide cached lookups. */
export function snapshotAliasTargets(
  specifier: string,
  importer: string,
  read: SnapshotConfigReader,
) {
  let directory = dirname(importer);
  for (;;) {
    const config = ["tsconfig.json", "jsconfig.json"]
      .map((name) => join(directory, name))
      .find((path) => existsSync(path));
    if (config) {
      const parsed = readSnapshotAliasConfig(config, read);
      const matches = Object.keys(parsed.paths ?? {})
        .map((key) => {
          const star = key.indexOf("*");
          const matched =
            star < 0
              ? key === specifier
              : specifier.startsWith(key.slice(0, star)) &&
                specifier.endsWith(key.slice(star + 1)) &&
                specifier.length >= key.length - 1;
          return { key, star, matched };
        })
        .filter((match) => match.matched)
        .sort((a, b) =>
          a.star < 0 ? -1 : b.star < 0 ? 1 : b.star - a.star || b.key.length - a.key.length,
        );
      const match = matches[0];
      if (match) {
        const value =
          match.star < 0
            ? ""
            : specifier.slice(match.star, specifier.length - (match.key.length - match.star - 1));
        return parsed.paths![match.key]!.map((target) =>
          resolve(parsed.baseUrl ?? parsed.pathsRoot, target.replace("*", value)),
        );
      }
      return parsed.baseUrl ? [resolve(parsed.baseUrl, specifier)] : [];
    }
    const parent = dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
}
