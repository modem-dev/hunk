import { expect, test } from "bun:test";
import { rewriteModuleSpecifiers } from "./moduleSpecifiers";
import { rewriteHostSpecifiers } from "./hostRuntimeModules";

test("rewrites only literal module references and preserves data, comments, and member calls", () => {
  const source = [
    `import value from 'pkg';`,
    `import 'pkg';`,
    `export { value } from 'pkg';`,
    `export * from 'pkg';`,
    `const dynamic = import('pkg');`,
    `const required = require('pkg');`,
    `const member = object.require('pkg');`,
    `const optional = object?.require('pkg');`,
    'const documentation = `import "pkg" from "pkg" require("pkg")`;',
    `const text = 'import "pkg"';`,
    `const pattern = /import "pkg"/;`,
    `// import "pkg"`,
    `/* require('pkg') */`,
    `const computed = import(name);`,
  ].join("\n");
  const calls: string[] = [];

  const rewritten = rewriteModuleSpecifiers(source, (specifier, kind) => {
    calls.push(`${kind}:${specifier}`);
    return `resolved:${kind}:${specifier}`;
  });

  expect(calls).toEqual([
    "import:pkg",
    "import:pkg",
    "import:pkg",
    "import:pkg",
    "dynamic-import:pkg",
    "require:pkg",
  ]);
  expect(rewritten).toBe(
    [
      `import value from "resolved:import:pkg";`,
      `import "resolved:import:pkg";`,
      `export { value } from "resolved:import:pkg";`,
      `export * from "resolved:import:pkg";`,
      `const dynamic = import("resolved:dynamic-import:pkg");`,
      `const required = require("resolved:require:pkg");`,
      ...source.split("\n").slice(6),
    ].join("\n"),
  );
});

test("decodes escaped specifiers and safely quotes resolved paths", () => {
  const rewritten = rewriteModuleSpecifiers(`import 'p\\u006bg';`, (specifier) => {
    expect(specifier).toBe("pkg");
    return 'C:\\folder\\quote"file.js';
  });

  expect(rewritten).toBe(`import ${JSON.stringify('C:\\folder\\quote"file.js')};`);
});

test.each([
  `function run(require) { return require("pkg"); }`,
  `const run = (require) => require("pkg");`,
  `function require(value) { return value; } require("pkg");`,
  `function run() { require("pkg"); var require; }`,
  `{ require("pkg"); let require; }`,
  `const { require } = object; require("pkg");`,
  `const [require] = array; require("pkg");`,
  `try {} catch (require) { require("pkg"); }`,
  `for (const require of loaders) { require("pkg"); }`,
  `const run = function require() { return require("pkg"); };`,
  `import require from "./loader"; require("pkg");`,
  `require = value => value; require("pkg");`,
])("preserves a locally bound or reassigned require: %s", (source) => {
  const seen: string[] = [];
  const rewritten = rewriteModuleSpecifiers(source, (specifier, kind) => {
    seen.push(`${kind}:${specifier}`);
    return kind === "require" ? "changed" : undefined;
  });

  expect(rewritten).toBe(source);
  expect(seen).not.toContain("require:pkg");
});

test("rewrites runtime require outside a shadowing scope, including nested closures", () => {
  const source = [
    `function local(require) { return () => require("pkg"); }`,
    `const runtime = require("pkg");`,
    `function other({ require: alias }) { return require("pkg"); }`,
  ].join("\n");

  expect(rewriteModuleSpecifiers(source, (_specifier, kind) => `resolved:${kind}`)).toBe(
    [
      `function local(require) { return () => require("pkg"); }`,
      `const runtime = require("resolved:require");`,
      `function other({ require: alias }) { return require("resolved:require"); }`,
    ].join("\n"),
  );
});

test("redirects real host imports without changing documentation strings", () => {
  const source = `import { useState } from "react"; const docs = 'import "react"';`;

  expect(rewriteHostSpecifiers(source)).toBe(
    `import { useState } from "hunk-host:react"; const docs = 'import "react"';`,
  );
});
