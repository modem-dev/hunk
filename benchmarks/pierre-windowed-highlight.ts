/**
 * Measures whole-file versus windowed syntax highlighting for large contiguous diffs.
 *
 * Pierre's `renderDiffWithHighlighter` highlights a file in one uninterruptible call, so a large
 * added file freezes the terminal for as long as that call runs. This benchmark reports the cost of
 * that call next to the cost of rendering the same diff as a sequence of row windows, and checks
 * that the windowed output is byte-identical to the whole-file output.
 *
 * Windowed highlighting needs the change in `patches/@pierre%2Fdiffs@1.2.2.patch`; see
 * `docs/pierre-chunked-highlighting.md`. Without that patch the benchmark still runs and reports
 * the whole-file cost, plus the fact that windowing was ignored.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  getHighlighterOptions,
  getSharedHighlighter,
  parseDiffFromFile,
  parsePatchFiles,
  renderDiffWithHighlighter,
  type FileDiffMetadata,
} from "@pierre/diffs";

const WINDOW_SIZES = [250, 500, 1000];
const SAMPLE_ROOTS = ["src/ui/diff", "src/ui/components", "src/core/review"];
const SAMPLE_COUNT = 4;
const SYNTHETIC_LINES = 8_000;

const renderOptions = {
  theme: "pierre-dark" as const,
  useTokenTransformer: false,
  tokenizeMaxLineLength: 1_000,
  lineDiffType: "word-alt" as const,
  maxLineDiffLength: 10_000,
};

interface WindowedResult {
  code: { deletionLines: unknown[]; additionLines: unknown[] };
  worst: number;
  total: number;
  windows: number;
}

/** Collect the largest TypeScript sources in the repo so the benchmark uses real code. */
function collectSamples() {
  const files: Array<{ path: string; text: string; lines: number }> = [];

  for (const root of SAMPLE_ROOTS) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(root, entry);
      if (!statSync(path).isFile()) continue;
      if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) continue;
      const text = readFileSync(path, "utf8");
      files.push({ path, text, lines: text.split("\n").length });
    }
  }

  const largest = files.sort((a, b) => b.lines - a.lines).slice(0, SAMPLE_COUNT);
  // Repo sources top out around 2.5k lines; a generated file covers the size where the whole-file
  // call stops being a stutter and starts being a visible freeze.
  const generated = syntheticSource(SYNTHETIC_LINES);
  // The name drives Pierre's language detection, so it has to stay a plausible source path.
  return [{ path: "synthetic-generated.ts", text: generated, lines: SYNTHETIC_LINES }, ...largest];
}

/** Generate TypeScript whose comments and template literals span many lines. */
function syntheticSource(lines: number, seed = 0) {
  const out: string[] = [];
  let index = seed;

  while (out.length < lines) {
    out.push(`/** Handler ${index}`);
    out.push(` * continues across lines`);
    out.push(` */`);
    out.push(`export function handler${index}(input: { id: string; count: number }): string {`);
    out.push(`  const label = \`item-\${input.id}`);
    out.push(`    -\${input.count}\`;`);
    out.push(`  if (input.count > ${index % 97}) {`);
    out.push(`    return label.toUpperCase();`);
    out.push(`  }`);
    out.push(`  return label;`);
    out.push(`}`);
    out.push("");
    index += 1;
  }

  return out.slice(0, lines).join("\n") + "\n";
}

/** Render one diff as a sequence of row windows, threading grammar state between them. */
function renderWindowed(
  metadata: FileDiffMetadata,
  highlighter: Awaited<ReturnType<typeof getSharedHighlighter>>,
  windowSize: number,
): WindowedResult {
  const code = { deletionLines: [] as unknown[], additionLines: [] as unknown[] };
  const rows = Math.max(metadata.unifiedLineCount, metadata.splitLineCount);
  // A partial diff's emitted lines are not contiguous in the real file, so its windows start cold.
  const chainState = !metadata.isPartial;
  let grammarState: unknown;
  let worst = 0;
  let total = 0;
  let windows = 0;

  for (let start = 0; start < rows; start += windowSize) {
    const started = performance.now();
    const chunk = renderDiffWithHighlighter(metadata, highlighter, renderOptions, {
      forcePlainText: false,
      windowedHighlight: true,
      startingLine: start,
      totalLines: windowSize,
      expandedHunks: true,
      grammarState: chainState ? grammarState : undefined,
    } as never) as ReturnType<typeof renderDiffWithHighlighter> & { grammarState?: unknown };
    const elapsed = performance.now() - started;

    total += elapsed;
    worst = Math.max(worst, elapsed);
    windows += 1;
    grammarState = chunk.grammarState;

    for (let index = 0; index < chunk.code.deletionLines.length; index += 1) {
      const node = chunk.code.deletionLines[index];
      if (node != null) code.deletionLines[index] = node;
    }
    for (let index = 0; index < chunk.code.additionLines.length; index += 1) {
      const node = chunk.code.additionLines[index];
      if (node != null) code.additionLines[index] = node;
    }
  }

  return { code, worst, total, windows };
}

