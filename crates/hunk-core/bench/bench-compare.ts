// Head-to-head: tuned TS vs the Rust core, on a real changeset.
import { readFileSync } from "node:fs";
import { measureSanitizedTextWidth } from "/home/user/hunk/src/ui/lib/text.ts";
import {
  measureWidth,
  measureWidths,
  intralineSpansBatch,
} from "/home/user/hunk/crates/hunk-core/index.ts";

const patch = readFileSync(process.argv[2] ?? "big.patch", "utf8");
const all = patch.split("\n");
const lines = all
  .filter((l) => l.startsWith("+") || l.startsWith("-") || l.startsWith(" "))
  .map((l) => l.slice(1));

// Adjacent -/+ runs are the line pairs a word-level intraline diff actually runs on.
const before: string[] = [];
const after: string[] = [];
for (let i = 0; i < all.length - 1; i++) {
  if (all[i]!.startsWith("-") && all[i + 1]!.startsWith("+")) {
    before.push(all[i]!.slice(1));
    after.push(all[i + 1]!.slice(1));
  }
}

function bench(name: string, iterations: number, fn: () => number) {
  fn();
  const start = performance.now();
  let sink = 0;
  for (let i = 0; i < iterations; i++) sink += fn();
  const ms = (performance.now() - start) / iterations;
  console.log(`${name.padEnd(38)} ${ms.toFixed(2).padStart(9)} ms   (sink=${sink % 7})`);
  return ms;
}

console.log(`corpus: ${lines.length} diff lines, ${before.length} changed line pairs\n`);
console.log("── width measurement ──────────────────────────────────────");

const tsWidth = bench("TS  measureSanitizedTextWidth", 20, () => {
  let total = 0;
  for (const line of lines) total += measureSanitizedTextWidth(line);
  return total;
});

const rsBatch = bench("RS  measureWidths (one FFI call)", 20, () => {
  const widths = measureWidths(lines);
  let total = 0;
  for (const w of widths) total += w;
  return total;
});

const rsPerCall = bench("RS  measureWidth (one FFI call/line)", 5, () => {
  let total = 0;
  for (const line of lines) total += measureWidth(line);
  return total;
});

console.log(`\n  batch speedup    ${(tsWidth / rsBatch).toFixed(2)}x`);
console.log(`  per-call speedup ${(tsWidth / rsPerCall).toFixed(2)}x  <- FFI overhead per row`);
console.log(
  `  ns/line          TS ${((tsWidth * 1e6) / lines.length).toFixed(0)}  ` +
    `RS-batch ${((rsBatch * 1e6) / lines.length).toFixed(0)}  ` +
    `RS-percall ${((rsPerCall * 1e6) / lines.length).toFixed(0)}`,
);

console.log("\n── intraline word diff ────────────────────────────────────");

const rsIntraline = bench("RS  intralineSpansBatch (histogram)", 10, () => {
  const spans = intralineSpansBatch(before, after);
  let total = 0;
  for (const s of spans) total += s.length;
  return total;
});
console.log(
  `  ns/pair          RS ${((rsIntraline * 1e6) / Math.max(1, before.length)).toFixed(0)}`,
);

// Pierre computes word-level spans inside the same pass as syntax highlighting, so the
// comparable TS number is the whole pass; report it as the pipeline this would carve into.
console.log("\n── context: full Pierre highlight pass ────────────────────");
try {
  const {
    parsePatchFiles,
    getSharedHighlighter,
    getHighlighterOptions,
    renderDiffWithHighlighter,
  } = await import("@pierre/diffs");
  const files = parsePatchFiles(patch).slice(0, 40);
  const options = getHighlighterOptions({
    themes: ["github-dark"],
    langs: ["typescript"],
  } as never);
  const highlighter = await getSharedHighlighter(options);
  const renderOptions = {
    theme: "github-dark",
    useTokenTransformer: false,
    tokenizeMaxLineLength: 1_000,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: 10_000,
  };

  const ms = bench(`TS  renderDiffWithHighlighter (${files.length} files)`, 3, () => {
    let total = 0;
    for (const file of files) {
      const out = renderDiffWithHighlighter(file as never, highlighter, renderOptions as never);
      total += out.code.additionLines.length;
    }
    return total;
  });
  console.log(`  highlight + word-diff for ${files.length} files: ${ms.toFixed(1)} ms`);
} catch (error) {
  console.log(`  (skipped: ${(error as Error).message.split("\n")[0]})`);
}
