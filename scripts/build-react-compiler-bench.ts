#!/usr/bin/env bun
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { transformFileSync } from "@babel/core";

const repoRoot = path.resolve(import.meta.dir, "..");
const outDir = path.join(repoRoot, "dist", "react-compiler-bench");
const sourceRoots = ["src", "benchmarks", "packages"];

const useReactCompiler = process.env.HUNK_REACT_COMPILER !== "0";
const compilerPlugin = ["babel-plugin-react-compiler", { target: "19" }];
const presets = [
  ["@babel/preset-typescript", { allowDeclareFields: true, onlyRemoveTypeImports: true }],
  ["@babel/preset-react", { runtime: "automatic", importSource: "@opentui/react" }],
];

/** Recursively transform TypeScript/TSX sources into runnable ESM JavaScript. */
function compileDirectory(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const sourcePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      compileDirectory(sourcePath);
      continue;
    }

    if (/\.(ts|tsx)$/.test(entry.name)) {
      compileFile(sourcePath);
    }
  }
}

/** Compile one source file while preserving its repo-relative location. */
function compileFile(sourcePath: string) {
  const relativePath = path.relative(repoRoot, sourcePath);
  const outputPath = path.join(outDir, relativePath).replace(/\.(ts|tsx)$/, ".js");
  mkdirSync(path.dirname(outputPath), { recursive: true });

  const result = transformFileSync(sourcePath, {
    babelrc: false,
    compact: false,
    configFile: false,
    filename: sourcePath,
    plugins: useReactCompiler ? [compilerPlugin] : [],
    presets,
    sourceType: "module",
  });

  writeFileSync(outputPath, `${result?.code ?? ""}\n`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(
  path.join(outDir, "package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
);

for (const root of sourceRoots) {
  compileDirectory(path.join(repoRoot, root));
}

symlinkSync(path.join(repoRoot, "node_modules"), path.join(outDir, "node_modules"), "dir");
console.error(`React Compiler: ${useReactCompiler ? "enabled" : "disabled"}`);
console.log(outDir);