/** Report whether the installed Pierre honors a highlighted window at all. */
function detectWindowSupport(
  metadata: FileDiffMetadata,
  highlighter: Awaited<ReturnType<typeof getSharedHighlighter>>,
) {
  const windowed = renderDiffWithHighlighter(metadata, highlighter, renderOptions, {
    forcePlainText: false,
    windowedHighlight: true,
    startingLine: 0,
    totalLines: 10,
    expandedHunks: true,
  } as never);
  const rendered = windowed.code.additionLines.filter((node) => node != null).length;
  return rendered > 0 && rendered <= 10;
}

const options = getHighlighterOptions("typescript", { theme: "pierre-dark" });
const highlighter = await getSharedHighlighter({
  themes: options.themes,
  langs: [...options.langs, "tsx"],
  preferredHighlighter: "shiki-wasm",
});
const samples = collectSamples();

if (samples.length === 0) {
  console.error("no sample sources found; run from the repo root");
  process.exit(1);
}

const probeMetadata = parseDiffFromFile(
  { name: "probe.ts", contents: "", cacheKey: "probe-old" },
  { name: "probe.ts", contents: samples[0]!.text, cacheKey: "probe-new" },
);
const windowSupported = detectWindowSupport(probeMetadata, highlighter);

console.log(
  windowSupported
    ? "windowed highlighting: supported by the installed @pierre/diffs\n"
    : "windowed highlighting: NOT supported by the installed @pierre/diffs " +
        "(apply patches/@pierre%2Fdiffs@1.2.2.patch to measure it)\n",
);

for (const sample of samples) {
  // A newly added file is the worst case: one contiguous run of added lines, no context to skip.
  const metadata = parseDiffFromFile(
    { name: sample.path, contents: "", cacheKey: `${sample.path}-old` },
    { name: sample.path, contents: sample.text, cacheKey: `${sample.path}-new` },
  );

  // Shiki lazily resolves grammars and themes on first use, so an unwarmed first call charges that
  // one-time cost to whichever path runs first. Warm both paths before timing either.
  renderDiffWithHighlighter(metadata, highlighter, renderOptions);
  if (windowSupported) {
    renderWindowed(metadata, highlighter, WINDOW_SIZES[0]!);
  }

  const started = performance.now();
  const baseline = renderDiffWithHighlighter(metadata, highlighter, renderOptions);
  const baselineMs = performance.now() - started;

  console.log(`${sample.path} (${sample.lines} lines added)`);
  console.log(`  whole file : ${baselineMs.toFixed(1)}ms in one uninterruptible call`);

  if (!windowSupported) {
    console.log("");
    continue;
  }

  for (const windowSize of WINDOW_SIZES) {
    const windowed = renderWindowed(metadata, highlighter, windowSize);
    const identical =
      JSON.stringify(baseline.code.additionLines) === JSON.stringify(windowed.code.additionLines) &&
      JSON.stringify(baseline.code.deletionLines) === JSON.stringify(windowed.code.deletionLines);

    console.log(
      `  window ${String(windowSize).padStart(4)}: ${windowed.total.toFixed(1)}ms across ` +
        `${windowed.windows} windows, longest ${windowed.worst.toFixed(1)}ms, ` +
        `identical=${identical}`,
    );
  }

  console.log("");
}

