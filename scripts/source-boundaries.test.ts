import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const CORE_ROOT = join(SRC_ROOT, "core");
const EXTENSIONS_ROOT = join(SRC_ROOT, "extensions");
const BUNDLED_PROVIDER_ROOT = join(EXTENSIONS_ROOT, "default", "vcs");

/** Return every production TypeScript source file below one directory. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Read static and dynamic module specifiers from one source file. */
function importSpecifiers(path: string) {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/(?:from\s*|import\s*\()["']([^"']+)["']/g)].map((match) => match[1]!);
}

/** Resolve one relative source import sufficiently for architectural containment checks. */
function resolveImport(path: string, specifier: string) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const base = resolve(dirname(path), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return base;
}

/** Find imports from one tree that resolve beneath a forbidden tree. */
function forbiddenImports(sourceRoot: string, forbiddenRoot: string) {
  return sourceFiles(sourceRoot).flatMap((path) =>
    importSpecifiers(path).flatMap((specifier) => {
      const target = resolveImport(path, specifier);
      if (!target) {
        return [];
      }
      const offset = relative(forbiddenRoot, target);
      const isForbidden =
        offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
      return isForbidden ? [`${relative(REPO_ROOT, path)} -> ${specifier}`] : [];
    }),
  );
}

/** Find bundled provider imports that bypass the published extension barrel. */
function privateProviderApiImports() {
  return ["git", "jujutsu", "sapling"].flatMap((provider) =>
    sourceFiles(join(BUNDLED_PROVIDER_ROOT, provider)).flatMap((path) =>
      importSpecifiers(path).some((specifier) => specifier.includes("extension-api"))
        ? [relative(REPO_ROOT, path)]
        : [],
    ),
  );
}

describe("source architecture boundaries", () => {
  test("keeps UI rendering out of core", () => {
    expect(forbiddenImports(CORE_ROOT, join(SRC_ROOT, "ui"))).toEqual([]);
  });

  test("keeps extension composition out of core", () => {
    expect(forbiddenImports(CORE_ROOT, EXTENSIONS_ROOT)).toEqual([]);
  });

  test("keeps bundled provider implementations out of core", () => {
    for (const file of ["git.ts", "gitSource.ts", "jujutsu.ts", "sapling.ts"]) {
      expect(existsSync(join(CORE_ROOT, "vcs", file))).toBe(false);
    }
  });

  test("keeps bundled providers on their public host contract", () => {
    expect(forbiddenImports(BUNDLED_PROVIDER_ROOT, CORE_ROOT)).toEqual([]);
    expect(privateProviderApiImports()).toEqual([]);
  });
});
