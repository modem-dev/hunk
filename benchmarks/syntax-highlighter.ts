// Compare Pierre's Shiki WASM and Highlights backends on Hunk's terminal highlight pipeline.
//
// Each backend runs in fresh child processes because Pierre allows one highlighter type per
// process. A child mirrors the highlight worker: Pierre renders HAST, Hunk restores word-diff
// markers and encodes the compact payload the terminal consumes. The parent reports cold start,
// warm throughput, peak RSS, and how often both backends paint a character the same color.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  getHighlighterOptions,
  getSharedHighlighter,
  parseDiffFromFile,
  renderDiffWithHighlighter,
  renderFileWithHighlighter,
  type FileDiffMetadata,
  type HighlighterTypes,
} from "@pierre/diffs";
import { pierreHighlightRenderOptions } from "../packages/hunk/src/core/documents/highlightRenderOptions";
import {
  encodeCompactHighlightedDiff,
  encodeCompactHighlightedDocument,
  type CompactHighlightSide,
  type HighlightedHastLines,
} from "../packages/hunk/src/ui/diff/worker/highlightCompact";
import { markWordDiffHighlightLines } from "../packages/hunk/src/ui/diff/worker/highlightWordDiff";

const BACKENDS = ["shiki-wasm", "highlights"] as const satisfies readonly HighlighterTypes[];
type Backend = (typeof BACKENDS)[number];

const REPO_ROOT = resolve(import.meta.dir, "..");
const THEME = "pierre-dark";
const WARM_RUNS = 5;

interface DocumentFixture {
  id: string;
  language: string;
  path: string;
  text: string;
}

/** Read one repository file as a fixture so results track real Hunk source. */
function repoFixture(id: string, language: string, path: string): DocumentFixture {
  return { id, language, path, text: readFileSync(join(REPO_ROOT, path), "utf8") };
}

/** Build the fixed document corpus: everyday source sizes plus one large concatenated file. */
function documentFixtures(): DocumentFixture[] {
  const largeTsSources = [
    "packages/hunk/src/core/run/config.ts",
    "packages/hunk/src/ui/diff/diffRows.ts",
    "packages/hunk/src/ui/diff/worker/highlightCompact.ts",
    "packages/hunk/src/ui/diff/worker/highlightWorkerClient.ts",
    "packages/hunk/src/core/theme/catalog.ts",
  ];
  const largeTs = Array.from({ length: 4 }, () =>
    largeTsSources.map((path) => readFileSync(join(REPO_ROOT, path), "utf8")).join("\n"),
  ).join("\n");

  return [
    repoFixture("ts-diffRows", "typescript", "packages/hunk/src/ui/diff/diffRows.ts"),
    repoFixture("tsx-ReviewApp", "tsx", "packages/hunk/src/web/app/ReviewApp.tsx"),
    repoFixture("css-styles", "css", "packages/hunk/src/web/styles.css"),
    repoFixture("sh-install", "shellscript", "install.sh"),
    repoFixture("md-changelog", "markdown", "CHANGELOG.md"),
    repoFixture(
      "json-session-wire",
      "json",
      "packages/hunk/src/session/broker/fixtures/session-wire.v23.json",
    ),
    { id: "ts-large", language: "typescript", path: "large.ts", text: largeTs },
  ];
}

/** Edit every seventh line of a real file so the diff has paired changes with word emphasis. */
function diffFixture(): { metadata: FileDiffMetadata; changedLines: number } {
  const path = "packages/hunk/src/core/run/config.ts";
  const before = readFileSync(join(REPO_ROOT, path), "utf8");
  const lines = before.split("\n");
  let changedLines = 0;
  const after = lines
    .map((line, index) => {
      if (index % 7 !== 3 || line.trim().length === 0) return line;
      changedLines += 1;
      return line.replace(/\b(const|let|return|if)\b/, "$1 /* edited */").replace(/;$/, " ;");
    })
    .join("\n");
  const metadata = parseDiffFromFile(
    { name: path, contents: before, cacheKey: "bench:before" },
    { name: path, contents: after, cacheKey: "bench:after" },
    { context: 3 },
    true,
  );
  return { metadata, changedLines };
}

/** Return the median of a small sample list. */
function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * Expand one compact side into per-character colors for parity comparison.
 *
 * Whitespace is skipped because its foreground never reaches the screen.
 */
