/**
 * Captures repository extension modules without evaluating them and stores approved bundles.
 * Literal dependencies travel with their entry; runtime module resolution outside that graph is
 * refused. This is an approval boundary, not a sandbox for code the user deliberately approves.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveFilesystemModulePath } from "./installedPackageResolution";
import type { ModuleSpecifierKind } from "./moduleSpecifiers";
import { readSnapshotAliasConfig, snapshotAliasTargets } from "./snapshotAliases";
import { parse } from "@babel/parser";
import { resolveAppStatePath, resolveCanonicalPath } from "../core/run/paths";
import {
  HOST_MODULE_SPECIFIERS,
  rewriteCompiledHostRequires,
  rewriteHostSpecifiers,
} from "./hostRuntimeModules";
import type {
  ExtensionCandidate,
  RepoExtensionSnapshot,
  RepoExtensionSnapshotEntry,
} from "./types";
export type { RepoExtensionSnapshot } from "./types";

export interface RepoSnapshotOptions {
  env?: NodeJS.ProcessEnv;
  statePath?: string;
}

const MAX_INPUT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_FILES = 256;
const MAX_ENTRIES = 64;

interface SnapshotInputBudget {
  files: Map<string, number>;
  bytes: number;
}

const hostModules = new Set(HOST_MODULE_SPECIFIERS);
const runtimeModules = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "bun",
]);

/** Hash captured bytes rather than mutable filesystem names. */
function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

/** Read bounded regular files so preparation never blocks on devices or allocates unchecked input. */
function readSnapshotInput(
  path: string,
  budget?: SnapshotInputBudget,
  limit = MAX_INPUT_FILE_BYTES,
) {
  if (!statSync(path).isFile()) throw new Error(`Snapshot input must be a regular file: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Snapshot input must be a regular file: ${path}`);
    if (stat.size > limit)
      throw new Error(`Snapshot input exceeds its ${limit}-byte limit: ${path}`);
    if (budget) {
      const previousSize = budget.files.get(path);
      if (previousSize !== undefined && previousSize !== stat.size)
        throw new Error("Repository extension inputs changed during capture; restart Hunk.");
      if (previousSize === undefined) {
        if (budget.files.size >= MAX_INPUT_FILES || budget.bytes + stat.size > MAX_INPUT_BYTES)
          throw new Error(
            "Repository extension snapshot exceeds its input budget (256 files / 16 MiB).",
          );
        budget.files.set(path, stat.size);
        budget.bytes += stat.size;
      }
    }

    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!bytes) break;
      offset += bytes;
    }
    if (offset !== stat.size)
      throw new Error("Repository extension inputs changed during capture; restart Hunk.");
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** Walk syntax nodes without evaluating repository code or loading repository plugins. */
function walk(
  node: { type: string },
  visit: (node: Record<string, unknown>, parent?: Record<string, unknown>) => void,
  parent?: Record<string, unknown>,
) {
  const record = node as unknown as Record<string, unknown>;
  visit(record, parent);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && typeof child.type === "string")
          walk(child, visit, record);
      }
    } else if (value && typeof value === "object" && "type" in value) {
      walk(value as { type: string }, visit, record);
    }
  }
}

