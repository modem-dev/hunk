import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { npmCommand } from "./script-helpers";

const MODES = {
  nodenext: { module: "nodenext", moduleResolution: "nodenext" },
  bundler: { module: "esnext", moduleResolution: "bundler" },
} as const;

/** Typecheck both public subpaths from an actual npm tarball under supported resolution modes. */
export function checkPackedPublicConsumers(repoRoot: string) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "hunk-packed-consumer-"));
  try {
    const packageRoot = path.join(repoRoot, "packages", "hunk");
    const pack = Bun.spawnSync(
      [
        npmCommand,
        "pack",
        packageRoot,
        "--ignore-scripts",
        "--pack-destination",
        tempRoot,
        "--json",
      ],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: process.env },
    );
    if (pack.exitCode !== 0) {
      throw new Error(Buffer.from(pack.stderr).toString() || "npm pack failed");
    }
    const result = JSON.parse(Buffer.from(pack.stdout).toString()) as { filename: string }[];
    const tarball = path.join(tempRoot, result[0]?.filename ?? "");
    if (!existsSync(tarball)) throw new Error("npm pack did not produce a tarball.");

    const consumerRoot = path.join(tempRoot, "consumer");
    mkdirSync(consumerRoot);
    writeFileSync(
      path.join(consumerRoot, "package.json"),
      `${JSON.stringify({ name: "hunk-consumer", private: true, type: "module" })}\n`,
    );
    const install = Bun.spawnSync(
      [
        npmCommand,
        "install",
        "--ignore-scripts",
        "--legacy-peer-deps",
        "--no-package-lock",
        tarball,
      ],
      { cwd: consumerRoot, stdout: "pipe", stderr: "pipe", env: process.env },
    );
    if (install.exitCode !== 0) {
      throw new Error(Buffer.from(install.stderr).toString() || "npm install tarball failed");
    }

    for (const name of [
      "react",
      "@types/react",
      "@types/bun",
      "@pierre/diffs",
      "@opentui/core",
      "@opentui/react",
    ]) {
      const source = path.join(repoRoot, "node_modules", ...name.split("/"));
      const destination = path.join(consumerRoot, "node_modules", ...name.split("/"));
      if (existsSync(destination)) continue;
      mkdirSync(path.dirname(destination), { recursive: true });
      symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
    }

    writeFileSync(
      path.join(consumerRoot, "consumer.tsx"),
      `import type { HunkExtensionAPI } from "hunkdiff/extension";\n` +
        `import type { HunkDiffFileInput } from "hunkdiff/opentui";\n` +
        `import { HunkDiffView, createHunkDiffFile } from "hunkdiff/opentui";\n` +
        `declare const api: HunkExtensionAPI; declare const input: HunkDiffFileInput;\n` +
        `api.log("packed"); createHunkDiffFile(input); void <HunkDiffView diff={input} width={80} />;\n`,
    );

    for (const [mode, resolution] of Object.entries(MODES)) {
      const config = path.join(consumerRoot, `tsconfig.${mode}.json`);
      writeFileSync(
        config,
        `${JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["ESNext", "DOM"], ...resolution, jsx: "react-jsx", strict: true, noEmit: true, skipLibCheck: false }, files: ["consumer.tsx"] })}\n`,
      );
      const check = Bun.spawnSync(["bun", "x", "tsc", "-p", config], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });
      if (check.exitCode !== 0) {
        throw new Error(
          `Packed public subpaths failed ${mode}:\n${Buffer.from(check.stdout).toString()}${Buffer.from(check.stderr).toString()}`,
        );
      }
    }
    return Object.keys(MODES);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
