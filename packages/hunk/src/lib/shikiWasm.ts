/**
 * Load Shiki's original WASM bytes for the terminal and highlight worker without base64 decoding.
 * Pierre reaches this Bun runtime adapter through the `shiki/wasm` tsconfig alias in source and builds.
 */
import { resolve } from "node:path";
import wasmPath from "shiki/onig.wasm" with { type: "file" };

/** Read the asset asynchronously; Bun embeds this file when compiling the standalone executable. */
export default async function instantiate(imports: WebAssembly.Imports) {
  // Source and compiled paths are absolute; npm bundles emit a path beside the JS entry, not cwd.
  return WebAssembly.instantiate(
    await Bun.file(resolve(import.meta.dir, wasmPath)).arrayBuffer(),
    imports,
  );
}
