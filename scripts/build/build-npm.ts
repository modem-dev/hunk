#!/usr/bin/env bun

import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { HUNK_NPM_DIST, HUNK_PACKAGE_ROOT, HUNK_SOURCE_ROOT, REPO_ROOT } from "./package-paths";

const repoRoot = REPO_ROOT;
const outdir = HUNK_NPM_DIST;
const typesOutdir = path.join(HUNK_PACKAGE_ROOT, "dist", "npm-types");
const opentuiOutdir = path.join(outdir, "opentui");
const opentuiTypesDir = path.join(typesOutdir, "hunk", "src", "opentui");
const extensionOutdir = path.join(outdir, "extension");
const extensionTypesOutdir = path.join(HUNK_PACKAGE_ROOT, "dist", "npm-extension-types");

const bunEnv = {
  ...process.env,
  BUN_TMPDIR: path.join(repoRoot, ".bun-tmp"),
  BUN_INSTALL: path.join(repoRoot, ".bun-install"),
};

/** Rewrite emitted ESM declaration imports for NodeNext consumers. */
function rewriteDeclarationSpecifiers(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteDeclarationSpecifiers(entryPath);
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;
    const source = readFileSync(entryPath, "utf8");
    const rewritten = source.replace(
      /(\bfrom\s+["']|\bimport\s*\(\s*["'])(\.{1,2}\/[^"']+?)(["'])/g,
      (match, prefix: string, specifier: string, quote: string) =>
        /\.(?:js|json|d\.ts)$/.test(specifier) ? match : `${prefix}${specifier}.js${quote}`,
    );
    if (rewritten !== source) writeFileSync(entryPath, rewritten);
  }
}

function runBun(args: string[]) {
  const proc = Bun.spawnSync(["bun", ...args], {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: bunEnv,
  });

  if (proc.exitCode !== 0) {
    throw new Error(`bun ${args.join(" ")} failed with exit ${proc.exitCode}`);
  }
}

rmSync(outdir, { recursive: true, force: true });
rmSync(typesOutdir, { recursive: true, force: true });
rmSync(extensionTypesOutdir, { recursive: true, force: true });
mkdirSync(opentuiOutdir, { recursive: true });
mkdirSync(extensionOutdir, { recursive: true });

const opentuiNativePackages = [
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64",
];

runBun([
  "build",
  path.join(HUNK_SOURCE_ROOT, "main.tsx"),
  "--target",
  "bun",
  "--format",
  "esm",
  ...opentuiNativePackages.flatMap((packageName) => ["--external", packageName]),
  "--outdir",
  outdir,
  "--entry-naming",
  "main.js",
]);

const mainJs = path.join(outdir, "main.js");
// chmod is a no-op on Windows; preserve exec bits on Unix so the bin runs in npm-installed packages.
if (process.platform !== "win32") {
  chmodSync(mainJs, 0o755);
}

runBun([
  "build",
  path.join(HUNK_SOURCE_ROOT, "opentui", "index.ts"),
  "--target",
  "node",
  "--format",
  "esm",
  "--external",
  "react",
  "--external",
  "react/jsx-runtime",
  "--external",
  "react/jsx-dev-runtime",
  "--external",
  "@opentui/core",
  "--external",
  "@opentui/react",
  "--external",
  "@opentui/react/jsx-runtime",
  "--external",
  "@opentui/react/jsx-dev-runtime",
  "--external",
  "@pierre/diffs",
  "--outdir",
  opentuiOutdir,
  "--entry-naming",
  "index.js",
]);

runBun(["x", "tsc", "-p", path.join(repoRoot, "tsconfig.opentui.json")]);

// Ship the complete declaration tree reached by the public OpenTUI entry. The
// compiler strips @internal adapters so this contains the public component
// surface without leaking the app's core model.
cpSync(opentuiTypesDir, opentuiOutdir, { recursive: true });
rewriteDeclarationSpecifiers(opentuiOutdir);

rmSync(typesOutdir, { recursive: true, force: true });

runBun([
  "build",
  path.join(HUNK_SOURCE_ROOT, "extension-api", "index.ts"),
  "--target",
  "node",
  "--format",
  "esm",
  "--external",
  "@pierre/diffs",
  "--outdir",
  extensionOutdir,
  "--entry-naming",
  "index.js",
]);

runBun(["x", "tsc", "-p", path.join(repoRoot, "tsconfig.extension.json")]);

// The extension entry emits only the import-free public API declaration tree. Ship it
// as-is and point the subpath export at a one-line barrel so consumers still resolve
// `hunkdiff/extension` from a single file.
// The specifier carries an explicit `.js` extension because `moduleResolution:
// "nodenext"` consumers reject extensionless relative imports in ESM declarations.
cpSync(extensionTypesOutdir, extensionOutdir, { recursive: true });
writeFileSync(
  path.join(extensionOutdir, "index.d.ts"),
  'export * from "./extension-api/index.js";\n',
);
rmSync(extensionTypesOutdir, { recursive: true, force: true });

console.log(`Built ${mainJs}`);
console.log(`Built ${path.join(opentuiOutdir, "index.js")}`);
console.log(`Built ${path.join(extensionOutdir, "index.js")}`);
