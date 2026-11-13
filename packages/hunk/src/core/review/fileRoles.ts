/**
 * Classifies a reviewed file by the role its path suggests: source, tests, docs, generated
 * output, or configuration.
 *
 * The policy reads the path alone, so every surface — the browser's Overview, and later
 * `hunk session` and the terminal — classifies a file the same way without reading content.
 * It is a heuristic for weighing a review, never a filter on what is shown. When several rules
 * match, the first in this order wins, because each is more specific about intent than the
 * next:
 *
 * 1. **generated** — lockfiles (`package-lock.json`, `bun.lock`, `Cargo.lock`, `go.sum`, …),
 *    minified bundles and source maps (`*.min.js`, `*.min.css`, `*.map`), snapshot files
 *    (`*.snap`), files whose name says so (`*.generated.*`, `*.g.dart`, `*.pb.go`, `*_pb2.py`),
 *    and anything under a `dist/`, `build/`, `generated/`, `__generated__/`, or `vendor/`
 *    directory. A reviewer rarely reads these line by line.
 * 2. **test** — anything under a `test/`, `tests/`, `__tests__/`, `spec/`, `e2e/`, or
 *    `testdata/` directory, and names like `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`.
 * 3. **docs** — Markdown and other prose (`.md`, `.mdx`, `.rst`, `.adoc`, `.txt`), anything
 *    under `docs/` or `doc/`, and `README`, `CHANGELOG`, `LICENSE`, `CONTRIBUTING` files.
 * 4. **config** — dotfiles and anything under a dot-directory (`.github/`, `.vscode/`), data
 *    and settings formats (`.json`, `.yaml`, `.yml`, `.toml`, `.ini`, `.cfg`, `.conf`, `.env`),
 *    `*.config.*` and `tsconfig*.json`, and build files (`Makefile`, `Dockerfile`, …).
 * 5. **source** — everything else.
 *
 * "Meaningful" change excludes tests, docs, and generated files: configuration changes what
 * the software does, so it stays in.
 */

/** The role one reviewed file's path suggests. */
export type ReviewFileRole = "source" | "test" | "docs" | "generated" | "config";

/** Every role, in the order a summary lists them. */
export const REVIEW_FILE_ROLES: readonly ReviewFileRole[] = [
  "source",
  "test",
  "docs",
  "generated",
  "config",
];

/** Roles whose changes count toward the review's meaningful totals. */
export const REVIEW_MEANINGFUL_FILE_ROLES: ReadonlySet<ReviewFileRole> = new Set([
  "source",
  "config",
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "podfile.lock",
  "packages.lock.json",
]);
const GENERATED_DIRECTORIES = new Set(["dist", "build", "generated", "__generated__", "vendor"]);
const GENERATED_NAME =
  /(\.min\.(js|css|mjs)|\.map|\.snap|\.generated\.[^.]+|\.g\.dart|\.pb\.go|_pb2\.py|_pb2_grpc\.py)$/;

const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__", "spec", "e2e", "testdata"]);
const TEST_NAME = /(\.(test|spec)\.[^.]+$|_test\.[^.]+$|^test_[^/]*\.py$)/;

const DOC_DIRECTORIES = new Set(["docs", "doc"]);
const DOC_EXTENSION = /\.(md|mdx|markdown|rst|adoc|txt)$/;
const DOC_NAME = /^(readme|changelog|license|licence|contributing|authors|notice)(\.|$)/;

const CONFIG_EXTENSION = /\.(json|jsonc|ya?ml|toml|ini|cfg|conf|env|properties)$/;
const CONFIG_NAME =
  /(\.config\.[^.]+$|^tsconfig[^/]*\.json$|^(makefile|dockerfile|justfile|procfile|containerfile)$)/;

/** Decide the role one path suggests; see the module header for the policy. */
export function reviewFileRole(path: string): ReviewFileRole {
  const segments = path.split("/").filter(Boolean);
  const name = (segments.at(-1) ?? "").toLowerCase();
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase());

  if (
    LOCKFILES.has(name) ||
    GENERATED_NAME.test(name) ||
    directories.some((segment) => GENERATED_DIRECTORIES.has(segment))
  ) {
    return "generated";
  }
  if (TEST_NAME.test(name) || directories.some((segment) => TEST_DIRECTORIES.has(segment))) {
    return "test";
  }
  if (
    DOC_EXTENSION.test(name) ||
    DOC_NAME.test(name) ||
    directories.some((segment) => DOC_DIRECTORIES.has(segment))
  ) {
    return "docs";
  }
  if (
    name.startsWith(".") ||
    directories.some((segment) => segment.startsWith(".")) ||
    CONFIG_EXTENSION.test(name) ||
    CONFIG_NAME.test(name)
  ) {
    return "config";
  }
  return "source";
}
