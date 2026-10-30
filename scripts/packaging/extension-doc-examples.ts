/**
 * Turn the TypeScript examples in `docs/extensions.md` into compilable modules.
 *
 * The authoring guide is the contract most extension authors actually read, so
 * an example that does not typecheck is a bug in the published surface even
 * when the surface itself is fine — `syntax_scopes` for `syntaxScopes`, a
 * `readFileSource` that forgets to be async. Checking the examples against the
 * built package is what keeps the guide honest.
 *
 * Most examples are fragments rather than whole files: an object property, a
 * method body, a bare `hunk.` call. Each one is wrapped in the smallest context
 * that gives it its real type, so what gets compiled is the example's own text
 * plus scaffolding — never a rewrite of the example.
 */

/** One doc example, prepared as a standalone module. */
export interface DocExample {
  /** Source file name, derived from the example's position in the document. */
  name: string;
  /** Full module text: shared preamble, then the wrapped example. */
  text: string;
  /** How the example had to be wrapped, for diagnostics. */
  wrapper: "module" | "factory-body" | "vcs-operation" | "patch-result";
}

/**
 * Declarations the examples lean on without defining.
 *
 * The guide elides helpers like `runHgDiff` to keep examples about the API, so
 * they are declared here with the types the surrounding example implies.
 * `hunk`, the one declaration that matters, is typed as the real API object —
 * every API misuse in an example still has to be a compile error.
 */
const EXAMPLE_PREAMBLE = `
// Every imported name is aliased under a reserved prefix so it cannot collide
// with the imports an example brings of its own.
import type {
  ExtensionVcsDiffInput as __HunkDiffInput,
  ExtensionVcsOperation as __HunkOperation,
  ExtensionVcsPatchResult as __HunkPatchResult,
  HunkExtensionAPI as __HunkApi,
} from "hunkdiff/extension";

declare const hunk: __HunkApi;
declare function runHgDiff(cwd: string): Promise<string>;
declare function listHgUnknownFiles(cwd: string): Promise<string[]>;
declare function hgCat(rev: string, path: string): Promise<string>;
declare function hgDiffOneFile(path: string): Promise<string>;
declare function resolveHgRevisions(
  input: __HunkDiffInput,
  cwd: string,
): Promise<[string, string]>;
declare function formatDocument(path: string): Promise<string>;
declare function existsSync(path: string): boolean;
declare function join(...parts: string[]): string;
declare function detect(cwd: string): { id: string; repoRoot: string } | null;
declare const oldRev: string;
declare const newRev: string;
`;

/** Extract the body of every ` + "```ts" + ` fenced block, in document order. */
export function extractTypeScriptBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /^```ts[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

  for (const match of markdown.matchAll(pattern)) {
    const body = match[1];
    if (body !== undefined && body.trim().length > 0) {
      blocks.push(body);
    }
  }

  return blocks;
}

/**
 * Decide the smallest context one block needs to compile.
 *
 * The classification is deliberately explicit rather than clever: there are
 * only a few fragment shapes in the guide, and a wrong guess should read as an
 * obviously wrong wrapper rather than a mysterious type error.
 */
function classifyBlock(block: string): DocExample["wrapper"] {
  const trimmed = block.trim();

  // A block that imports or default-exports is already a whole extension file.
  if (/^import\b/.test(trimmed) || /^export default\b/m.test(trimmed)) {
    return "module";
  }

  // Fragments lifted out of an `ExtensionVcsPatchResult` literal.
  if (/^extraFiles\s*:/.test(trimmed)) {
    return "patch-result";
  }

  // Fragments lifted out of an `ExtensionVcsOperation` literal.
  if (/^(?:async\s+load\s*\(|watchSignature\s*:|watchPlan\s*:)/.test(trimmed)) {
    return "vcs-operation";
  }

  return "factory-body";
}

/** Drop a trailing statement semicolon so a fragment can sit inside an object literal. */
function asObjectMember(block: string) {
  return block.trim().replace(/;$/, "");
}

/** Wrap one block in the context its shape implies. */
function wrapBlock(block: string, wrapper: DocExample["wrapper"]) {
  switch (wrapper) {
    case "module":
      return block;
    case "factory-body":
      return `export function __example() {\n${block}\n}\n`;
    case "vcs-operation":
      return (
        "export const __operation: Partial<__HunkOperation<__HunkDiffInput>> = {\n" +
        `${asObjectMember(block)}\n};\n`
      );
    case "patch-result":
      return (
        "export const __result: Pick<__HunkPatchResult, 'extraFiles'> = {\n" +
        `${asObjectMember(block)}\n};\n`
      );
  }
}

/**
 * Build a compilable module for every TypeScript example in the guide.
 *
 * Blocks that are pure prose fixtures — a shell transcript fenced as `ts`, say —
 * do not occur today; every block is treated as real code on purpose, so a new
 * example cannot be added without it having to compile.
 */
export function buildDocExamples(markdown: string): DocExample[] {
  return extractTypeScriptBlocks(markdown).map((block, index) => {
    const wrapper = classifyBlock(block);
    return {
      name: `doc-example-${String(index + 1).padStart(2, "0")}.ts`,
      text: `${EXAMPLE_PREAMBLE}\n${wrapBlock(block, wrapper)}`,
      wrapper,
    };
  });
}