function characterColors(side: CompactHighlightSide, palette: string[], lines: string[]) {
  const colors: string[] = [];
  for (let line = 0; line + 1 < side.lineOffsets.length; line += 1) {
    const text = lines[line] ?? "";
    for (let run = side.lineOffsets[line]!; run < side.lineOffsets[line + 1]!; run += 1) {
      const color = side.styleIds[run] ? palette[side.styleIds[run]! - 1]!.toLowerCase() : "";
      for (let column = side.starts[run]!; column < side.ends[run]!; column += 1) {
        if (!/\s/u.test(text[column] ?? " ")) colors.push(color);
      }
    }
  }
  return colors;
}

interface ChildResult {
  backend: Backend;
  coldFirstDocumentMs: number;
  documents: Record<string, { chars: number; medianMs: number }>;
  diff: { changedLines: number; medianMs: number; wordDiffRuns: number };
  maxRssMiB: number;
  colorsPath: string;
}

/** Run every workload for one backend inside this process and write colors for parity checks. */
async function runChild(backend: Backend, outDir: string): Promise<ChildResult> {
  const fixtures = documentFixtures();
  const options = pierreHighlightRenderOptions(THEME);
  const languages = [...new Set(fixtures.map((fixture) => fixture.language))];

  /** Prepare the shared highlighter for one language the way the worker does per request. */
  const highlighterFor = (language: string) =>
    getSharedHighlighter({
      ...getHighlighterOptions(language, { theme: THEME }),
      preferredHighlighter: backend,
    });

  /** Highlight one document and encode it, including Hunk's compact projection cost. */
  const renderDocument = async (fixture: DocumentFixture, cacheKey: string) => {
    const highlighter = await highlighterFor(fixture.language);
    const result = renderFileWithHighlighter(
      { name: fixture.path, contents: fixture.text, lang: fixture.language as never, cacheKey },
      highlighter,
      options,
    );
    return encodeCompactHighlightedDocument(result.code as HighlightedHastLines, "dark");
  };

  // Cold start: engine init, grammar or lexer load, theme load, and the first TS render.
  const coldStart = performance.now();
  await renderDocument(fixtures[0]!, "cold");
  const coldFirstDocumentMs = performance.now() - coldStart;

  // Warm every language once so throughput excludes one-time grammar compilation.
  for (const language of languages) await highlighterFor(language);

  const documents: ChildResult["documents"] = {};
  const colors: Record<string, string[]> = {};
  for (const fixture of fixtures) {
    const samples: number[] = [];
    let payload = await renderDocument(fixture, `warmup:${fixture.id}`);
    for (let run = 0; run < WARM_RUNS; run += 1) {
      const start = performance.now();
      // Unique cache keys keep Pierre from returning a memoized render.
      payload = await renderDocument(fixture, `${fixture.id}:${run}`);
      samples.push(performance.now() - start);
    }
    documents[fixture.id] = { chars: fixture.text.length, medianMs: median(samples) };
    colors[fixture.id] = characterColors(
      payload.document,
      payload.foregroundPalette,
      fixture.text.split("\n"),
    );
  }

  const { metadata, changedLines } = diffFixture();
  const diffHighlighter = await highlighterFor("typescript");
  const diffSamples: number[] = [];
  let wordDiffRuns = 0;
  for (let run = 0; run <= WARM_RUNS; run += 1) {
    const start = performance.now();
    const rendered = renderDiffWithHighlighter(
      { ...metadata, cacheKey: `bench-diff:${run}` },
      diffHighlighter,
      options,
    );
    const marked = markWordDiffHighlightLines(
      metadata,
      rendered.code as { deletionLines: HighlightedHastLines; additionLines: HighlightedHastLines },
      THEME,
    );
    const payload = encodeCompactHighlightedDiff(marked, "dark");
    if (run > 0) diffSamples.push(performance.now() - start);
    wordDiffRuns = payload.addition.flags.reduce((total, flag) => total + flag, 0);
    colors["diff-addition"] = characterColors(
      payload.addition,
      payload.foregroundPalette,
      metadata.additionLines,
    );
  }

  const colorsPath = join(outDir, `${backend}.colors.json`);
  writeFileSync(colorsPath, JSON.stringify(colors));

  return {
    backend,
    coldFirstDocumentMs,
    documents,
    diff: { changedLines, medianMs: median(diffSamples), wordDiffRuns },
    // Bun reports maxRSS in KiB on Linux and bytes on macOS; normalize to MiB.
    maxRssMiB:
      process.platform === "darwin"
        ? process.resourceUsage().maxRSS / 1024 / 1024
        : process.resourceUsage().maxRSS / 1024,
    colorsPath,
  };
}

