import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../../../scripts/build/package-paths";

// Install the main-thread counter before Pierre evaluates its static imports.
const highlightDecodeTestPreload = `
  const originalAtob = globalThis.atob;
  globalThis.shikiTestDecodes = 0;
  globalThis.atob = (value) => { globalThis.shikiTestDecodes++; return originalAtob(value); };
`;

// Exercise Pierre's actual import, not just the adapter, in fresh processes: Shiki caches its engine.
const highlightTestBody = `
  const highlighter = await getSharedHighlighter({
    langs: ["typescript", "elixir"], themes: ["github-dark-default"],
    preferredHighlighter: "shiki-wasm",
  });
  const tokens = [
    highlighter.codeToTokens("export const answer: number = 42;", { lang: "typescript", theme: "github-dark-default" }),
    highlighter.codeToTokens('def hello, do: "world"', { lang: "elixir", theme: "github-dark-default" }),
  ];
  console.log(JSON.stringify({ decodes: globalThis.shikiTestDecodes, tokens, assets: Bun.embeddedFiles.map(file => file.size) }));
`;

const highlightTestProgram = `
  import { getSharedHighlighter } from "@pierre/diffs";
  ${highlightTestBody}
`;

// Compiled executables have no runtime --preload; instrument before the dynamic import instead.
const compiledHighlightTestProgram = `
  ${highlightDecodeTestPreload}
  const { getSharedHighlighter } = await import("@pierre/diffs");
  ${highlightTestBody}
`;

// Install counters in the worker realm before its real entry imports Pierre or Shiki.
const workerDecodeTestPreload = `
  let atobCalls = 0, stringCopies = 0;
  const originalAtob = globalThis.atob;
  globalThis.atob = (value) => {
    if (value.length >= 600_000) atobCalls++;
    return originalAtob(value);
  };
  const originalFrom = Uint8Array.from;
  Uint8Array.from = function(value, ...rest) {
    if (typeof value === "string" && value.length >= 400_000) stringCopies++;
    return Reflect.apply(originalFrom, this, [value, ...rest]);
  };
  const originalPost = globalThis.postMessage;
  globalThis.postMessage = function(value, ...rest) {
    return Reflect.apply(originalPost, this, [{ ...value, atobCalls, stringCopies }, ...rest]);
  };
`;

/** Drive the production worker from a fresh process and report its worker-local decode counters. */
function workerHighlightTestProgram(preload: string) {
  const entry = pathToFileURL(join(REPO_ROOT, "packages/hunk/src/highlightWorkerEntry.ts"));
  return `
    import { parseDiffFromFile } from "@pierre/diffs";
    const worker = new Worker(${JSON.stringify(entry.href)}, { preload: [${JSON.stringify(preload)}] });
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Highlight worker timed out")), 3_000);
        worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)); };
        worker.onmessage = ({ data }) => { clearTimeout(timeout); resolve(data); };
        worker.postMessage({
          version: 3, id: 1, aliasContext: false, appearance: "dark",
          language: "typescript", theme: "github-dark-default",
          metadata: parseDiffFromFile(
            { name: "example.ts", contents: "" },
            { name: "example.ts", contents: "export const answer = 42;\\n" },
            { context: 3 }, true,
          ),
        });
      });
      console.log(JSON.stringify({ ok: result.ok, message: result.message,
        atobCalls: result.atobCalls, stringCopies: result.stringCopies }));
    } finally { worker.terminate(); }
  `;
}

/** Run a fresh source or compiled highlighter and surface child-process failures. */
function runHighlightTestProcess(args: string[], cwd = REPO_ROOT) {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString());
}

test("Pierre avoids base64 decoding in source, workers, bundles, and binaries with identical tokens", () => {
  const temporary = mkdtempSync(join(tmpdir(), "hunk-shiki-test-"));
  // Keep the compile entry under the repository so its package imports resolve normally.
  const sourceDir = mkdtempSync(join(REPO_ROOT, ".shiki-test-"));
  try {
    const config = join(temporary, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ESNext" } }));
    const mainPreload = join(temporary, "main-preload.ts");
    writeFileSync(mainPreload, highlightDecodeTestPreload);
    const stock = runHighlightTestProcess([
      process.execPath,
      "--preload",
      mainPreload,
      "--tsconfig-override",
      config,
      "--eval",
      highlightTestProgram,
    ]);
    expect(stock.decodes).toBe(1);

    const source = runHighlightTestProcess([
      process.execPath,
      "--preload",
      mainPreload,
      "--eval",
      highlightTestProgram,
    ]);
    expect(source.decodes).toBe(0);
    expect(source.tokens).toEqual(stock.tokens);

    const preload = join(temporary, "worker-preload.ts");
    writeFileSync(preload, workerDecodeTestPreload);
    const workerProgram = workerHighlightTestProgram(preload);
    const stockWorker = runHighlightTestProcess([
      process.execPath,
      "--tsconfig-override",
      config,
      "--eval",
      workerProgram,
    ]);
    expect(stockWorker).toEqual({ ok: true, atobCalls: 1, stringCopies: 1 });
    const worker = runHighlightTestProcess([process.execPath, "--eval", workerProgram]);
    expect(worker).toEqual({ ok: true, atobCalls: 0, stringCopies: 0 });

    const entry = join(sourceDir, "highlight.ts");
    const binary = join(temporary, process.platform === "win32" ? "highlight.exe" : "highlight");
    writeFileSync(entry, compiledHighlightTestProgram);
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-bunfig",
        entry,
        "--outfile",
        binary,
      ],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    writeFileSync(entry, highlightTestProgram);
    const bundleDir = join(temporary, "bundle");
    const bundle = Bun.spawnSync(
      [process.execPath, "build", "--target=bun", entry, "--outdir", bundleDir],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    expect(bundle.exitCode, bundle.stderr.toString()).toBe(0);
    rmSync(sourceDir, { recursive: true, force: true });

    // npm consumers launch from arbitrary repositories, not the directory containing the asset.
    const bundled = runHighlightTestProcess(
      [process.execPath, "--preload", mainPreload, join(bundleDir, "highlight.js")],
      temporary,
    );
    expect(bundled.decodes).toBe(0);
    expect(bundled.tokens).toEqual(stock.tokens);

    const compiled = runHighlightTestProcess([binary], temporary);
    expect(compiled.decodes).toBe(0);
    expect(compiled.tokens).toEqual(stock.tokens);
    expect(compiled.assets).toContain(466_610);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}, 60_000);