/** Refuse module loads the bundler cannot capture, including aliased CommonJS loaders. */
function validateModuleResolution(code: string, path: string) {
  const tree = parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    createImportExpressions: true,
    plugins: [
      "estree",
      "importAttributes",
      "deprecatedImportAssert",
      ...(/\.[mc]?ts$/i.test(path)
        ? ["typescript" as const]
        : ["typescript" as const, "jsx" as const]),
    ],
  });
  for (const comment of tree.comments ?? []) {
    for (const match of comment.value.matchAll(/@jsxImportSource\s+(\S+)/g)) {
      if (match[1] !== "react" && match[1] !== "@opentui/react") {
        throw new Error(
          `Repository extension ${path} must use a host-owned JSX import source (react or @opentui/react).`,
        );
      }
    }
  }
  walk(tree, (node, parent) => {
    const attributes = (node.attributes ?? node.assertions) as unknown[] | undefined;
    if (
      attributes?.length &&
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration")
    ) {
      throw new Error(
        `Repository extension ${path} uses import attributes/macros; snapshot preparation must not execute code.`,
      );
    }
    const source = (node.type === "TSExternalModuleReference" ? node.expression : node.source) as
      | Record<string, unknown>
      | undefined;
    const callee = node.callee as Record<string, unknown> | undefined;
    const args =
      node.type === "CallExpression" && callee?.type === "Identifier" && callee.name === "require"
        ? (node.arguments as Array<Record<string, unknown>>)
        : undefined;
    if (
      (typeof source?.value === "string" && /^macro:/i.test(source.value)) ||
      (typeof args?.[0]?.value === "string" && /^macro:/i.test(args[0].value))
    ) {
      throw new Error(`Repository extension ${path} uses a compile-time macro.`);
    }
    if (
      source?.value === "node:module" ||
      source?.value === "module" ||
      args?.[0]?.value === "node:module" ||
      args?.[0]?.value === "module"
    ) {
      throw new Error(`Repository extension ${path} uses node:module runtime resolvers.`);
    }
    if (node.type === "ImportExpression") {
      if (node.options)
        throw new Error(`Repository extension ${path} uses runtime import attributes.`);
      const source = node.source as Record<string, unknown>;
      if (source.type !== "Literal" || typeof source.value !== "string") {
        throw new Error(
          `Repository extension ${path} uses a computed import; use a literal bundled dependency.`,
        );
      }
    }
    if (node.type === "Identifier" && node.name === "require") {
      if (
        (parent?.type === "Property" || parent?.type === "ObjectProperty") &&
        parent.key === node &&
        !parent.computed &&
        !parent.shorthand
      )
        return;
      const args = parent?.arguments as Array<Record<string, unknown>> | undefined;
      if (
        parent?.type !== "CallExpression" ||
        parent.callee !== node ||
        args?.length !== 1 ||
        args[0]?.type !== "Literal" ||
        typeof args[0].value !== "string"
      ) {
        throw new Error(
          `Repository extension ${path} uses a runtime require resolver; use a literal bundled dependency.`,
        );
      }
    }
    if (node.type === "MemberExpression") {
      const property = node.property as Record<string, unknown>;
      if (property.name === "require" || property.value === "require") {
        throw new Error(`Repository extension ${path} uses a runtime require resolver.`);
      }
    }
  });
}

/** Attest bounded config bytes, including every extended resolver input. */
function readCapturedConfig(
  path: string,
  sources: Map<string, string>,
  budget: SnapshotInputBudget,
) {
  const canonical = resolveCanonicalPath(path);
  const bytes = readSnapshotInput(canonical, budget);
  const hash = digest(bytes);
  const prior = sources.get(canonical);
  if (prior && prior !== hash)
    throw new Error("Repository extension inputs changed during capture; restart Hunk.");
  sources.set(canonical, hash);
  return bytes.toString("utf8");
}