// Correctness sweep. The timings above only cover added TypeScript files, but the claim that
// windowed output is byte-identical needs to hold across languages whose multi-line constructs
// differ, across diff shapes, and across window sizes that land mid-construct.
if (windowSupported) {
  const SWEEP_LANGUAGES = ["typescript", "python", "css"] as const;
  const SWEEP_WINDOWS = [64, 250, 1000];

  const sweepHighlighter = await getSharedHighlighter({
    themes: options.themes,
    langs: [...options.langs, ...SWEEP_LANGUAGES],
    preferredHighlighter: "shiki-wasm",
  });

  /** Python with triple-quoted strings that straddle window boundaries. */
  const pythonSource = (lines: number, seed: number) => {
    const out: string[] = [];
    let index = seed;
    while (out.length < lines) {
      out.push(`def handler_${index}(value):`);
      out.push(`    """Docstring for ${index}`);
      out.push(`    continues past the opening line`);
      out.push(`    """`);
      out.push(`    return value + ${index % 13}`);
      out.push("");
      index += 1;
    }
    return out.slice(0, lines).join("\n") + "\n";
  };

  /** CSS with block comments spanning lines. */
  const cssSource = (lines: number, seed: number) => {
    const out: string[] = [];
    let index = seed;
    while (out.length < lines) {
      out.push(`/* rule ${index}`);
      out.push(`   keeps going */`);
      out.push(`.cls-${index} {`);
      out.push(`  color: #${(index % 999).toString(16).padStart(3, "0")};`);
      out.push(`}`);
      out.push("");
      index += 1;
    }
    return out.slice(0, lines).join("\n") + "\n";
  };

  const generators = {
    typescript: { make: (lines: number, seed: number) => syntheticSource(lines, seed), ext: "ts" },
    python: { make: pythonSource, ext: "py" },
    css: { make: cssSource, ext: "css" },
  } as const;

  console.log("correctness sweep (windowed output vs whole-file render)\n");
  let mismatches = 0;

  for (const language of SWEEP_LANGUAGES) {
    const { make, ext } = generators[language];
    const shapes: Array<[string, string, string]> = [
      ["new file", "", make(900, 0)],
      ["deleted file", make(900, 0), ""],
      ["full rewrite", make(700, 0), make(700, 400)],
      ["scattered edits", make(900, 0), make(900, 0).replace(/9/g, "8")],
      ["no trailing newline", make(300, 0), make(300, 5).trimEnd()],
    ];

    for (const [shape, oldText, newText] of shapes) {
      const metadata = parseDiffFromFile(
        { name: `sweep.${ext}`, contents: oldText, cacheKey: `${language}-${shape}-old` },
        { name: `sweep.${ext}`, contents: newText, cacheKey: `${language}-${shape}-new` },
      );
      const whole = renderDiffWithHighlighter(metadata, sweepHighlighter, renderOptions);
      const results = SWEEP_WINDOWS.map((windowSize) => {
        const windowed = renderWindowed(metadata, sweepHighlighter, windowSize);
        const identical =
          JSON.stringify(whole.code.additionLines) ===
            JSON.stringify(windowed.code.additionLines) &&
          JSON.stringify(whole.code.deletionLines) === JSON.stringify(windowed.code.deletionLines);
        if (!identical) mismatches += 1;
        return `w=${windowSize} ${identical ? "ok" : "MISMATCH"}`;
      });

      console.log(`  ${`${language} / ${shape}`.padEnd(34)} ${results.join("  ")}`);
    }
  }

  // A patch-only diff is not contiguous in the real file, so its windows must start cold. Pierre
  // already buckets these per hunk; renderWindowed skips chaining when metadata.isPartial.
  const partialPatch = `diff --git a/sweep.ts b/sweep.ts
--- a/sweep.ts
+++ b/sweep.ts
@@ -10,4 +10,4 @@ context
 const a = 1;
 const b = 2;
-const c = 3;
+const c = 33;
 const d = 4;
@@ -40,4 +40,4 @@ context
 const e = 5;
 const f = 6;
-const g = 7;
+const g = 77;
 const h = 8;
`;
  const parsedPartial = parsePatchFiles(partialPatch, "sweep", true)[0]?.files[0];
  if (parsedPartial) {
    const whole = renderDiffWithHighlighter(parsedPartial, sweepHighlighter, renderOptions);
    const results = SWEEP_WINDOWS.map((windowSize) => {
      const windowed = renderWindowed(parsedPartial, sweepHighlighter, windowSize);
      const identical =
        JSON.stringify(whole.code.additionLines) === JSON.stringify(windowed.code.additionLines) &&
        JSON.stringify(whole.code.deletionLines) === JSON.stringify(windowed.code.deletionLines);
      if (!identical) mismatches += 1;
      return `w=${windowSize} ${identical ? "ok" : "MISMATCH"}`;
    });
    console.log(`  ${"typescript / partial patch".padEnd(34)} ${results.join("  ")}`);
  }

  console.log(
    `\n${mismatches === 0 ? "sweep: all cases identical" : `sweep: ${mismatches} MISMATCHES`}`,
  );
}
