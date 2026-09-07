/**
 * Typecheck a real consumer against the built `hunkdiff/extension` declarations.
 *
 * Everything the repo's own `tsc --noEmit` proves is about *sources*. It says
 * nothing about the declaration tree that actually ships, and the two can
 * disagree in exactly the way that matters: a relative specifier without a file
 * extension compiles fine here and is rejected outright by every consumer using
 * `moduleResolution: "nodenext"`, which is the default for a plain Node ESM
 * project. That failure is invisible until someone installs the package.
 *
 * So this stages the published tree the way npm would lay it out, points a
 * throwaway project at it, and compiles under **both** resolution modes. The
 * declarations have to satisfy the strict one and the permissive one.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** One consumer source file to compile. */
export interface ExtensionConsumerSource {
  /** File name, used in diagnostics. */
  name: string;
  text: string;
}

export interface CheckExtensionConsumerOptions {
  repoRoot: string;
  sources: ExtensionConsumerSource[];
  /** Resolution modes to compile under; both by default. */
  moduleResolutions?: readonly ("nodenext" | "bundler")[];
}

/** Module/moduleResolution pairs that have to accept the published declarations. */
const RESOLUTION_CONFIGS = {
  nodenext: { module: "nodenext", moduleResolution: "nodenext" },
  bundler: { module: "esnext", moduleResolution: "bundler" },
} as const;

/**
 * Lay out a minimal `node_modules/hunkdiff` around the built extension tree.
 *
 * Only the `./extension` subpath is staged: the published declarations are
 * required to be self-contained (`check-pack` enforces that separately), so a
 * consumer needs no dependencies of Hunk's to compile against them. Installing
 * the real tarball would prove the same thing far more slowly, and would need
 * a network.
 */
function stagePackage(consumerRoot: string, extensionDist: string) {
  const packageRoot = path.join(consumerRoot, "node_modules", "hunkdiff");
  const distDir = path.join(packageRoot, "dist", "npm", "extension");
  mkdirSync(path.dirname(distDir), { recursive: true });
  cpSync(extensionDist, distDir, { recursive: true });

  writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "hunkdiff",
        version: "0.0.0-consumer-check",
        type: "module",
        exports: {
          "./extension": {
            types: "./dist/npm/extension/index.d.ts",
            import: "./dist/npm/extension/index.js",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

/** Write the throwaway project's tsconfig for one resolution mode. */
function writeConsumerTsconfig(
  consumerRoot: string,
  mode: keyof typeof RESOLUTION_CONFIGS,
  sourceNames: string[],
) {
  const configPath = path.join(consumerRoot, `tsconfig.${mode}.json`);
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          ...RESOLUTION_CONFIGS[mode],
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          // The published declarations are the thing under test, so they are
          // checked rather than skipped.
          skipLibCheck: false,
          types: [],
        },
        include: sourceNames.map((name) => `src/${name}`),
      },
      null,
      2,
    )}\n`,
  );

  return configPath;
}

/**
 * Compile the staged consumer under every resolution mode.
 *
 * Throws with the compiler's own diagnostics on the first mode that fails, so
 * the error a maintainer sees is the error a user would have seen.
 */
export function checkExtensionConsumerTypes(options: CheckExtensionConsumerOptions) {
  const { repoRoot, sources } = options;
  const modes = options.moduleResolutions ?? (["nodenext", "bundler"] as const);
  const extensionDist = path.join(repoRoot, "packages", "hunk", "dist", "npm", "extension");

  if (!existsSync(path.join(extensionDist, "index.d.ts"))) {
    throw new Error(
      `Missing ${path.join(extensionDist, "index.d.ts")}. Run \`bun run build:npm\` first.`,
    );
  }

  const consumerRoot = mkdtempSync(path.join(tmpdir(), "hunk-consumer-check-"));

  try {
    stagePackage(consumerRoot, extensionDist);

    // `nodenext` reads each file's module format from the nearest package.json,
    // so without this the consumer's own sources compile as CommonJS — which
    // bans top-level await and misrepresents how an extension is actually loaded.
    writeFileSync(
      path.join(consumerRoot, "package.json"),
      `${JSON.stringify({ name: "hunk-consumer-check", private: true, type: "module" }, null, 2)}\n`,
    );

    const srcDir = path.join(consumerRoot, "src");
    mkdirSync(srcDir, { recursive: true });
    for (const source of sources) {
      writeFileSync(path.join(srcDir, source.name), source.text);
    }

    const sourceNames = sources.map((source) => source.name);
    for (const mode of modes) {
      const configPath = writeConsumerTsconfig(consumerRoot, mode, sourceNames);
      const proc = Bun.spawnSync(["bun", "x", "tsc", "-p", configPath], {
        cwd: repoRoot,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });

      if (proc.exitCode !== 0) {
        const stdout = Buffer.from(proc.stdout).toString("utf8").trim();
        const stderr = Buffer.from(proc.stderr).toString("utf8").trim();
        throw new Error(
          `hunkdiff/extension does not typecheck for a consumer using ` +
            `moduleResolution: "${mode}".\n\n${stdout || stderr}`,
        );
      }
    }

    return { consumerRoot, modes: [...modes] };
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
}
