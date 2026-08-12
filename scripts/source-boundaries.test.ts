import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const CORE_ROOT = join(SRC_ROOT, "core");
const EXTENSIONS_ROOT = join(SRC_ROOT, "extensions");
const BUNDLED_PROVIDER_ROOT = join(EXTENSIONS_ROOT, "default", "vcs");
const REVIEW_MODEL_ROOT = join(CORE_ROOT, "review");
const REVIEW_PROTOCOL_PATH = join(SRC_ROOT, "session", "reviewProtocol.ts");
const WEB_CLIENT_ROOT = join(SRC_ROOT, "web");

/** Return one repo-relative path with forward slashes for stable assertions on every platform. */
function repoPath(path: string) {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

/** Return every production TypeScript source file below one directory, tolerating absent trees. */
function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Read static and dynamic module specifiers from one source file. */
function importSpecifiers(path: string) {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/(?:from\s*|import\s*\()["']([^"']+)["']/g)].map((match) => match[1]!);
}

/** Resolve one relative source import sufficiently for architectural containment checks. */
function resolveImport(path: string, specifier: string) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const base = resolve(dirname(path), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return base;
}

/** Return true when one resolved path sits at or below one containment root (or equals one file). */
function isWithin(root: string, target: string) {
  const offset = relative(root, target);
  return (
    offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  );
}

/** Find imports from one tree that resolve beneath a forbidden tree. */
function forbiddenImports(sourceRoot: string, forbiddenRoot: string) {
  return sourceFiles(sourceRoot).flatMap((path) =>
    importSpecifiers(path).flatMap((specifier) => {
      const target = resolveImport(path, specifier);
      if (!target) {
        return [];
      }
      return isWithin(forbiddenRoot, target) ? [`${repoPath(path)} -> ${specifier}`] : [];
    }),
  );
}

/** Find relative imports from one tree that resolve outside every allowed containment target. */
function escapingImports(sourceRoot: string, allowedTargets: readonly string[]) {
  return sourceFiles(sourceRoot).flatMap((path) =>
    importSpecifiers(path).flatMap((specifier) => {
      const target = resolveImport(path, specifier);
      if (!target) {
        return [];
      }
      const allowed = allowedTargets.some((allowedTarget) => isWithin(allowedTarget, target));
      return allowed ? [] : [`${repoPath(path)} -> ${specifier}`];
    }),
  );
}

/** Find bare package or builtin imports outside one allowlist, honoring per-file exceptions. */
function unexpectedExternalImports(
  sourceRoot: string,
  allowed: ReadonlySet<string>,
  fileExceptions: ReadonlyMap<string, readonly string[]> = new Map(),
) {
  return sourceFiles(sourceRoot).flatMap((path) => {
    const exceptions = fileExceptions.get(repoPath(path)) ?? [];
    return importSpecifiers(path).flatMap((specifier) => {
      if (specifier.startsWith(".") || allowed.has(specifier) || exceptions.includes(specifier)) {
        return [];
      }
      return [`${repoPath(path)} -> ${specifier}`];
    });
  });
}

/** Find bundled provider imports that bypass the published extension barrel. */
function privateProviderApiImports() {
  return sourceFiles(BUNDLED_PROVIDER_ROOT).flatMap((path) =>
    importSpecifiers(path).some((specifier) => specifier.includes("extension-api"))
      ? [repoPath(path)]
      : [],
  );
}

// Modules deleted because a shared review primitive replaced them (docs/browser-review-seam-
// audit.md findings). Append-only: each seam-extraction PR adds the copies it deleted, tagged
// with the finding id, and this gate keeps them deleted — a reappearing path means the
// duplication came back. Entries are repo-relative with forward slashes.
const EXTRACTED_DUPLICATE_TOMBSTONES: readonly string[] = [
  // e.g. "src/ui/lib/hunks.ts", // B1: replaced by core/review selection/move planning
];