/** Capture resolver configuration as inert bytes, including package and alias directives. */
function captureResolverInputs(
  path: string,
  sources: Map<string, string>,
  budget: SnapshotInputBudget,
) {
  let directory = dirname(path);
  for (;;) {
    for (const name of ["package.json", "tsconfig.json", "jsconfig.json"]) {
      const input = join(directory, name);
      if (existsSync(input)) {
        if (!statSync(input).isFile())
          throw new Error(`Snapshot resolver input must be a regular file: ${input}`);
        const canonical = resolveCanonicalPath(input);
        if (!sources.has(canonical)) readCapturedConfig(canonical, sources, budget);
        if (name !== "package.json")
          readSnapshotAliasConfig(canonical, (path) => readCapturedConfig(path, sources, budget));
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

/** Bound package/alias metadata before the native resolver reads a dependency's manifest. */
function capturePackageInputs(
  specifier: string,
  importer: string,
  sources: Map<string, string>,
  budget: SnapshotInputBudget,
) {
  if (isAbsolute(specifier) || specifier.startsWith(".") || specifier.includes(":")) return;
  const segments = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  const name = segments.slice(0, nameLength).join("/");
  let directory = dirname(importer);
  for (;;) {
    const packageRoot = join(directory, "node_modules", name);
    if (existsSync(packageRoot) && statSync(packageRoot).isDirectory()) {
      captureResolverInputs(
        join(packageRoot, ...segments.slice(nameLength), "__snapshot_resolve__.js"),
        sources,
        budget,
      );
      return packageRoot;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Resolve relative files afresh so Bun's process-wide resolver cache cannot hide symlink changes. */
function resolveSnapshotDependency(
  specifier: string,
  importer: string,
  sources: Map<string, string>,
  budget: SnapshotInputBudget,
  kind: ModuleSpecifierKind,
) {
  if (isAbsolute(specifier) || specifier.startsWith("./") || specifier.startsWith("../")) {
    const path = resolve(dirname(importer), specifier);
    const paths = [
      path,
      ...[".tsx", ".ts", ".jsx", ".js", ".json", ".mts", ".mjs", ".cts", ".cjs"].map(
        (extension) => `${path}${extension}`,
      ),
    ];
    const replacement = { ".js": ".ts", ".jsx": ".tsx", ".mjs": ".mts", ".cjs": ".cts" }[
      extname(path)
    ];
    if (replacement) paths.push(path.slice(0, -extname(path).length) + replacement);
    for (const candidate of paths) {
      if (existsSync(candidate) && statSync(candidate).isFile())
        return resolveCanonicalPath(candidate);
    }
    if (existsSync(path)) {
      if (!statSync(path).isDirectory())
        throw new Error(`Snapshot input must be a regular file: ${path}`);
      captureResolverInputs(join(path, "__snapshot_resolve__.js"), sources, budget);
      const resolved = resolveFilesystemModulePath(
        resolveCanonicalPath(path),
        importer,
        kind,
        (path) => readCapturedConfig(path, sources, budget),
      );
      if (!resolved) throw new Error(`Cannot resolve snapshot dependency: ${specifier}`);
      return resolveCanonicalPath(resolved);
    }
  }
  const resolved = resolveFilesystemModulePath(specifier, importer, kind, (path) =>
    readCapturedConfig(path, sources, budget),
  );
  if (!resolved) throw new Error(`Cannot resolve snapshot dependency: ${specifier}`);
  return resolveCanonicalPath(resolved);
}

/** Build one closed module graph, keeping only host APIs and runtime builtins external. */
async function bundleEntry(candidate: ExtensionCandidate, budget: SnapshotInputBudget) {
  const sources = new Map<string, string>();
  // Reject unsafe extended configs before Bun can inspect any entrypoint metadata.
  captureResolverInputs(candidate.path, sources, budget);
  const result = await Bun.build({
    entrypoints: [resolveCanonicalPath(candidate.path)],
    root: dirname(resolveCanonicalPath(candidate.path)),
    target: "bun",
    format: "esm",
    splitting: false,
    sourcemap: "none",
    packages: "bundle",
    plugins: [
      {
        name: "hunk-repo-extension-snapshot",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.path === "module" || args.path === "node:module") {
              throw new Error(
                "Repository extension snapshots do not support node:module runtime resolvers.",
              );
            }
            if (hostModules.has(args.path) || runtimeModules.has(args.path))
              return { path: args.path, external: true };
            if (!isAbsolute(args.path) && /^[a-z][a-z\d+.-]*:/i.test(args.path)) {
              throw new Error(`Unsupported repository extension import: ${args.path}`);
            }
            // Resolve filenames only. A private namespace keeps repository loader settings/macros
            // out of Bun's file pipeline; every executable module passes our parser first.
            captureResolverInputs(args.importer || candidate.path, sources, budget);
            capturePackageInputs(args.path, args.importer || candidate.path, sources, budget);
            const kind: ModuleSpecifierKind = args.kind.startsWith("require")
              ? "require"
              : args.kind === "dynamic-import"
                ? "dynamic-import"
                : "import";
            if (
              !isAbsolute(args.path) &&
              !args.path.startsWith(".") &&
              !args.path.startsWith("#")
            ) {
              const targets = snapshotAliasTargets(
                args.path,
                args.importer || candidate.path,
                (path) => readCapturedConfig(path, sources, budget),
              );
              for (const target of targets) {
                try {
                  const path = resolveSnapshotDependency(
                    target,
                    args.importer || candidate.path,
                    sources,
                    budget,
                    kind,
                  );
                  return { path, namespace: "hunk-repo-snapshot" };
                } catch (error) {
                  // Only absent path targets may fall back; bounded-capture failures remain fatal.
                  const code = (error as NodeJS.ErrnoException).code;
                  const message = error instanceof Error ? error.message : String(error);
                  if (
                    code !== "ENOENT" &&
                    code !== "ENOTDIR" &&
                    !message.startsWith("Can't resolve ") &&
                    !message.startsWith("Cannot resolve snapshot dependency:")
                  )
                    throw error;
                }
              }
            }
            const path = resolveSnapshotDependency(
              args.path,
              args.importer || candidate.path,
              sources,
              budget,
              kind,
            );
            return { path, namespace: "hunk-repo-snapshot" };
          });
          build.onLoad({ filter: /.*/, namespace: "hunk-repo-snapshot" }, (args) => {
            const path = resolveCanonicalPath(args.path);
            if (!/\.(?:[mc]?[jt]s|[jt]sx|json)$/i.test(path))
              throw new Error(`Unsupported snapshot dependency: ${path}`);
            const bytes = readSnapshotInput(path, budget);
            const contents = bytes.toString("utf8");
            const inputDigest = digest(bytes);
            const priorDigest = sources.get(path);
            if (priorDigest && priorDigest !== inputDigest)
              throw new Error("Repository extension inputs changed during capture; restart Hunk.");
            sources.set(path, inputDigest);
            captureResolverInputs(path, sources, budget);
            if (extname(path).toLowerCase() === ".json") return { contents, loader: "json" };
            // Validate original TS/JS before transpiling: Bun macros can execute during transforms.
            validateModuleResolution(contents, path);
            const loader = /\.tsx$/i.test(path) ? "tsx" : /\.[mc]?ts$/i.test(path) ? "ts" : "jsx";
            const code = new Bun.Transpiler({
              loader,
              autoImportJSX: true,
              macro: {},
              tsconfig: JSON.stringify({
                compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
              }),
            }).transformSync(contents);
            validateModuleResolution(code, path);
            return { contents: code, loader: "js" };
          });
        },
      },
    ],
  }).catch((error: unknown) => {
    if (error instanceof AggregateError) {
      const details = error.errors
        .map((issue: unknown) => (issue instanceof Error ? issue.message : String(issue)))
        .join("; ");
      throw new Error(`Snapshot preparation failed: ${details}`, { cause: error });
    }
    throw error;
  });
  if (!result.success)
    throw new AggregateError(
      result.logs,
      `Snapshot preparation failed: ${result.logs.map(String).join("; ")}`,
    );
  if (result.outputs.length !== 1)
    throw new Error("Repository extension must produce one self-contained JavaScript bundle.");
  const code = rewriteHostSpecifiers(rewriteCompiledHostRequires(await result.outputs[0]!.text()));
  for (const dependency of new Bun.Transpiler({ loader: "js" }).scanImports(code)) {
    const hostSpecifier = dependency.path.replace(/^hunk-host:/, "");
    if (
      !runtimeModules.has(dependency.path) &&
      !(dependency.path.startsWith("hunk-host:") && hostModules.has(hostSpecifier))
    ) {
      throw new Error(`Snapshot left an unresolved runtime dependency: ${dependency.path}`);
    }
  }
  return { code, sources: [...sources].sort(([a], [b]) => a.localeCompare(b)) };
}

/** Capture all enabled repository entries and their dependencies without importing any of them. */
export async function prepareRepoExtensionSnapshot(
  repoRoot: string,
  candidates: readonly ExtensionCandidate[],
): Promise<RepoExtensionSnapshot> {
  const repoCandidates = candidates.filter((entry) => entry.origin === "repo");
  if (repoCandidates.length > MAX_ENTRIES)
    throw new Error("Repository extension snapshot exceeds its 64-entry limit.");
  const entries: RepoExtensionSnapshotEntry[] = [];
  const graphs = [];
  const inputs = new Map<string, string>();
  const budget: SnapshotInputBudget = { files: new Map(), bytes: 0 };
  let outputBytes = 0;
  for (const candidate of repoCandidates) {
    const { code, sources } = await bundleEntry(candidate, budget);
    outputBytes += Buffer.byteLength(code);
    if (outputBytes > MAX_OUTPUT_BYTES)
      throw new Error("Repository extension snapshot exceeds its 32 MiB output limit.");
    entries.push({ candidate: { ...candidate }, code, digest: digest(code) });
    for (const [path, inputDigest] of sources) {
      const prior = inputs.get(path);
      if (prior && prior !== inputDigest)
        throw new Error("Repository extension inputs changed during capture; restart Hunk.");
      inputs.set(path, inputDigest);
    }
    graphs.push({
      candidate: { ...candidate, path: resolveCanonicalPath(candidate.path) },
      sources,
      digest: digest(code),
    });
  }
  const canonicalRoot = resolveCanonicalPath(repoRoot);
  return {
    version: 1,
    repoRoot: canonicalRoot,
    fingerprint: digest(JSON.stringify({ version: 1, repoRoot: canonicalRoot, graphs })),
    entries,
    inputs: [...inputs]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, digest]) => ({ path, digest })),
  };
}

