import { describe, expect, test } from "bun:test";
import { Transpiler } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Guards the startup cost of commands that never build a changeset.
 *
 * `hunk --version`, `--help`, `daemon serve`, the markup commands, and `hunk session *` answer
 * without a diff engine, renderer, or VCS backend. Those subsystems are reached through dynamic
 * `import()` from the interactive plan, so only eager `import` statements can pull them into the
 * entrypoint graph. Walking the static graph catches the regression a timing assertion would
 * measure inconsistently across machines.
 */

const REPO_ROOT = resolve(import.meta.dir, "../..");
const ENTRYPOINT = join(REPO_ROOT, "packages/hunk/src/main.tsx");

/**
 * Package prefixes the entrypoint must not load before a command selects an interactive plan.
 *
 * These are the heavy graphs named in the startup-deferral contract: the Pierre diff engine and
 * its renderer, and OpenTUI's embedded native library.
 */
const DEFERRED_PACKAGE_PREFIXES = ["@pierre/", "@opentui/"];

const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/** Resolve one relative specifier to a source file the walker can read. */
function resolveLocalModule(fromFile: string, specifier: string) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    ...MODULE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];

  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

/** Strip the entrypoint shebang so the transpiler can scan it as a module. */
function readModuleSource(file: string) {
  const source = readFileSync(file, "utf8");
  return source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1) : source;
}

/**
 * Walk every eagerly imported module reachable from the entrypoint.
 *
 * `scanImports` reports the imports that survive transpilation, so type-only imports are already
 * excluded, and `dynamic-import` entries are skipped because those are exactly the deferral
 * mechanism under test. Returns each external package with the chain that first reached it.
 */
function traceEagerExternals(entrypoint: string) {
  const transpiler = new Transpiler({ loader: "tsx" });
  const visited = new Set<string>();
  const externals = new Map<string, string[]>();

  const walk = (file: string, chain: string[]) => {
    if (visited.has(file) || file.endsWith(".json")) {
      return;
    }
    visited.add(file);

    for (const imported of transpiler.scanImports(readModuleSource(file))) {
      if (imported.kind !== "import-statement") {
        continue;
      }

      if (imported.path.startsWith(".")) {
        const next = resolveLocalModule(file, imported.path);
        if (next) {
          walk(next, [...chain, relative(REPO_ROOT, next)]);
        }
        continue;
      }

      if (!externals.has(imported.path)) {
        externals.set(imported.path, [...chain, imported.path]);
      }
    }
  };

  walk(entrypoint, [relative(REPO_ROOT, entrypoint)]);
  return externals;
}

describe("CLI startup graph", () => {
  test("entrypoint does not eagerly import the diff engine or renderer", () => {
    const externals = traceEagerExternals(ENTRYPOINT);
    const eagerlyDeferred = [...externals.entries()]
      .filter(([packageName]) =>
        DEFERRED_PACKAGE_PREFIXES.some((prefix) => packageName.startsWith(prefix)),
      )
      .map(([packageName, chain]) => `${packageName} via ${chain.join(" -> ")}`);

    expect(eagerlyDeferred).toEqual([]);
  });

  test("worker disposal stays with the interactive app rather than the entrypoint", () => {
    // The entrypoint resolves once the app is mounted, so disposing from there would terminate the
    // worker before the first large diff requested it.
    const interactiveAppSource = readFileSync(
      join(REPO_ROOT, "packages/hunk/src/ui/runInteractiveApp.tsx"),
      "utf8",
    );

    expect(readModuleSource(ENTRYPOINT).includes("disposeHighlightWorker")).toBe(false);
    expect(interactiveAppSource.includes("disposeHighlightWorker()")).toBe(true);
  });
});
