import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestExtensionPackages } from "../../../../test/helpers/extensionPackageTestFixtures";
import {
  isESModuleDependency,
  resolveInstalledPackageSpecifier,
  resolveRelativeModulePath,
} from "./installedPackageResolution";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Create a package-resolution fixture independent of the project's own node_modules. */
function createTestPackageResolution() {
  const root = mkdtempSync(join(tmpdir(), "hunk-package-resolution-"));
  roots.push(root);
  return { entry: join(root, "entry.ts"), packageDirectory: createTestExtensionPackages(root) };
}

test("selects import versus require conditions, including CommonJS targets", () => {
  const { entry, packageDirectory } = createTestPackageResolution();

  expect(resolveInstalledPackageSpecifier("fixture-pkg", entry, "import")).toBe(
    pathToFileURL(join(packageDirectory, "esm.js")).href,
  );
  expect(resolveInstalledPackageSpecifier("fixture-pkg", entry, "dynamic-import")).toBe(
    pathToFileURL(join(packageDirectory, "esm.js")).href,
  );
  expect(resolveInstalledPackageSpecifier("fixture-pkg", entry, "require")).toBe(
    join(packageDirectory, "required.json"),
  );
  expect(resolveInstalledPackageSpecifier("fixture-pkg/commonjs", entry, "require")).toBe(
    join(packageDirectory, "cjs.cjs"),
  );
  expect(() => resolveInstalledPackageSpecifier("fixture-pkg/commonjs", entry, "import")).toThrow();
});

test("honors null exports and import-only subpaths instead of exposing physical files", () => {
  const { entry } = createTestPackageResolution();

  expect(() => resolveInstalledPackageSpecifier("fixture-pkg/blocked", entry, "import")).toThrow();
  expect(() => resolveInstalledPackageSpecifier("fixture-pkg/feature", entry, "require")).toThrow();
});

test("preserves relative paths, absolute paths, URL schemes, and runtime builtins", () => {
  const { entry } = createTestPackageResolution();

  for (const specifier of [
    "./helper",
    entry,
    "node:fs",
    "fs/promises",
    "bun:ffi",
    "hunk-host:react",
    "file:///file.js",
    "https://example.com/module.js",
  ]) {
    expect(resolveInstalledPackageSpecifier(specifier, entry, "import")).toBeUndefined();
  }
});

test("recognizes explicit ESM formats and respects CommonJS and package-scope boundaries", () => {
  const { packageDirectory } = createTestPackageResolution();

  expect(isESModuleDependency(join(packageDirectory, "esm.js"))).toBe(true);
  expect(isESModuleDependency(join(packageDirectory, "cjs.cjs"))).toBe(false);
  expect(isESModuleDependency(join(packageDirectory, "any.mjs"))).toBe(true);
  expect(isESModuleDependency(join(packageDirectory, "..", "no-manifest", "file.js"))).toBe(false);
});

test("locates relative dependency files without rewriting relative specifiers", () => {
  const { packageDirectory } = createTestPackageResolution();
  const importer = join(packageDirectory, "esm.js");

  expect(resolveRelativeModulePath("./feature.js", importer, "import")).toBe(
    join(packageDirectory, "feature.js"),
  );
  expect(resolveInstalledPackageSpecifier("./feature.js", importer, "import")).toBeUndefined();
  expect(resolveRelativeModulePath("fixture-pkg", importer, "import")).toBeUndefined();
});

test("does not retain resolution misses across installs", () => {
  const { entry, packageDirectory } = createTestPackageResolution();
  const missingPath = join(packageDirectory, "features", "installed.js");

  expect(() =>
    resolveInstalledPackageSpecifier("fixture-pkg/features/installed", entry, "import"),
  ).toThrow();
  writeFileSync(missingPath, `export default "installed";\n`);

  expect(resolveInstalledPackageSpecifier("fixture-pkg/features/installed", entry, "import")).toBe(
    pathToFileURL(missingPath).href,
  );
});
