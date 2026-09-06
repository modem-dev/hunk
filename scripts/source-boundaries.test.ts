import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SRC_ROOT = join(REPO_ROOT, "packages", "hunk", "src");
const CORE_ROOT = join(SRC_ROOT, "core");
const EXTENSIONS_ROOT = join(SRC_ROOT, "extensions");
const BUNDLED_PROVIDER_ROOT = join(EXTENSIONS_ROOT, "default", "vcs");
const REVIEW_MODEL_ROOT = join(CORE_ROOT, "review");
// The published extension contract, which the review model may name for the annotation shapes
// that are simultaneously internal model types and part of `hunkdiff/extension`. It cannot widen
// the seam: `extension-api-is-import-free` (.dependency-cruiser.cjs) forbids it any import at
// all, so it can never carry a renderer or a platform runtime in. Only this one file is allowed,
// not the tree — `extension-api/index.ts` is the runtime boundary and imports freely.
const EXTENSION_API_TYPES_PATH = join(SRC_ROOT, "extension-api", "types.ts");
const REVIEW_PROTOCOL_PATH = join(SRC_ROOT, "session", "reviewProtocol.ts");
const REVIEW_DESCRIPTOR_PATH = join(CORE_ROOT, "reviewDescriptor.ts");
const WEB_CLIENT_ROOT = join(SRC_ROOT, "web");

// Session modules a browser bundle imports verbatim: the wire schema, the HTTP surface's
// addressing and authorization grammar, the SSE event contract, and the user-facing error
// catalog. Each may reach the shared review model and the browser-safe broker-core parsers
// and nothing else, and each is checked for a platform-free import closure — the C4 defect
// was precisely a contract declared on the server that a client then re-declared, so these
// files only pay for themselves if the client can really import them.
const BROWSER_SAFE_SESSION_MODULES: readonly string[] = [
  REVIEW_PROTOCOL_PATH,
  join(SRC_ROOT, "session", "reviewHttpProtocol.ts"),
  join(SRC_ROOT, "session", "reviewEventProtocol.ts"),
  join(SRC_ROOT, "session", "reviewErrorCatalog.ts"),
];

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

/**
 * Reads every module specifier one source file names: static imports and re-exports
 * (both carry `from`), dynamic `import(...)`, and side-effect-only `import "..."` — the
 * last matters most here, since a side-effect import is exactly how a renderer or
 * platform dependency could slip past a containment check unnamed.
 */
function importSpecifiers(path: string) {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/(?:from\s*|import\s*\(?\s*)["']([^"']+)["']/g)].map(
    (match) => match[1]!,
  );
}

/**
 * Reads the specifiers one file imports *for value*.
 *
 * `import type` and `export type` statements are erased before anything is bundled, so
 * they cannot drag a platform module into a browser build and must not constrain one —
 * the shared review model addresses `DiffFile` by type without depending on the tree it
 * lives in. Everything else counts, side-effect and dynamic imports included.
 */
function valueImportSpecifiers(path: string) {
  const source = readFileSync(path, "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /import\s*\(\s*["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g,
  )) {
    specifiers.push((match[1] ?? match[2])!);
  }
  for (const match of source.matchAll(
    /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']/g,
  )) {
    if (!match[2]) {
      specifiers.push(match[3]!);
    }
  }
  return specifiers;
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
  "packages/hunk/src/ui/lib/hunks.ts", // B1: replaced by core/review selection/move planning
];