/** Locate user-owned approval artifacts outside the checkout that supplies executable input. */
function snapshotDirectory(snapshot: RepoExtensionSnapshot, options: RepoSnapshotOptions) {
  const statePath = options.statePath ?? resolveAppStatePath(options.env ?? process.env);
  if (!statePath)
    throw new Error("Could not resolve the Hunk state path because HOME/XDG_CONFIG_HOME is unset.");
  const root = resolveCanonicalPath(dirname(statePath));
  const repoRelative = relative(snapshot.repoRoot, root);
  if (
    repoRelative === "" ||
    (!isAbsolute(repoRelative) &&
      repoRelative !== ".." &&
      !repoRelative.startsWith("../") &&
      !repoRelative.startsWith("..\\"))
  ) {
    throw new Error(
      "Repository extension snapshots must be stored outside the repository under review.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(snapshot.fingerprint))
    throw new Error("Invalid snapshot fingerprint.");
  const storageRoot = join(root, "extension-snapshots");
  const directory = join(storageRoot, snapshot.fingerprint);
  for (const path of [storageRoot, directory]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error("Snapshot storage must not contain symlinks.");
  }
  return directory;
}

/** Publish captured bytes once; never overwrite an existing content-addressed artifact. */
export function persistRepoExtensionSnapshot(
  snapshot: RepoExtensionSnapshot,
  options: RepoSnapshotOptions = {},
) {
  const budget: SnapshotInputBudget = { files: new Map(), bytes: 0 };
  for (const input of snapshot.inputs) {
    if (!existsSync(input.path) || digest(readSnapshotInput(input.path, budget)) !== input.digest) {
      throw new Error(
        "Repository extension inputs changed since capture; restart Hunk to review the current snapshot.",
      );
    }
  }
  const directory = snapshotDirectory(snapshot, options);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink())
    throw new Error("Snapshot directory must not be a symlink.");
  for (const entry of snapshot.entries) {
    const path = join(directory, `${entry.digest}.mjs`);
    if (digest(entry.code) !== entry.digest)
      throw new Error("Snapshot bytes changed before approval.");
    if (!existsSync(path)) writeFileSync(path, entry.code, { flag: "wx", mode: 0o400 });
    verifySnapshotEntry(path, entry.digest);
  }
}

/** Read and verify a stored artifact before the loader receives its path. */
function verifySnapshotEntry(path: string, expectedDigest: string) {
  if (
    !lstatSync(path).isFile() ||
    lstatSync(path).isSymbolicLink() ||
    digest(readSnapshotInput(path, undefined, MAX_OUTPUT_BYTES)) !== expectedDigest
  ) {
    throw new Error(`Repository extension snapshot failed integrity verification: ${path}`);
  }
}

/** Resolve an approved entry to immutable storage, never to its live checkout source. */
export function resolveRepoSnapshotEntry(
  snapshot: RepoExtensionSnapshot,
  candidate: ExtensionCandidate,
  options: RepoSnapshotOptions = {},
) {
  const entry = snapshot.entries.find(
    (entry) => entry.candidate.id === candidate.id && entry.candidate.path === candidate.path,
  );
  if (!entry) throw new Error("Repository extension is missing from its approved snapshot.");
  const path = join(snapshotDirectory(snapshot, options), `${entry.digest}.mjs`);
  verifySnapshotEntry(path, entry.digest);
  return path;
}
