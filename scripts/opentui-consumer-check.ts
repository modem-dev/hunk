import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MODES = {
  nodenext: { module: "nodenext", moduleResolution: "nodenext" },
  bundler: { module: "esnext", moduleResolution: "bundler" },
} as const;

/** Typecheck the built OpenTUI subpath exactly as an installed package resolves it. */
export function checkOpenTuiConsumerTypes(repoRoot: string) {
  const sourcePackage = path.join(repoRoot, "packages", "hunk");
  const consumerRoot = mkdtempSync(path.join(tmpdir(), "hunk-opentui-consumer-"));
  try {
    const packageRoot = path.join(consumerRoot, "node_modules", "hunkdiff");
    mkdirSync(path.join(packageRoot, "dist", "npm"), { recursive: true });
    cpSync(
      path.join(sourcePackage, "dist", "npm", "opentui"),
      path.join(packageRoot, "dist", "npm", "opentui"),
      { recursive: true },
    );
    writeFileSync(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: "hunkdiff",
        version: "0.0.0-consumer-check",
        type: "module",
        exports: {
          "./opentui": {
            types: "./dist/npm/opentui/index.d.ts",
            import: "./dist/npm/opentui/index.js",
          },
        },
      })}\n`,
    );

    // Link only declared public peers; no Hunk source tree is available to hide
    // a missing or private declaration import.
    for (const name of [
      "react",
      "@types/react",
      "@types/bun",
      "@pierre/diffs",
      "@opentui/core",
      "@opentui/react",
    ]) {
      const source = path.join(repoRoot, "node_modules", ...name.split("/"));
      if (!existsSync(source)) throw new Error(`Missing installed peer ${name}.`);
      const destination = path.join(consumerRoot, "node_modules", ...name.split("/"));
      mkdirSync(path.dirname(destination), { recursive: true });
      symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
    }

    writeFileSync(
      path.join(consumerRoot, "consumer.tsx"),
      `import type { HunkDiffFileInput } from "hunkdiff/opentui";\n` +
        `import { HunkDiffView, createHunkDiffFile } from "hunkdiff/opentui";\n` +
        `declare const input: HunkDiffFileInput;\n` +
        `createHunkDiffFile(input);\n` +
        `void <HunkDiffView diff={input} width={80} />;\n`,
    );
    writeFileSync(
      path.join(consumerRoot, "package.json"),
      `${JSON.stringify({ name: "consumer", private: true, type: "module" })}\n`,
    );

    for (const [mode, resolution] of Object.entries(MODES)) {
      const config = path.join(consumerRoot, `tsconfig.${mode}.json`);
      writeFileSync(
        config,
        `${JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            lib: ["ESNext", "DOM"],
            ...resolution,
            jsx: "react-jsx",
            strict: true,
            noEmit: true,
            skipLibCheck: false,
          },
          files: ["consumer.tsx"],
        })}\n`,
      );
      const proc = Bun.spawnSync(["bun", "x", "tsc", "-p", config], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) {
        throw new Error(
          `hunkdiff/opentui failed ${mode} consumer typecheck:\n${Buffer.from(proc.stdout).toString()}${Buffer.from(proc.stderr).toString()}`,
        );
      }
    }
    return Object.keys(MODES);
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
}