describe("source architecture boundaries", () => {
  test("keeps UI rendering out of core", () => {
    expect(forbiddenImports(CORE_ROOT, join(SRC_ROOT, "ui"))).toEqual([]);
  });

  test("keeps extracted duplicate modules deleted", () => {
    const resurrected = EXTRACTED_DUPLICATE_TOMBSTONES.filter((tombstone) =>
      existsSync(join(REPO_ROOT, ...tombstone.split("/"))),
    );
    expect(resurrected).toEqual([]);
  });

  test("keeps extension composition out of core", () => {
    expect(forbiddenImports(CORE_ROOT, EXTENSIONS_ROOT)).toEqual([]);
  });

  test("keeps bundled provider implementations out of core", () => {
    for (const file of ["git.ts", "gitSource.ts", "jujutsu.ts", "sapling.ts"]) {
      expect(existsSync(join(CORE_ROOT, "vcs", file))).toBe(false);
    }
  });

  test("keeps bundled providers on their public host contract", () => {
    expect(forbiddenImports(BUNDLED_PROVIDER_ROOT, CORE_ROOT)).toEqual([]);
    expect(privateProviderApiImports()).toEqual([]);
  });
});

// The seam contract for sharing the review experience with a browser surface: the semantic
// review model and its wire protocol are the primitives every consumer (terminal UI, session
// runtime, browser client) builds on, so they must stay renderer-free and platform-neutral.
// Every check tolerates the gated tree not existing yet, so this suite lands ahead of the code
// it constrains and gates each rebuild phase as it arrives.
describe("shared review primitives seam", () => {
  // The review model may depend on Pierre's diff types and nothing else external.
  const REVIEW_MODEL_EXTERNALS = new Set(["@pierre/diffs"]);
  // Node-only primitives the prototype's model files still carry. A rebuild phase may land one
  // of these files with its listed builtin while migrating it to a platform-neutral
  // implementation (e.g. injected hashing), but a browser bundle must never import it until the
  // entry is repaid. This map may only shrink — never extend it for new code.
  const REVIEW_MODEL_NODE_DEBT = new Map<string, readonly string[]>([
    ["src/core/review/document.ts", ["node:crypto"]],
    ["src/core/review/identity.ts", ["node:crypto"]],
    ["src/core/review/jsonStream.ts", ["node:crypto"]],
    ["src/core/review/sourceIdentity.ts", ["node:path"]],
  ]);
  // The browser client renders with React and Pierre only; everything else must come from the
  // shared review model or the wire protocol.
  const WEB_CLIENT_EXTERNALS = new Set([
    "react",
    "react-dom/client",
    "@pierre/diffs",
    "@pierre/diffs/react",
    "@pierre/trees",
    "@pierre/trees/react",
  ]);

  test("keeps the review model contained in core", () => {
    expect(escapingImports(REVIEW_MODEL_ROOT, [CORE_ROOT])).toEqual([]);
  });

  test("keeps rendering and platform runtimes out of the review model", () => {
    expect(
      unexpectedExternalImports(REVIEW_MODEL_ROOT, REVIEW_MODEL_EXTERNALS, REVIEW_MODEL_NODE_DEBT),
    ).toEqual([]);
  });

  test("keeps the review wire protocol browser-safe", () => {
    if (!existsSync(REVIEW_PROTOCOL_PATH)) {
      return;
    }
    const violations = importSpecifiers(REVIEW_PROTOCOL_PATH).flatMap((specifier) => {
      if (specifier.startsWith(".")) {
        const target = resolveImport(REVIEW_PROTOCOL_PATH, specifier);
        return target && isWithin(REVIEW_MODEL_ROOT, target) ? [] : [specifier];
      }
      // The broker-core package supplies shared limits and identifier parsing; it must stay
      // importable without Node-only side effects for the browser bundle.
      return specifier === "@hunk/session-broker-core" ? [] : [specifier];
    });
    expect(violations).toEqual([]);
  });

  test("keeps the browser client on shared review primitives", () => {
    expect(unexpectedExternalImports(WEB_CLIENT_ROOT, WEB_CLIENT_EXTERNALS)).toEqual([]);
    expect(
      escapingImports(WEB_CLIENT_ROOT, [WEB_CLIENT_ROOT, REVIEW_MODEL_ROOT, REVIEW_PROTOCOL_PATH]),
    ).toEqual([]);
  });
});
