import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { isValidElement, useState } from "react";
import { HunkExtensionUserError } from "../extension-api";
import {
  registerHostRuntimeModules,
  rewriteInstalledPackageSpecifiers,
} from "./hostRuntimeModules";

/**
 * These tests import real files from a temp directory, the way extension
 * loading does. The temp directory has no `node_modules` route to the repo's
 * React, so a bare `react` specifier resolving at all proves the virtual
 * module served it — and function identity proves it is *this* React, the
 * property that keeps extension hooks on the host's dispatcher.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeTempExtension(name: string, contents: string) {
  const dir = mkdtempSync(join(tmpdir(), "hunk-host-modules-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

async function importTempExtension(path: string) {
  registerHostRuntimeModules([path]);
  return (await import(pathToFileURL(path).href)) as { default: Record<string, unknown> };
}

describe("registerHostRuntimeModules", () => {
  test("serves the host React instance to a file outside the app bundle", async () => {
    const path = writeTempExtension(
      "ext.ts",
      `import { useState } from "react";\nexport default { useState };\n`,
    );

    const mod = await importTempExtension(path);

    expect(mod.default.useState).toBe(useState);
  });

  test("wins over a conflicting react adjacent to the extension file", async () => {
    const path = writeTempExtension(
      "ext.ts",
      `import { useState } from "react";\nexport default { useState };\n`,
    );
    // A repo-local extension inside a JavaScript project sits next to that
    // project's own React; resolving it would split the hooks dispatcher.
    const fakeReactDir = join(path, "..", "node_modules", "react");
    mkdirSync(fakeReactDir, { recursive: true });
    writeFileSync(
      join(fakeReactDir, "package.json"),
      JSON.stringify({ name: "react", version: "0.0.1", main: "index.js" }),
    );
    writeFileSync(join(fakeReactDir, "index.js"), "module.exports = { useState() {} };\n");

    const mod = await importTempExtension(path);

    expect(mod.default.useState).toBe(useState);
  });

  test("transpiled JSX lands on the host jsx runtime", async () => {
    const path = writeTempExtension(
      "ext.tsx",
      `function View() {\n` +
        `  return <text content="from extension" />;\n` +
        `}\n` +
        `export default { makeElement: () => <View /> };\n`,
    );

    const mod = await importTempExtension(path);
    const makeElement = mod.default.makeElement as () => unknown;

    // Valid under the host's React means the automatic-runtime import the
    // transpiler emitted (`react/jsx-runtime` or the dev variant) was served.
    expect(isValidElement(makeElement())).toBe(true);
  });

  test("loads a hook-using OpenTUI file-row component through host runtime modules", async () => {
    const path = writeTempExtension(
      "file-view.tsx",
      `import { TextAttributes } from "@opentui/core";\n` +
        `import { useState } from "react";\n` +
        `const Row = ({ width, height, selected, rowIndex }) => {\n` +
        `  const [label] = useState("custom");\n` +
        `  return <box style={{ width, height }}><text attributes={TextAttributes.BOLD} content={selected ? label + rowIndex : label} /></box>;\n` +
        `};\n` +
        `const register = (hunk) => hunk.registerFileView({\n` +
        `  id: "tsx", title: "TSX", matches: () => true,\n` +
        `  layout: () => ({ rows: [{ id: "row", spans: [{ text: "fallback" }], component: { height: 2, render: Row } }], hunkRows: [] }),\n` +
        `});\n` +
        `export default { Row, TextAttributes, makeElement: () => <Row width={20} height={2} selected={false} rowIndex={0} />, register, useState };\n`,
    );

    const mod = await importTempExtension(path);
    const registered: {
      layout: () => { rows: Array<{ component: unknown }> };
    }[] = [];
    const register = mod.default.register as (hunk: {
      registerFileView(view: (typeof registered)[number]): void;
    }) => void;
    register({ registerFileView: (view) => registered.push(view) });

    expect(mod.default.useState).toBe(useState);
    expect(mod.default.TextAttributes).toBe(TextAttributes);
    expect(isValidElement((mod.default.makeElement as () => unknown)())).toBe(true);
    expect(
      (registered[0]?.layout().rows[0]?.component as { render?: unknown } | undefined)?.render,
    ).toBe(mod.default.Row);
  });

  test("serves hunkdiff/extension runtime values", async () => {
    const path = writeTempExtension(
      "ext.ts",
      `import { HunkExtensionUserError } from "hunkdiff/extension";\n` +
        `export default { HunkExtensionUserError };\n`,
    );

    const mod = await importTempExtension(path);

    expect(mod.default.HunkExtensionUserError).toBe(HunkExtensionUserError);
  });

  test("serves host modules when the extension root uses an aliased path", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-host-modules-alias-"));
    tempDirs.push(root);
    const actualDirectory = join(root, "actual");
    const aliasDirectory = join(root, "alias");
    mkdirSync(actualDirectory);
    symlinkSync(actualDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    const path = join(aliasDirectory, "ext.ts");
    writeFileSync(
      join(actualDirectory, "ext.ts"),
      `import { HunkExtensionUserError } from "hunkdiff/extension";\n` +
        `export default { HunkExtensionUserError };\n`,
    );

    const mod = await importTempExtension(path);

    expect(mod.default.HunkExtensionUserError).toBe(HunkExtensionUserError);
  });

  test("reaches helper modules imported by the entry file", async () => {
    const path = writeTempExtension(
      "ext.ts",
      `import { helperUseState } from "./helper";\nexport default { helperUseState };\n`,
    );
    writeFileSync(
      join(dirname(path), "helper.ts"),
      `import { useState } from "react";\nexport const helperUseState = useState;\n`,
    );

    const mod = await importTempExtension(path);

    expect(mod.default.helperUseState).toBe(useState);
  });

  test("does not claim bare specifiers outside registered extension directories", async () => {
    // The load hook is scoped per directory on purpose: a process-wide claim on
    // `react` breaks the host's own lazily imported modules when Hunk runs from
    // source. A file in an unregistered directory must keep normal resolution —
    // here, that means failing to find a package its directory does not have.
    registerHostRuntimeModules([writeTempExtension("registered.ts", "export default {};\n")]);
    const outsiderDir = mkdtempSync(join(tmpdir(), "hunk-host-modules-outside-"));
    tempDirs.push(outsiderDir);
    const outsider = join(outsiderDir, "outsider.ts");
    writeFileSync(outsider, `import "react";\nexport default {};\n`);

    await expect(import(pathToFileURL(outsider).href)).rejects.toThrow(/react/);
  });

  test("loads a package from the extension's own node_modules", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-host-modules-dep-"));
    tempDirs.push(root);
    const entryDir = join(root, "src");
    mkdirSync(entryDir);
    const path = join(entryDir, "index.ts");
    writeFileSync(path, `import fakeDep from "fake-dep";\nexport default fakeDep;\n`);
    const depDir = join(root, "node_modules", "fake-dep");
    mkdirSync(depDir, { recursive: true });
    writeFileSync(
      join(depDir, "package.json"),
      JSON.stringify({ name: "fake-dep", version: "1.0.0", main: "index.js" }),
    );
    writeFileSync(join(depDir, "index.js"), `module.exports = { language: "graphql" };\n`);

    const mod = await importTempExtension(path);

    expect(mod.default).toEqual({ language: "graphql" });
  });

  test("does not resolve a type-only import the transpiler erases", async () => {
    const path = writeTempExtension(
      "ext.ts",
      `import type { Missing } from "type-only-pkg";\nexport default { ready: true as Missing | boolean };\n`,
    );

    const mod = await importTempExtension(path);

    expect(mod.default.ready).toBe(true);
  });

  test("leaves an unknown package bare and the import rejects", async () => {
    const path = writeTempExtension("ext.ts", `import "not-a-real-package";\nexport default {};\n`);
    expect(rewriteInstalledPackageSpecifiers(`import "not-a-real-package";\n`, path)).toBe(
      `import "not-a-real-package";\n`,
    );

    await expect(importTempExtension(path)).rejects.toThrow(/not-a-real-package/);
  });
});

describe("rewriteInstalledPackageSpecifiers", () => {
  test("substitutes the file Bun resolves for an extension and for a dependency", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-host-modules-rewrite-"));
    tempDirs.push(root);
    const entry = join(root, "index.ts");
    writeFileSync(entry, `export {}\n`);
    const fakeDep = join(root, "node_modules", "fake-dep");
    mkdirSync(fakeDep, { recursive: true });
    writeFileSync(
      join(fakeDep, "package.json"),
      JSON.stringify({ name: "fake-dep", main: "index.js" }),
    );
    writeFileSync(join(fakeDep, "index.js"), `module.exports = { language: "graphql" };\n`);
    const depA = join(root, "node_modules", "dep-a");
    const depB = join(root, "node_modules", "dep-b");
    mkdirSync(depA, { recursive: true });
    mkdirSync(depB, { recursive: true });
    writeFileSync(join(depA, "package.json"), JSON.stringify({ name: "dep-a", main: "index.js" }));
    writeFileSync(join(depA, "index.js"), `import value from "dep-b";\nexport default value;\n`);
    writeFileSync(join(depB, "package.json"), JSON.stringify({ name: "dep-b", main: "index.js" }));
    writeFileSync(join(depB, "index.js"), `module.exports = { ok: true };\n`);

    const resolvedDep = Bun.resolveSync("fake-dep", entry);
    const fromExtension = rewriteInstalledPackageSpecifiers(
      `export { language } from "fake-dep";\n`,
      entry,
    );
    expect(fromExtension).toContain(pathToFileURL(resolvedDep).href);
    expect(fromExtension).not.toContain(`"fake-dep"`);

    const requireRewrite = rewriteInstalledPackageSpecifiers(
      `const dep = require("fake-dep");\n`,
      entry,
    );
    // require() keeps the absolute path, and the rewrite doubles backslashes
    // so the specifier stays valid inside the original quotes.
    expect(requireRewrite).toContain(resolvedDep.replaceAll("\\", "\\\\").replaceAll('"', '\\"'));
    expect(requireRewrite).not.toContain("file:");

    const depAEntry = join(depA, "index.js");
    const resolvedSibling = Bun.resolveSync("dep-b", depAEntry);
    const fromDependency = rewriteInstalledPackageSpecifiers(
      `import value from "dep-b";\n`,
      depAEntry,
    );
    expect(fromDependency).toContain(pathToFileURL(resolvedSibling).href);
  });

  test("rewrites an import-only export when Bun cannot resolve the package", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-host-modules-esm-"));
    tempDirs.push(root);
    const entry = join(root, "index.ts");
    writeFileSync(entry, `export {}\n`);
    const pkgDir = join(root, "node_modules", "esm-only");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "esm-only",
        exports: { ".": { import: "./entry.js" } },
      }),
    );
    writeFileSync(join(pkgDir, "entry.js"), `export const language = "md";\n`);

    const original = Bun.resolveSync;
    Bun.resolveSync = (() => {
      throw Object.assign(new Error("Cannot find package 'esm-only'"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    }) as typeof Bun.resolveSync;
    try {
      const rewritten = rewriteInstalledPackageSpecifiers(`import pkg from "esm-only";\n`, entry);
      expect(rewritten).toContain(pathToFileURL(join(pkgDir, "entry.js")).href);
    } finally {
      Bun.resolveSync = original;
    }
  });

  test("rewrites a root-level import condition when exports has no dot key", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-host-modules-esm-root-"));
    tempDirs.push(root);
    const entry = join(root, "index.ts");
    writeFileSync(entry, `export {}\n`);
    const pkgDir = join(root, "node_modules", "esm-root");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "esm-root",
        exports: { import: "./entry.js" },
      }),
    );
    writeFileSync(join(pkgDir, "entry.js"), `export const language = "md";\n`);

    const original = Bun.resolveSync;
    Bun.resolveSync = (() => {
      throw Object.assign(new Error("Cannot find package 'esm-root'"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    }) as typeof Bun.resolveSync;
    try {
      const rewritten = rewriteInstalledPackageSpecifiers(`import pkg from "esm-root";\n`, entry);
      expect(rewritten).toContain(pathToFileURL(join(pkgDir, "entry.js")).href);
    } finally {
      Bun.resolveSync = original;
    }
  });

  test("keeps relative, node, and bun specifiers unchanged", () => {
    const path = writeTempExtension("ext.ts", `export default {};\n`);
    const source = [
      `import helper from "./helper";`,
      `import marked from "./node_modules/marked/lib/marked.esm.js";`,
      `import fs from "node:fs";`,
      `import bareFs from "fs";`,
      `import promises from "fs/promises";`,
      `import ffi from "bun:ffi";`,
    ].join("\n");

    expect(rewriteInstalledPackageSpecifiers(source, path)).toBe(source);
  });

  test("rewrites scoped package names and subpaths", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-host-modules-scope-"));
    tempDirs.push(root);
    const entry = join(root, "index.ts");
    writeFileSync(entry, `export {}\n`);
    const scoped = join(root, "node_modules", "@scope", "pkg");
    mkdirSync(scoped, { recursive: true });
    writeFileSync(
      join(scoped, "package.json"),
      JSON.stringify({ name: "@scope/pkg", main: "index.js" }),
    );
    writeFileSync(join(scoped, "index.js"), `module.exports = { name: "scoped" };\n`);
    const subpath = join(root, "node_modules", "pkg");
    mkdirSync(subpath, { recursive: true });
    writeFileSync(join(subpath, "package.json"), JSON.stringify({ name: "pkg", main: "index.js" }));
    writeFileSync(join(subpath, "entry.js"), `module.exports = { sub: true };\n`);

    const rewritten = rewriteInstalledPackageSpecifiers(
      `import scoped from "@scope/pkg";\nimport entry from "pkg/entry";\n`,
      entry,
    );

    expect(rewritten).toContain(pathToFileURL(Bun.resolveSync("@scope/pkg", entry)).href);
    expect(rewritten).toContain(pathToFileURL(Bun.resolveSync("pkg/entry", entry)).href);
  });
});
