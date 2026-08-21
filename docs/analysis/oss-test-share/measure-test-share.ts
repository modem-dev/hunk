/**
 * Counts source vs test code lines across a repo tree.
 *
 * Test code = files in test-ish paths/names, plus inline test blocks in Zig
 * (`test "..." {}`) and Rust (`#[cfg(test)] mod`, `#[test] fn`), which those
 * ecosystems put directly inside source files.
 * Lines counted are non-blank, non-comment-only lines.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep, basename, extname } from "node:path";

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".zig", ".rs", ".go", ".swift",
  ".c", ".h", ".cpp", ".cc", ".hpp", ".m", ".mm",
  ".py", ".vue", ".svelte",
]);

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", "zig-out",
  ".zig-cache", "vendor", "third_party", "vendored", ".next", ".turbo",
  "coverage", ".venv", "venv", "__pycache__", ".moon", ".sst", "generated", "stb",
]);

const TEST_DIR_NAMES = new Set([
  "test", "tests", "__tests__", "__test__", "spec", "__mocks__",
  "testdata", "test-data", "e2e", "integration-tests",
]);

function isTestPath(rel: string): boolean {
  const parts = rel.split(sep);
  const file = basename(rel);
  if (parts.slice(0, -1).some((p) => TEST_DIR_NAMES.has(p.toLowerCase()))) return true;
  if (/(^|[.\-_])(test|tests|spec|specs)([.\-_]|$)/i.test(file.replace(extname(file), ""))) return true;
  if (/(Tests?|Spec)\.(swift|kt|java)$/.test(file)) return true;
  return false;
}

function isSkippedFile(rel: string): boolean {
  const file = basename(rel);
  if (file.endsWith(".d.ts")) return true;
  if (file.endsWith(".min.js") || file.endsWith(".min.css")) return true;
  if (/\.(gen|generated)\.[a-z]+$/.test(file)) return true;
  return false;
}

/** Counts non-blank, non-comment-only lines. */
function codeLines(lines: string[]): number {
  let n = 0;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("//") || l.startsWith("/*") || l.startsWith("*") || l.startsWith("*/")) continue;
    if (l.startsWith("#") && !l.startsWith("#[") && !l.startsWith("#!")) continue;
    n++;
  }
  return n;
}

/** Returns [sourceLines, testLines] for a Zig file, splitting out inline `test` blocks. */
function splitZig(lines: string[]): [number, number] {
  return splitBlocks(lines, (l) => /^\s*test\b.*\{\s*$/.test(l) || /^\s*test\s*\{/.test(l));
}

/** Returns [sourceLines, testLines] for a Rust file, splitting out `#[cfg(test)]`/`#[test]` blocks. */
function splitRust(lines: string[]): [number, number] {
  const starts = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*#\[cfg\(test\)\]/.test(l) || /^\s*#\[(tokio::)?test\b/.test(l) || /^\s*#\[rstest\b/.test(l)) {
      starts.add(i);
    }
  }
  return splitBlocks(lines, (_l, i) => starts.has(i));
}

/** Splits a file into source/test lines by brace-matching from each block start. */
function splitBlocks(
  lines: string[],
  isStart: (line: string, index: number) => boolean,
): [number, number] {
  const isTest = new Array(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!isStart(lines[i], i)) {
      i++;
      continue;
    }
    // Walk forward to the first `{`, then brace-match to its close.
    let depth = 0;
    let opened = false;
    let j = i;
    for (; j < lines.length; j++) {
      isTest[j] = true;
      for (const ch of stripStringsAndComments(lines[j])) {
        if (ch === "{") { depth++; opened = true; }
        else if (ch === "}") depth--;
      }
      if (opened && depth <= 0) break;
    }
    i = j + 1;
  }
  const src: string[] = [];
  const tst: string[] = [];
  lines.forEach((l, idx) => (isTest[idx] ? tst : src).push(l));
  return [codeLines(src), codeLines(tst)];
}

/** Removes string/char literals and line comments so brace counting is not fooled. */
function stripStringsAndComments(line: string): string {
  let out = "";
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "/" && line[i + 1] === "/") break;
    out += c;
  }
  return out;
}

export type Result = {
  sourceLines: number;
  testLines: number;
  sourceFiles: number;
  testFiles: number;
  byLang: Record<string, { source: number; test: number }>;
  topSource: [string, number][];
};

export function measure(root: string, opts: { include?: (rel: string) => boolean } = {}): Result {
  const r: Result = { sourceLines: 0, testLines: 0, sourceFiles: 0, testFiles: 0, byLang: {}, topSource: [] };
  const perFile: [string, number][] = [];

  const walk = (dir: string, rel: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const name = e.name;
      const childRel = rel ? join(rel, name) : name;
      const child = join(dir, name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(child, childRel);
        continue;
      }
      const ext = extname(name);
      if (!CODE_EXT.has(ext)) continue;
      if (isSkippedFile(childRel)) continue;
      if (opts.include && !opts.include(childRel)) continue;
      let text: string;
      try {
        if (statSync(child).size > 4_000_000) continue;
        text = readFileSync(child, "utf8");
      } catch { continue; }
      const lines = text.split("\n");
      // Skip machine-generated files: they are neither hand-written source nor tests.
      if (/generated by|DO NOT EDIT|@generated|auto-generated/i.test(lines.slice(0, 6).join("\n"))) continue;
      const lang = ext.slice(1);
      r.byLang[lang] ??= { source: 0, test: 0 };

      if (isTestPath(childRel)) {
        const n = codeLines(lines);
        r.testLines += n;
        r.testFiles += n > 0 ? 1 : 0;
        r.byLang[lang].test += n;
        continue;
      }
      let src: number, tst: number;
      if (ext === ".zig") [src, tst] = splitZig(lines);
      else if (ext === ".rs") [src, tst] = splitRust(lines);
      else { src = codeLines(lines); tst = 0; }
      r.sourceLines += src;
      r.testLines += tst;
      if (src > 0) r.sourceFiles++;
      if (tst > 0) r.testFiles++;
      r.byLang[lang].source += src;
      r.byLang[lang].test += tst;
      perFile.push([childRel, src]);
    }
  };
  walk(root, "");
  r.topSource = perFile.sort((a, b) => b[1] - a[1]).slice(0, 12);
  return r;
}

if (import.meta.main) {
  const root = process.argv[2];
  const res = measure(root);
  console.log(JSON.stringify(res, null, 2));
}
