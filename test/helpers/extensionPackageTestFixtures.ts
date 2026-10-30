import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Install synthetic packages covering export conditions and transitive local dependencies. */
export function createTestExtensionPackages(root: string) {
  const packageDirectory = join(root, "node_modules", "fixture-pkg");
  mkdirSync(join(packageDirectory, "features"), { recursive: true });
  writeFileSync(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "fixture-pkg",
      type: "module",
      exports: {
        ".": { node: { import: "./esm.js", require: "./required.json" } },
        "./commonjs": { require: "./cjs.cjs" },
        "./feature": { import: "./feature.js" },
        "./features/*": { import: "./features/*.js" },
        "./blocked": null,
        "./ordered": { default: "./default.js", import: "./esm.js" },
        "./bun": { bun: "./bun.js", node: "./esm.js" },
      },
    }),
  );
  writeFileSync(
    join(packageDirectory, "esm.js"),
    `import dependency from "fixture-dependency";\nexport { useState as packageUseState } from "fixture-dependency";\nexport default dependency === "dependency" ? "import-branch" : dependency;\n`,
  );
  // JSON bypasses Bun's async source hook; CommonJS source require() is a separate runtime limitation.
  writeFileSync(join(packageDirectory, "required.json"), JSON.stringify("require-branch"));
  writeFileSync(join(packageDirectory, "cjs.cjs"), `module.exports = "commonjs-branch";\n`);
  writeFileSync(join(packageDirectory, "feature.js"), `export default "feature";\n`);
  writeFileSync(join(packageDirectory, "features", "one.js"), `export default "pattern";\n`);
  writeFileSync(join(packageDirectory, "default.js"), `export default "ordered-default";\n`);
  writeFileSync(join(packageDirectory, "bun.js"), `export default "bun-branch";\n`);
  writeFileSync(join(packageDirectory, "blocked.js"), `export default "not-exported";\n`);

  const dependencyDirectory = join(root, "node_modules", "fixture-dependency");
  mkdirSync(dependencyDirectory, { recursive: true });
  writeFileSync(
    join(dependencyDirectory, "package.json"),
    JSON.stringify({ name: "fixture-dependency", type: "module", main: "index.js" }),
  );
  mkdirSync(join(dependencyDirectory, "helpers"), { recursive: true });
  writeFileSync(
    join(dependencyDirectory, "index.js"),
    `export { useState } from "./helpers/react.js";\nexport { default } from "./helpers/value.js";\n`,
  );
  writeFileSync(
    join(dependencyDirectory, "helpers", "react.js"),
    `export { useState } from "react";\n`,
  );
  writeFileSync(
    join(dependencyDirectory, "helpers", "value.js"),
    `import value from "fixture-leaf";\nexport default value;\n`,
  );
  const leafDirectory = join(root, "node_modules", "fixture-leaf");
  mkdirSync(leafDirectory, { recursive: true });
  writeFileSync(
    join(leafDirectory, "package.json"),
    JSON.stringify({ name: "fixture-leaf", type: "module", main: "index.js" }),
  );
  writeFileSync(join(leafDirectory, "index.js"), `export default "dependency";\n`);

  return packageDirectory;
}

/** Write an extension that exercises module rewriting while keeping lookalike data unchanged. */
export function createTestPackageExtension(root: string, entryDirectory = root) {
  createTestExtensionPackages(root);
  mkdirSync(entryDirectory, { recursive: true });
  const fakeReactDirectory = join(root, "node_modules", "react");
  mkdirSync(fakeReactDirectory, { recursive: true });
  writeFileSync(
    join(fakeReactDirectory, "package.json"),
    JSON.stringify({ name: "react", type: "module", exports: "./index.js" }),
  );
  writeFileSync(
    join(fakeReactDirectory, "index.js"),
    `export const useState = () => "wrong-instance";\n`,
  );
  writeFileSync(
    join(entryDirectory, "helper.js"),
    `import { useState } from "react";\nexport const helperUseState = useState;\n`,
  );

  const entry = join(entryDirectory, "index.ts");
  writeFileSync(
    entry,
    [
      `import imported, { packageUseState } from "fixture-pkg";`,
      `import feature from "fixture-pkg/feature";`,
      `import pattern from "fixture-pkg/features/one";`,
      `import ordered from "fixture-pkg/ordered";`,
      `import bun from "fixture-pkg/bun";`,
      `import { useState } from "react";`,
      `import { helperUseState } from "./helper.js";`,
      `export { default as reexported } from "fixture-pkg/feature";`,
      `const required = require("fixture-pkg");`,
      `const dynamic = (await import("fixture-pkg/feature")).default;`,
      `const object = { require(value: string) { return value; } };`,
      `const local = ((require: (value: string) => string) => require("ordinary-data"))(value => value);`,
      'const documentation = `Docs: import "fixture-pkg" and import "react"`;',
      `export { useState };`,
      `export default { imported, required, feature, pattern, ordered, bun, dynamic,`,
      `  documentation, member: object.require("fixture-pkg"), local, helperReact: helperUseState === useState, packageReact: packageUseState === useState };`,
      "",
    ].join("\n"),
  );
  return entry;
}

export const TEST_PACKAGE_EXTENSION_RESULT = {
  imported: "import-branch",
  required: "require-branch",
  feature: "feature",
  pattern: "pattern",
  ordered: "ordered-default",
  bun: "bun-branch",
  dynamic: "feature",
  documentation: 'Docs: import "fixture-pkg" and import "react"',
  member: "fixture-pkg",
  local: "ordinary-data",
  helperReact: true,
  packageReact: true,
};

/** Write optional imports whose errors must be caught at execution rather than source loading. */
export function createTestOptionalPackageExtension(root: string) {
  createTestExtensionPackages(root);
  const entry = join(root, "optional.ts");
  writeFileSync(
    entry,
    [
      `import { useState } from "react";`,
      `export { useState };`,
      `const unused = () => import("never-executed-package");`,
      `let missing = false, blocked = false, required = false;`,
      `try { await import("optional-missing-package"); } catch (error) { missing = error.message.includes("optional-missing-package"); }`,
      `try { await import("fixture-pkg/blocked"); } catch (error) { blocked = error.message.includes("fixture-pkg"); }`,
      `try { require("fixture-pkg/blocked"); } catch (error) { required = error.message.includes("fixture-pkg"); }`,
      `if (false) await import("disabled-package");`,
      `export default { missing, blocked, required, unused: typeof unused === "function" };`,
      "",
    ].join("\n"),
  );
  return entry;
}
