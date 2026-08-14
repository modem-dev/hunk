// Build plugin that routes OpenTUI's embedded native library through hunk's
// stable cache path instead of Bun's leaking tmp extraction.
//
// Each @opentui/core-<platform> package's default export is just a path
// string that @opentui/core dlopens; under the "bun" export condition it
// comes from `import "./libopentui.so" with { type: "file" }`, which in a
// compiled binary resolves to Bun's per-launch temp extraction
// (oven-sh/bun#30962, hunk #556). This plugin intercepts those platform
// package imports and substitutes a shim whose default export is the stable
// content-addressed cache path produced by src/core/nativeLibMaterialize.ts.
// Reading the embedded bytes never extracts; only dlopen does, and dlopen now
// targets the cache path. Deletable together with that module once Bun's
// extraction dedupe (oven-sh/bun#29587) ships.

import { readdirSync } from "node:fs";
import path from "node:path";

const PLATFORM_PACKAGE_FILTER = /^@opentui\/core-/;
const NATIVE_LIB_FILE_PATTERN = /\.(?:so|dylib|dll)$/;
const SHIM_NAMESPACE = "hunk-opentui-native-shim";

/** Create the Bun build plugin that substitutes stable-path shims for OpenTUI platform packages. */
export function createOpentuiStableNativeLibPlugin(repoRoot: string): Bun.BunPlugin {
  return {
    name: "hunk-opentui-stable-native-lib",
    setup(build) {
      build.onResolve({ filter: PLATFORM_PACKAGE_FILTER }, (args) => {
        // Resolve from the importing module: the platform packages are
        // optional deps of @opentui/core and are not visible from the repo
        // root under Bun's isolated node_modules layout.
        const entryPath = Bun.resolveSync(args.path, path.dirname(args.importer));
        return { path: entryPath, namespace: SHIM_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: SHIM_NAMESPACE }, (args) => {
        const pkgDir = path.dirname(args.path);
        // Exactly one native library per platform package is the contract this
        // shim relies on; ambiguity must fail the build loudly rather than
        // silently dlopen the wrong file.
        const libFiles = readdirSync(pkgDir).filter((name) => NATIVE_LIB_FILE_PATTERN.test(name));
        if (libFiles.length !== 1) {
          throw new Error(
            `Expected exactly one native library (.so/.dylib/.dll) in ${pkgDir}, found ${libFiles.length}: ${libFiles.join(", ")}`,
          );
        }
        const libFile = libFiles[0];
        const helperPath = path.join(repoRoot, "src", "core", "nativeLibMaterialize.ts");
        return {
          resolveDir: pkgDir,
          loader: "ts",
          contents: [
            `import embedded from ${JSON.stringify(`./${libFile}`)} with { type: "file" };`,
            `import { materializeStableNativeLibPath } from ${JSON.stringify(helperPath)};`,
            `export default await materializeStableNativeLibPath(embedded, ${JSON.stringify(libFile)});`,
          ].join("\n"),
        };
      });
    },
  };
}
