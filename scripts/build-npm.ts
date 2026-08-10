#!/usr/bin/env bun

import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const outdir = path.join(repoRoot, "dist", "npm");
const typesOutdir = path.join(repoRoot, "dist", "npm-types");
const opentuiOutdir = path.join(outdir, "opentui");
const opentuiTypesDir = path.join(typesOutdir, "opentui");
const staticOutdir = path.join(outdir, "static");
const staticTypesDir = path.join(typesOutdir, "static");
const extensionOutdir = path.join(outdir, "extension");
const extensionTypesOutdir = path.join(repoRoot, "dist", "npm-extension-types");

const bunEnv = {
  ...process.env,
  BUN_TMPDIR: path.join(repoRoot, ".bun-tmp"),
  BUN_INSTALL: path.join(repoRoot, ".bun-install"),
};

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

/** Build the Node static entry with a Node-18-compatible width engine. */
async function buildStaticEntry() {
  const result = await Bun.build({
    entrypoints: [path.join(repoRoot, "src", "static", "index.ts")],
    target: "node",
    format: "esm",
    splitting: true,
    external: ["@pierre/diffs"],
    outdir: staticOutdir,
    naming: { entry: "index.js" },
    plugins: [
      {
        name: "static-node18-string-width",
        setup(build) {
          build.onResolve({ filter: /^string-width$/ }, () => ({
            path: Bun.resolveSync("string-width-node18", repoRoot),
          }));
        },
      },
    ],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Static renderer build failed");
  }
}

rmSync(outdir, { recursive: true, force: true });
rmSync(typesOutdir, { recursive: true, force: true });
rmSync(extensionTypesOutdir, { recursive: true, force: true });
mkdirSync(opentuiOutdir, { recursive: true });
mkdirSync(staticOutdir, { recursive: true });
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
  path.join(repoRoot, "src", "main.tsx"),
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
  path.join(repoRoot, "src", "opentui", "index.ts"),
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

for (const entry of readdirSync(opentuiTypesDir)) {
  if (entry.endsWith(".d.ts")) {
    copyFileSync(path.join(opentuiTypesDir, entry), path.join(opentuiOutdir, entry));
  }
}

await buildStaticEntry();

runBun(["x", "tsc", "-p", path.join(repoRoot, "tsconfig.static.json")]);
for (const entry of readdirSync(staticTypesDir)) {
  if (entry.endsWith(".d.ts")) {
    copyFileSync(path.join(staticTypesDir, entry), path.join(staticOutdir, entry));
  }
}

rmSync(typesOutdir, { recursive: true, force: true });

runBun([
  "build",
  path.join(repoRoot, "src", "extension-api", "index.ts"),
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
console.log(`Built ${path.join(staticOutdir, "index.js")}`);
console.log(`Built ${path.join(extensionOutdir, "index.js")}`);