// Function-level deletions the file tombstones cannot see: each entry bans one named
// symbol from the file that used to declare it, tagged with the audit finding whose
// primitive replaced it. Append-only, same contract as the file list — a matching
// declaration reappearing means the duplication came back.
const EXTRACTED_DUPLICATE_SYMBOLS: ReadonlyArray<{
  file: string;
  symbol: string;
  finding: string;
}> = [
  {
    file: "packages/hunk/src/ui/diff/diffRows.ts",
    symbol: "leadingCollapsedRanges",
    finding: "A1",
  },
  {
    file: "packages/hunk/src/ui/diff/diffRows.ts",
    symbol: "trailingCollapsedRanges",
    finding: "A1",
  },
  {
    file: "packages/hunk/src/ui/diff/diffRows.ts",
    symbol: "trailingCollapsedLines",
    finding: "A2",
  },
  { file: "packages/hunk/src/ui/diff/expandCollapsedRows.ts", symbol: "sliceLines", finding: "A4" },
  { file: "packages/hunk/src/ui/diff/expandCollapsedRows.ts", symbol: "gapKey", finding: "A1" },
  { file: "packages/hunk/src/core/liveComments.ts", symbol: "hunkLineRange", finding: "A3" },
  {
    file: "packages/hunk/src/core/liveComments.ts",
    symbol: "firstCommentTargetForHunk",
    finding: "A10",
  },
  { file: "packages/hunk/src/core/review/state.ts", symbol: "reviewLineAnchor", finding: "A3" },
  { file: "packages/hunk/src/ui/lib/files.ts", symbol: "filterReviewFiles", finding: "B5" },
  {
    file: "packages/hunk/src/ui/lib/reviewState.ts",
    symbol: "findNextAnnotatedFile",
    finding: "B2",
  },
  { file: "packages/hunk/src/ui/lib/reviewState.ts", symbol: "resolveSelectedFile", finding: "B4" },
  {
    file: "packages/hunk/src/ui/lib/agentAnnotations.ts",
    symbol: "alwaysShowReviewNote",
    finding: "B9",
  },
  {
    file: "packages/hunk/src/ui/diff/expandCollapsedRows.ts",
    symbol: "selectGapForKeyboardToggle",
    finding: "F2",
  },
  {
    file: "packages/hunk/src/ui/lib/agentAnnotations.ts",
    symbol: "annotationOverlapsHunk",
    finding: "B1",
  },
  {
    file: "packages/hunk/src/ui/lib/agentAnnotations.ts",
    symbol: "getAnnotatedHunkIndices",
    finding: "B1",
  },
  {
    file: "packages/hunk/src/ui/lib/reviewState.ts",
    symbol: "buildReviewAnnotationIndex",
    finding: "B1",
  },
  {
    file: "packages/hunk/src/extensions/cliCommandRuntime.ts",
    symbol: "validateReviewDescriptor",
    finding: "delegated-review-descriptor",
  },
  {
    file: "packages/hunk/src/extensions/cliCommandRuntime.ts",
    symbol: "validateDescriptorString",
    finding: "delegated-review-descriptor",
  },
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

  test("keeps extracted duplicate symbols deleted", () => {
    const resurrected = EXTRACTED_DUPLICATE_SYMBOLS.filter(({ file, symbol }) => {
      const path = join(REPO_ROOT, ...file.split("/"));
      if (!existsSync(path)) {
        return false;
      }
      return new RegExp(`\\b(?:function|const|let)\\s+${symbol}\\b`).test(
        readFileSync(path, "utf8"),
      );
    }).map(({ file, symbol, finding }) => `${file} -> ${symbol} (${finding})`);
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
  // Repaid in Phase 1 PR 2: `document.ts` and `identity.ts` landed platform-neutral (identity
  // hashing is plain arithmetic), and source identity is part of `identity.ts` with no path
  // handling at all, so those three entries are gone for good.
  // Repaid in Phase 2: the last entry, `jsonStream.ts`, is gone. Serializing and hashing a
  // review resource needs a platform encoder, so that work lives in the producer tier
  // (`packages/hunk/src/app/review/`) instead, and core takes hashing as an injected `ReviewDigestFn`
  // (`core/review/validation.ts`) — it names the algorithm, validates the digest shape, and
  // compares two values without ever computing one. The map is now empty and stays that way.
  const REVIEW_MODEL_NODE_DEBT = new Map<string, readonly string[]>();
  // The browser client renders with React and Pierre only; everything else must come from the
  // shared review model, the wire protocol, or the browser-safe broker-core parsers.
  const WEB_CLIENT_EXTERNALS = new Set([
    "react",
    "react-dom/client",
    "@pierre/diffs",
    "@pierre/diffs/react",
    "@pierre/trees",
    "@pierre/trees/react",
    "@hunk/session-broker-core",
  ]);

  /** Collect every module transitively reachable from the given files via value imports. */
  function reachableSourceFiles(rootFiles: readonly string[]) {
    const visited = new Set<string>();
    const queue = [...rootFiles];
    while (queue.length > 0) {
      const path = queue.pop()!;
      if (visited.has(path) || !/\.tsx?$/.test(path) || !existsSync(path)) {
        continue;
      }
      visited.add(path);
      for (const specifier of valueImportSpecifiers(path)) {
        const target = resolveImport(path, specifier);
        if (target) {
          queue.push(target);
        }
      }
    }
    return visited;
  }

  test("keeps the review model contained in core", () => {
    expect(escapingImports(REVIEW_MODEL_ROOT, [CORE_ROOT, EXTENSION_API_TYPES_PATH])).toEqual([]);
  });

  test("keeps rendering and platform runtimes out of the review model", () => {
    expect(
      unexpectedExternalImports(REVIEW_MODEL_ROOT, REVIEW_MODEL_EXTERNALS, REVIEW_MODEL_NODE_DEBT),
    ).toEqual([]);
  });

  test("keeps delegated review descriptor validation browser-safe", () => {
    const escapedImports = importSpecifiers(REVIEW_DESCRIPTOR_PATH).flatMap((specifier) => {
      const target = resolveImport(REVIEW_DESCRIPTOR_PATH, specifier);
      return target && !isWithin(EXTENSION_API_TYPES_PATH, target)
        ? [`${repoPath(REVIEW_DESCRIPTOR_PATH)} -> ${specifier}`]
        : [];
    });
    expect(escapedImports).toEqual([]);
    const violations = [...reachableSourceFiles([REVIEW_DESCRIPTOR_PATH])].flatMap((path) =>
      valueImportSpecifiers(path)
        .filter((specifier) => specifier.startsWith("node:") || specifier.startsWith("bun:"))
        .map((specifier) => `${repoPath(path)} -> ${specifier}`),
    );
    expect(violations).toEqual([]);
  });

  test("keeps the browser-safe session modules browser-safe", () => {
    const violations = BROWSER_SAFE_SESSION_MODULES.filter(existsSync).flatMap((path) =>
      importSpecifiers(path).flatMap((specifier) => {
        if (specifier.startsWith(".")) {
          const target = resolveImport(path, specifier);
          const allowed =
            target &&
            (isWithin(REVIEW_MODEL_ROOT, target) ||
              BROWSER_SAFE_SESSION_MODULES.some((module) => isWithin(module, target)));
          return allowed ? [] : [`${repoPath(path)} -> ${specifier}`];
        }
        // The broker-core package supplies shared limits and identifier parsing; it must stay
        // importable without Node-only side effects for the browser bundle.
        return specifier === "@hunk/session-broker-core"
          ? []
          : [`${repoPath(path)} -> ${specifier}`];
      }),
    );
    expect(violations).toEqual([]);
  });

  test("keeps the browser client on shared review primitives", () => {
    expect(unexpectedExternalImports(WEB_CLIENT_ROOT, WEB_CLIENT_EXTERNALS)).toEqual([]);
    expect(
      escapingImports(WEB_CLIENT_ROOT, [
        WEB_CLIENT_ROOT,
        REVIEW_MODEL_ROOT,
        ...BROWSER_SAFE_SESSION_MODULES,
      ]),
    ).toEqual([]);
  });

  // Direct-import checks alone would let the browser reach a Node-only module through an
  // intermediate re-export; walk the whole relative-import closure instead. This is what makes
  // the node-debt map's "a browser bundle must never import these until repaid" clause
  // mechanical rather than aspirational.
  test("keeps the browser-reachable module closure free of platform runtimes", () => {
    const roots = [...sourceFiles(WEB_CLIENT_ROOT), ...BROWSER_SAFE_SESSION_MODULES];
    const violations = [...reachableSourceFiles(roots)].flatMap((path) =>
      valueImportSpecifiers(path)
        .filter((specifier) => specifier.startsWith("node:") || specifier.startsWith("bun:"))
        .map((specifier) => `${repoPath(path)} -> ${specifier}`),
    );
    expect(violations).toEqual([]);
  });
});