/** Return the share of characters both backends paint with the same foreground. */
function colorAgreement(left: string[], right: string[]) {
  const length = Math.max(left.length, right.length);
  if (length === 0) return 1;
  let same = 0;
  for (let index = 0; index < length; index += 1) {
    if (left[index] === right[index]) same += 1;
  }
  return same / length;
}

/** Spawn fresh child processes per backend, then print medians and parity. */
function runParent() {
  const samples = Number(process.env.HUNK_BENCH_SAMPLES ?? 3);
  const outDir = mkdtempSync(join(tmpdir(), "hunk-syntax-bench-"));
  const results = new Map<Backend, ChildResult[]>();

  try {
    for (let sample = 0; sample < samples; sample += 1) {
      for (const backend of BACKENDS) {
        const child = spawnSync(
          process.execPath,
          [import.meta.path, "--child", backend, "--out", outDir],
          { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        );
        if (child.status !== 0) {
          throw new Error(`${backend} benchmark failed:\n${child.stderr}`);
        }
        const line = child.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
        if (!line) throw new Error(`${backend} benchmark printed no result:\n${child.stdout}`);
        const list = results.get(backend) ?? [];
        list.push(JSON.parse(line.slice("RESULT ".length)) as ChildResult);
        results.set(backend, list);
      }
    }

    const shiki = results.get("shiki-wasm")!;
    const highlights = results.get("highlights")!;
    const row = (label: string, pick: (result: ChildResult) => number, unit: string) => {
      const left = median(shiki.map(pick));
      const right = median(highlights.map(pick));
      const ratio = left / right;
      console.log(
        `${label.padEnd(34)} ${left.toFixed(1).padStart(9)} ${right.toFixed(1).padStart(11)} ${unit.padEnd(4)} ${ratio.toFixed(2).padStart(6)}x`,
      );
      return { left, right };
    };

    console.log(`samples=${samples} (fresh process per backend per sample), theme=${THEME}\n`);
    console.log(
      `${"workload".padEnd(34)} ${"shiki-wasm".padStart(9)} ${"highlights".padStart(11)} unit  speedup`,
    );
    const cold = row("cold first document (ts)", (result) => result.coldFirstDocumentMs, "ms");
    for (const id of Object.keys(shiki[0]!.documents)) {
      const chars = shiki[0]!.documents[id]!.chars;
      row(
        `${id} (${Math.round(chars / 1024)} KiB)`,
        (result) => result.documents[id]!.medianMs,
        "ms",
      );
    }
    const diff = row(
      `diff ${shiki[0]!.diff.changedLines} changed lines`,
      (result) => result.diff.medianMs,
      "ms",
    );
    const rss = row("peak RSS", (result) => result.maxRssMiB, "MiB");

    const leftColors = JSON.parse(readFileSync(shiki.at(-1)!.colorsPath, "utf8")) as Record<
      string,
      string[]
    >;
    const rightColors = JSON.parse(readFileSync(highlights.at(-1)!.colorsPath, "utf8")) as Record<
      string,
      string[]
    >;
    console.log("\ncharacter color agreement (same foreground on both backends):");
    for (const id of Object.keys(leftColors)) {
      const agreement = colorAgreement(leftColors[id]!, rightColors[id]!);
      console.log(`  ${id.padEnd(22)} ${(agreement * 100).toFixed(1)}%`);
      console.log(`METRIC color_agreement_${id.replaceAll("-", "_")}=${agreement.toFixed(4)}`);
    }
    console.log(
      `word-diff runs on additions: shiki-wasm=${shiki[0]!.diff.wordDiffRuns} highlights=${highlights[0]!.diff.wordDiffRuns}`,
    );

    console.log(`\nMETRIC shiki_cold_ms=${cold.left.toFixed(2)}`);
    console.log(`METRIC highlights_cold_ms=${cold.right.toFixed(2)}`);
    console.log(`METRIC shiki_diff_ms=${diff.left.toFixed(2)}`);
    console.log(`METRIC highlights_diff_ms=${diff.right.toFixed(2)}`);
    console.log(`METRIC shiki_peak_rss_mib=${rss.left.toFixed(1)}`);
    console.log(`METRIC highlights_peak_rss_mib=${rss.right.toFixed(1)}`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

const childIndex = process.argv.indexOf("--child");
if (childIndex >= 0) {
  const backend = process.argv[childIndex + 1] as Backend;
  const outDir = process.argv[process.argv.indexOf("--out") + 1]!;
  if (!BACKENDS.includes(backend)) throw new Error(`Unknown backend: ${backend}`);
  console.log(`RESULT ${JSON.stringify(await runChild(backend, outDir))}`);
} else {
  runParent();
}
